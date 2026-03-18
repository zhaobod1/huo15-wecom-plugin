import type { WeComMediaType, WsFrameHeaders, WSClient } from "@wecom/aibot-node-sdk";
import { detectMime, loadOutboundMediaFromUrl } from "openclaw/plugin-sdk";

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const VIDEO_MAX_BYTES = 10 * 1024 * 1024;
const VOICE_MAX_BYTES = 2 * 1024 * 1024;
const FILE_MAX_BYTES = 20 * 1024 * 1024;

type FileSizeCheckResult = {
  finalType: WeComMediaType;
  shouldReject: boolean;
  rejectReason?: string;
  downgraded: boolean;
  downgradeNote?: string;
};

export type BotWsMediaSendResult = {
  ok: boolean;
  messageId?: string;
  finalType?: WeComMediaType;
  rejected?: boolean;
  rejectReason?: string;
  downgraded?: boolean;
  downgradeNote?: string;
  error?: string;
};

type ResolvedMediaFile = {
  buffer: Buffer;
  contentType: string;
  fileName: string;
};

const VOICE_SUPPORTED_MIMES = new Set(["audio/amr"]);

function detectWeComMediaType(mimeType: string): WeComMediaType {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/") || mime === "application/ogg") return "voice";
  return "file";
}

function mimeToExtension(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/svg+xml": ".svg",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/x-msvideo": ".avi",
    "video/webm": ".webm",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/amr": ".amr",
    "audio/aac": ".aac",
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "text/plain": ".txt",
  };
  return map[mime] || ".bin";
}

function extractFileName(
  mediaUrl: string,
  providedFileName?: string,
  contentType?: string,
): string {
  if (providedFileName) return providedFileName;
  try {
    const url = new URL(mediaUrl, "file://");
    const lastPart = url.pathname.split("/").filter(Boolean).pop();
    if (lastPart && lastPart.includes(".")) {
      return decodeURIComponent(lastPart);
    }
  } catch {
    const lastPart = mediaUrl.split("/").filter(Boolean).pop();
    if (lastPart && lastPart.includes(".")) {
      return lastPart;
    }
  }
  return `media_${Date.now()}${mimeToExtension(contentType || "application/octet-stream")}`;
}

function applyFileSizeLimits(
  fileSize: number,
  detectedType: WeComMediaType,
  contentType?: string,
): FileSizeCheckResult {
  const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);
  if (fileSize > FILE_MAX_BYTES) {
    return {
      finalType: detectedType,
      shouldReject: true,
      rejectReason: `文件大小 ${fileSizeMB}MB 超过了企业微信允许的最大限制 20MB，无法发送。`,
      downgraded: false,
    };
  }

  switch (detectedType) {
    case "image":
      if (fileSize > IMAGE_MAX_BYTES) {
        return {
          finalType: "file",
          shouldReject: false,
          downgraded: true,
          downgradeNote: `图片大小 ${fileSizeMB}MB 超过 10MB 限制，已转为文件格式发送`,
        };
      }
      break;
    case "video":
      if (fileSize > VIDEO_MAX_BYTES) {
        return {
          finalType: "file",
          shouldReject: false,
          downgraded: true,
          downgradeNote: `视频大小 ${fileSizeMB}MB 超过 10MB 限制，已转为文件格式发送`,
        };
      }
      break;
    case "voice":
      if (contentType && !VOICE_SUPPORTED_MIMES.has(contentType.toLowerCase())) {
        return {
          finalType: "file",
          shouldReject: false,
          downgraded: true,
          downgradeNote: `语音格式 ${contentType} 不支持，企微仅支持 AMR 格式，已转为文件格式发送`,
        };
      }
      if (fileSize > VOICE_MAX_BYTES) {
        return {
          finalType: "file",
          shouldReject: false,
          downgraded: true,
          downgradeNote: `语音大小 ${fileSizeMB}MB 超过 2MB 限制，已转为文件格式发送`,
        };
      }
      break;
    default:
      break;
  }

  return {
    finalType: detectedType,
    shouldReject: false,
    downgraded: false,
  };
}

async function resolveMediaFile(
  mediaUrl: string,
  mediaLocalRoots?: readonly string[],
): Promise<ResolvedMediaFile> {
  const result = await loadOutboundMediaFromUrl(mediaUrl, {
    maxBytes: FILE_MAX_BYTES,
    mediaLocalRoots,
  });
  let contentType = result.contentType || "application/octet-stream";
  if (contentType === "application/octet-stream" || contentType === "text/plain") {
    const detected = await detectMime({
      buffer: result.buffer,
      filePath: result.fileName ?? mediaUrl,
    });
    if (detected) {
      contentType = detected;
    }
  }
  return {
    buffer: result.buffer,
    contentType,
    fileName: extractFileName(mediaUrl, result.fileName, contentType),
  };
}

export async function uploadAndSendBotWsMedia(params: {
  wsClient: WSClient;
  mediaUrl: string;
  chatId: string;
  mediaLocalRoots?: readonly string[];
}): Promise<BotWsMediaSendResult> {
  try {
    const media = await resolveMediaFile(params.mediaUrl, params.mediaLocalRoots);
    const detectedType = detectWeComMediaType(media.contentType);
    const sizeCheck = applyFileSizeLimits(media.buffer.length, detectedType, media.contentType);
    if (sizeCheck.shouldReject) {
      return {
        ok: false,
        rejected: true,
        rejectReason: sizeCheck.rejectReason,
        finalType: sizeCheck.finalType,
      };
    }

    const uploadResult = await params.wsClient.uploadMedia(media.buffer, {
      type: sizeCheck.finalType,
      filename: media.fileName,
    });
    const sendResult = await params.wsClient.sendMediaMessage(
      params.chatId,
      sizeCheck.finalType,
      uploadResult.media_id,
    );

    return {
      ok: true,
      messageId: sendResult?.headers?.req_id ?? `wecom-media-${Date.now()}`,
      finalType: sizeCheck.finalType,
      downgraded: sizeCheck.downgraded,
      downgradeNote: sizeCheck.downgradeNote,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function uploadAndReplyBotWsMedia(params: {
  wsClient: WSClient;
  frame: WsFrameHeaders;
  mediaUrl: string;
  mediaLocalRoots?: readonly string[];
}): Promise<BotWsMediaSendResult> {
  try {
    const media = await resolveMediaFile(params.mediaUrl, params.mediaLocalRoots);
    const detectedType = detectWeComMediaType(media.contentType);
    const sizeCheck = applyFileSizeLimits(media.buffer.length, detectedType, media.contentType);
    if (sizeCheck.shouldReject) {
      return {
        ok: false,
        rejected: true,
        rejectReason: sizeCheck.rejectReason,
        finalType: sizeCheck.finalType,
      };
    }

    const uploadResult = await params.wsClient.uploadMedia(media.buffer, {
      type: sizeCheck.finalType,
      filename: media.fileName,
    });
    const replyResult = await params.wsClient.replyMedia(
      params.frame,
      sizeCheck.finalType,
      uploadResult.media_id,
    );

    return {
      ok: true,
      messageId: replyResult?.headers?.req_id ?? `wecom-reply-media-${Date.now()}`,
      finalType: sizeCheck.finalType,
      downgraded: sizeCheck.downgraded,
      downgradeNote: sizeCheck.downgradeNote,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
