import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WeComMediaType, WsFrameHeaders, WSClient } from "@wecom/aibot-node-sdk";
import {
  assertLocalMediaAllowed,
  detectMime,
  fetchRemoteMedia,
} from "openclaw/plugin-sdk/media-runtime";
import {
  formatShareFallbackText,
  shareFallback,
  type ShareFallbackConfig,
} from "../../share-fallback.js";

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
  /** v2.8.15: 通过 enhance bot-share 兜底发的下载链接 URL（ok=true 时附带，便于上层日志/审计） */
  shareUrl?: string;
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

function resolveLocalMediaPath(mediaUrl: string): string {
  if (mediaUrl.startsWith("file://")) {
    return fileURLToPath(mediaUrl);
  }
  if (mediaUrl.startsWith("~")) {
    return path.join(os.homedir(), mediaUrl.slice(1));
  }
  return mediaUrl;
}

async function loadOutboundMediaFile(params: {
  mediaUrl: string;
  mediaLocalRoots?: readonly string[];
  maxBytes: number;
}): Promise<{
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
}> {
  if (/^https?:\/\//i.test(params.mediaUrl)) {
    return await fetchRemoteMedia({
      url: params.mediaUrl,
      maxBytes: params.maxBytes,
      filePathHint: params.mediaUrl,
    });
  }

  const mediaPath = resolveLocalMediaPath(params.mediaUrl);
  await assertLocalMediaAllowed(mediaPath, params.mediaLocalRoots);
  const buffer = await readFile(mediaPath);
  if (buffer.length > params.maxBytes) {
    throw new Error(
      `Media size ${(buffer.length / (1024 * 1024)).toFixed(2)}MB exceeds max ${(
        params.maxBytes /
        (1024 * 1024)
      ).toFixed(2)}MB`,
    );
  }
  return {
    buffer,
    fileName: path.basename(mediaPath),
  };
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
  maxBytes?: number,
): Promise<ResolvedMediaFile> {
  const result = await loadOutboundMediaFile({
    mediaUrl,
    maxBytes: maxBytes ?? FILE_MAX_BYTES,
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

/**
 * v2.8.15: 大文件上传被拒时尝试 enhance bot-share 兜底。
 * 把 buffer 写到 ~/.openclaw/share/files/<token>-<basename> + manifest，
 * 由 @huo15/openclaw-enhance v5.7.22+ 注册的 /plugins/enhance-share/* HTTP route 提供下载。
 *
 * 行为：
 *   1. 写盘成功（fallback.ok=true）→ 视情况主动 sendMessage 把链接 markdown 推到目标 chatId
 *      （能拿到 chatId 的路径：sendMedia 直推 / reply 路径用 body.from.userid 兜底）
 *   2. 主动发送成功 → 返回 ok:true + 短 downgradeNote（"已通过分享链接发送"），让 reply 路径的
 *      finalText 拼接也能看到
 *   3. 主动发送失败 / 拿不到目标 → 把整段 markdown 文本塞进 downgradeNote 让 reply.ts 在最终消息里输出
 *   4. 写盘失败 → 保留原 reject 行为
 */
async function trySendShareFallbackOnReject(params: {
  wsClient: WSClient;
  chatId?: string;
  frame?: WsFrameHeaders;
  buffer: Buffer;
  fileName: string;
  rejectReason: string;
  finalType: WeComMediaType;
  shareConfig?: ShareFallbackConfig;
}): Promise<BotWsMediaSendResult> {
  const fallback = shareFallback({
    buffer: params.buffer,
    fileName: params.fileName,
    label: params.fileName,
    config: params.shareConfig,
  });
  if (!fallback.ok) {
    return {
      ok: false,
      rejected: true,
      rejectReason: `${params.rejectReason}（share 兜底也失败：${fallback.error}）`,
      finalType: params.finalType,
    };
  }

  const fullText = formatShareFallbackText({
    fileName: params.fileName,
    fileSizeBytes: params.buffer.length,
    result: fallback,
  });

  let targetChatId: string | undefined = params.chatId;
  if (!targetChatId && params.frame) {
    const body = (params.frame as { body?: { chattype?: string; chatid?: string; from?: { userid?: string } } }).body;
    if (body) {
      targetChatId =
        body.chattype === "group"
          ? body.chatid || body.from?.userid
          : body.from?.userid;
    }
  }

  const sizeMB = (params.buffer.length / 1024 / 1024).toFixed(1);
  const shortNote = `📎 大文件已通过分享链接发送（${sizeMB}MB → ${fallback.url}，${
    fallback.baseUrlIsFallback ? "⚠ baseUrl=localhost，请配 BOT_BASE_URL 公网地址" : "24h 后过期"
  }）`;

  if (targetChatId) {
    try {
      const messagePayload = {
        msgtype: "markdown_v2",
        markdown_v2: { content: fullText },
      } as unknown as Parameters<typeof params.wsClient.sendMessage>[1];
      await params.wsClient.sendMessage(targetChatId, messagePayload);
      return {
        ok: true,
        messageId: `wecom-share-fallback-${Date.now()}`,
        finalType: params.finalType,
        downgraded: true,
        downgradeNote: shortNote,
        shareUrl: fallback.url,
      };
    } catch (sendErr) {
      // sendMessage 失败但 share 已落盘 → 把完整 URL 塞进 downgradeNote，由 reply.ts 拼到最终回复
      return {
        ok: true,
        messageId: `wecom-share-fallback-${Date.now()}`,
        finalType: params.finalType,
        downgraded: true,
        downgradeNote: `${fullText}\n\n（自动 sendMessage 失败：${(sendErr as Error).message}）`,
        shareUrl: fallback.url,
      };
    }
  }

  // 拿不到 chatId（既没传 chatId 也没在 frame.body 里找到 userid）→ 把完整文本通过 downgradeNote 透传
  return {
    ok: true,
    messageId: `wecom-share-fallback-${Date.now()}`,
    finalType: params.finalType,
    downgraded: true,
    downgradeNote: fullText,
    shareUrl: fallback.url,
  };
}

export async function uploadAndSendBotWsMedia(params: {
  wsClient: WSClient;
  mediaUrl: string;
  chatId: string;
  mediaLocalRoots?: readonly string[];
  maxBytes?: number;
  shareFallbackConfig?: ShareFallbackConfig;
}): Promise<BotWsMediaSendResult> {
  try {
    const media = await resolveMediaFile(params.mediaUrl, params.mediaLocalRoots, params.maxBytes);
    const detectedType = detectWeComMediaType(media.contentType);
    const sizeCheck = applyFileSizeLimits(media.buffer.length, detectedType, media.contentType);
    if (sizeCheck.shouldReject) {
      return await trySendShareFallbackOnReject({
        wsClient: params.wsClient,
        chatId: params.chatId,
        buffer: media.buffer,
        fileName: media.fileName,
        rejectReason: sizeCheck.rejectReason ?? "wecom 大小限制",
        finalType: sizeCheck.finalType,
        shareConfig: params.shareFallbackConfig,
      });
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
  maxBytes?: number;
  shareFallbackConfig?: ShareFallbackConfig;
}): Promise<BotWsMediaSendResult> {
  try {
    const media = await resolveMediaFile(params.mediaUrl, params.mediaLocalRoots, params.maxBytes);
    const detectedType = detectWeComMediaType(media.contentType);
    const sizeCheck = applyFileSizeLimits(media.buffer.length, detectedType, media.contentType);
    if (sizeCheck.shouldReject) {
      return await trySendShareFallbackOnReject({
        wsClient: params.wsClient,
        frame: params.frame,
        buffer: media.buffer,
        fileName: media.fileName,
        rejectReason: sizeCheck.rejectReason ?? "wecom 大小限制",
        finalType: sizeCheck.finalType,
        shareConfig: params.shareFallbackConfig,
      });
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
