import { decryptWecomMediaWithMeta } from "../../media.js";
import { resolveWecomEgressProxyUrl, resolveWecomMediaMaxBytes } from "../../config/index.js";
import type { WecomBotInboundMessage as WecomInboundMessage } from "../../types/index.js";
import type { WecomWebhookTarget } from "../../types/runtime-context.js";
import { buildInboundBody } from "./message-shape.js";

const MIME_BY_EXT: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  html: "text/html",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ogg: "audio/ogg",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  zip: "application/zip",
  bin: "application/octet-stream",
};

const EXT_BY_MIME: Record<string, string> = {
  ...Object.fromEntries(Object.entries(MIME_BY_EXT).map(([ext, mime]) => [mime, ext])),
  "application/octet-stream": "bin",
};

const GENERIC_CONTENT_TYPES = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  "application/download",
]);

export type BotInboundMedia = {
  buffer: Buffer;
  contentType: string;
  filename: string;
};

export type BotInboundNormalizationResult = {
  body: string;
  media?: BotInboundMedia;
};

function normalizeContentType(raw?: string | null): string | undefined {
  const normalized = String(raw ?? "").trim().split(";")[0]?.trim().toLowerCase();
  return normalized || undefined;
}

function isGenericContentType(raw?: string | null): boolean {
  const normalized = normalizeContentType(raw);
  if (!normalized) return true;
  return GENERIC_CONTENT_TYPES.has(normalized);
}

export function guessContentTypeFromPath(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (!ext) return undefined;
  return MIME_BY_EXT[ext];
}

function guessExtensionFromContentType(contentType?: string): string | undefined {
  const normalized = normalizeContentType(contentType);
  if (!normalized) return undefined;
  if (normalized === "image/jpeg") return "jpg";
  return EXT_BY_MIME[normalized];
}

function extractFileNameFromUrl(rawUrl?: string): string | undefined {
  const s = String(rawUrl ?? "").trim();
  if (!s) return undefined;
  try {
    const u = new URL(s);
    const name = decodeURIComponent(u.pathname.split("/").pop() ?? "").trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}

function sanitizeInboundFilename(raw?: string): string | undefined {
  const s = String(raw ?? "").trim();
  if (!s) return undefined;
  const base = s.split(/[\\/]/).pop()?.trim() ?? "";
  if (!base) return undefined;
  const sanitized = base.replace(/[\u0000-\u001f<>:"|?*]/g, "_").trim();
  return sanitized || undefined;
}

function hasLikelyExtension(name?: string): boolean {
  if (!name) return false;
  return /\.[a-z0-9]{1,16}$/i.test(name);
}

function detectMimeFromBuffer(buffer: Buffer): string | undefined {
  if (!buffer || buffer.length < 4) return undefined;
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") {
    return "image/gif";
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return "image/bmp";
  }
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }
  if (buffer.subarray(0, 4).toString("ascii") === "OggS") {
    return "audio/ogg";
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WAVE") {
    return "audio/wav";
  }
  if (buffer.subarray(0, 3).toString("ascii") === "ID3" || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) {
    return "audio/mpeg";
  }
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    return "video/mp4";
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0xd0 &&
    buffer[1] === 0xcf &&
    buffer[2] === 0x11 &&
    buffer[3] === 0xe0 &&
    buffer[4] === 0xa1 &&
    buffer[5] === 0xb1 &&
    buffer[6] === 0x1a &&
    buffer[7] === 0xe1
  ) {
    return "application/msword";
  }
  const zipMagic =
    (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) ||
    (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x05 && buffer[3] === 0x06) ||
    (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x07 && buffer[3] === 0x08);
  if (zipMagic) {
    const probe = buffer.subarray(0, Math.min(buffer.length, 512 * 1024));
    if (probe.includes(Buffer.from("word/"))) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (probe.includes(Buffer.from("xl/"))) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    if (probe.includes(Buffer.from("ppt/"))) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    return "application/zip";
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let printable = 0;
  for (const b of sample) {
    if (b === 0x00) return undefined;
    if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e)) {
      printable += 1;
    }
  }
  if (sample.length > 0 && printable / sample.length > 0.95) {
    return "text/plain";
  }
  return undefined;
}

function resolveInlineFileName(input: unknown): string | undefined {
  return sanitizeInboundFilename(String(input ?? "").trim());
}

function pickBotFileName(msg: WecomInboundMessage, item?: Record<string, any>): string | undefined {
  const fromItem = item
    ? resolveInlineFileName(item?.filename ?? item?.file_name ?? item?.fileName ?? item?.name ?? item?.title)
    : undefined;
  if (fromItem) return fromItem;
  return resolveInlineFileName(
    (msg as any)?.file?.filename ??
      (msg as any)?.file?.file_name ??
      (msg as any)?.file?.fileName ??
      (msg as any)?.file?.name ??
      (msg as any)?.file?.title ??
      (msg as any)?.filename ??
      (msg as any)?.fileName ??
      (msg as any)?.FileName,
  );
}

function inferInboundMediaMeta(params: {
  kind: "image" | "file";
  buffer: Buffer;
  sourceUrl?: string;
  sourceContentType?: string;
  sourceFilename?: string;
  explicitFilename?: string;
}): { contentType: string; filename: string } {
  const headerType = normalizeContentType(params.sourceContentType);
  const magicType = detectMimeFromBuffer(params.buffer);
  const rawUrlName = sanitizeInboundFilename(extractFileNameFromUrl(params.sourceUrl));
  const guessedByUrl = hasLikelyExtension(rawUrlName) ? rawUrlName : undefined;
  const explicitName = sanitizeInboundFilename(params.explicitFilename);
  const sourceName = sanitizeInboundFilename(params.sourceFilename);
  const chosenName = explicitName || sourceName || guessedByUrl;
  const typeByName = chosenName ? guessContentTypeFromPath(chosenName) : undefined;

  let contentType: string;
  if (params.kind === "image") {
    if (magicType?.startsWith("image/")) contentType = magicType;
    else if (headerType?.startsWith("image/")) contentType = headerType;
    else if (typeByName?.startsWith("image/")) contentType = typeByName;
    else contentType = "image/jpeg";
  } else {
    contentType = magicType || (!isGenericContentType(headerType) ? headerType! : undefined) || typeByName || "application/octet-stream";
  }

  const hasExt = Boolean(chosenName && /\.[a-z0-9]{1,16}$/i.test(chosenName));
  const ext = guessExtensionFromContentType(contentType) || (params.kind === "image" ? "jpg" : "bin");
  const filename = chosenName ? (hasExt ? chosenName : `${chosenName}.${ext}`) : `${params.kind}.${ext}`;
  return { contentType, filename };
}

export function looksLikeSendLocalFileIntent(rawBody: string): boolean {
  const t = rawBody.trim();
  if (!t) return false;
  return /(发送|发给|发到|转发|把.*发|把.*发送|帮我发|给我发)/.test(t);
}

export async function processBotInboundMessage(params: {
  target: WecomWebhookTarget;
  msg: WecomInboundMessage;
  recordOperationalIssue: (event: {
    category: "media-decrypt-failed";
    messageId?: string;
    summary: string;
    raw: { transport: "bot-webhook"; envelopeType: "json"; body: WecomInboundMessage };
    error?: string;
  }) => void;
}): Promise<BotInboundNormalizationResult> {
  const { target, msg, recordOperationalIssue } = params;
  const msgtype = String(msg.msgtype ?? "").toLowerCase();
  const aesKey = target.account.encodingAESKey;
  const maxBytes = resolveWecomMediaMaxBytes(target.config, target.account.accountId);
  const proxyUrl = resolveWecomEgressProxyUrl(target.config);

  if (msgtype === "image") {
    const url = String((msg as any).image?.url ?? "").trim();
    if (url && aesKey) {
      try {
        const decrypted = await decryptWecomMediaWithMeta(url, aesKey, { maxBytes, http: { proxyUrl } });
        const inferred = inferInboundMediaMeta({
          kind: "image",
          buffer: decrypted.buffer,
          sourceUrl: decrypted.sourceUrl || url,
          sourceContentType: decrypted.sourceContentType,
          sourceFilename: decrypted.sourceFilename,
          explicitFilename: pickBotFileName(msg),
        });
        return { body: "[image]", media: { buffer: decrypted.buffer, contentType: inferred.contentType, filename: inferred.filename } };
      } catch (err) {
        target.runtime.error?.(`图片解密失败: ${String(err)}; 可调大 channels.wecom.mediaMaxMb（当前=${Math.round(maxBytes / (1024 * 1024))}MB）例如：openclaw config set channels.wecom.mediaMaxMb 50`);
        recordOperationalIssue({
          category: "media-decrypt-failed",
          messageId: msg.msgid ? String(msg.msgid) : undefined,
          summary: `image decrypt failed url=${url}`,
          raw: { transport: "bot-webhook", envelopeType: "json", body: msg },
          error: err instanceof Error ? err.message : String(err),
        });
        const errorMessage = typeof err === "object" && err ? `${(err as any).message}${(err as any).cause ? ` (cause: ${String((err as any).cause)})` : ""}` : String(err);
        return { body: `[image] (decryption failed: ${errorMessage})` };
      }
    }
  }

  if (msgtype === "file") {
    const url = String((msg as any).file?.url ?? "").trim();
    if (url && aesKey) {
      try {
        const decrypted = await decryptWecomMediaWithMeta(url, aesKey, { maxBytes, http: { proxyUrl } });
        const inferred = inferInboundMediaMeta({
          kind: "file",
          buffer: decrypted.buffer,
          sourceUrl: decrypted.sourceUrl || url,
          sourceContentType: decrypted.sourceContentType,
          sourceFilename: decrypted.sourceFilename,
          explicitFilename: pickBotFileName(msg),
        });
        return { body: "[file]", media: { buffer: decrypted.buffer, contentType: inferred.contentType, filename: inferred.filename } };
      } catch (err) {
        target.runtime.error?.(`Failed to decrypt inbound file: ${String(err)}; 可调大 channels.wecom.mediaMaxMb（当前=${Math.round(maxBytes / (1024 * 1024))}MB）例如：openclaw config set channels.wecom.mediaMaxMb 50`);
        recordOperationalIssue({
          category: "media-decrypt-failed",
          messageId: msg.msgid ? String(msg.msgid) : undefined,
          summary: `file decrypt failed url=${url}`,
          raw: { transport: "bot-webhook", envelopeType: "json", body: msg },
          error: err instanceof Error ? err.message : String(err),
        });
        const errorMessage = typeof err === "object" && err ? `${(err as any).message}${(err as any).cause ? ` (cause: ${String((err as any).cause)})` : ""}` : String(err);
        return { body: `[file] (decryption failed: ${errorMessage})` };
      }
    }
  }

  if (msgtype === "mixed") {
    const items = (msg as any).mixed?.msg_item;
    if (Array.isArray(items)) {
      let foundMedia: BotInboundNormalizationResult["media"];
      const bodyParts: string[] = [];
      for (const item of items) {
        const t = String(item.msgtype ?? "").toLowerCase();
        if (t === "text") {
          const content = String(item.text?.content ?? "").trim();
          if (content) bodyParts.push(content);
          continue;
        }
        if ((t === "image" || t === "file") && !foundMedia && aesKey) {
          const url = String(item[t]?.url ?? "").trim();
          if (url) {
            try {
              const decrypted = await decryptWecomMediaWithMeta(url, aesKey, { maxBytes, http: { proxyUrl } });
              const inferred = inferInboundMediaMeta({
                kind: t,
                buffer: decrypted.buffer,
                sourceUrl: decrypted.sourceUrl || url,
                sourceContentType: decrypted.sourceContentType,
                sourceFilename: decrypted.sourceFilename,
                explicitFilename: pickBotFileName(msg, item?.[t]),
              });
              foundMedia = { buffer: decrypted.buffer, contentType: inferred.contentType, filename: inferred.filename };
              bodyParts.push(`[${t}]`);
              continue;
            } catch (err) {
              target.runtime.error?.(`Failed to decrypt mixed ${t}: ${String(err)}; 可调大 channels.wecom.mediaMaxMb（当前=${Math.round(maxBytes / (1024 * 1024))}MB）例如：openclaw config set channels.wecom.mediaMaxMb 50`);
              recordOperationalIssue({
                category: "media-decrypt-failed",
                messageId: msg.msgid ? String(msg.msgid) : undefined,
                summary: `mixed ${t} decrypt failed url=${url}`,
                raw: { transport: "bot-webhook", envelopeType: "json", body: msg },
                error: err instanceof Error ? err.message : String(err),
              });
              const errorMessage = typeof err === "object" && err ? `${(err as any).message}${(err as any).cause ? ` (cause: ${String((err as any).cause)})` : ""}` : String(err);
              bodyParts.push(`[${t}] (decryption failed: ${errorMessage})`);
              continue;
            }
          }
        }
        bodyParts.push(`[${t}]`);
      }
      return { body: bodyParts.join("\n"), media: foundMedia };
    }
  }

  // 处理带引用的文本消息中的附件（修复引用文件URL过期问题）
  // 当 msgtype === "text" 但有 quote 附件时，需要下载并解密
  if ((msgtype === "text" || !msgtype) && aesKey) {
    const quote = (msg as any).quote;
    if (quote) {
      const quoteMsgtype = String(quote.msgtype ?? "").toLowerCase();

      // 引用的是文件
      if (quoteMsgtype === "file" && quote.file?.url) {
        const url = String(quote.file.url).trim();
        if (url) {
          try {
            const decrypted = await decryptWecomMediaWithMeta(url, aesKey, { maxBytes, http: { proxyUrl } });
            const inferred = inferInboundMediaMeta({
              kind: "file",
              buffer: decrypted.buffer,
              sourceUrl: decrypted.sourceUrl || url,
              sourceContentType: decrypted.sourceContentType,
              sourceFilename: decrypted.sourceFilename,
              explicitFilename: pickBotFileName(msg, quote),
            });
            // 返回原文（包含quote文本）并附带下载的文件
            return { body: buildInboundBody(msg), media: { buffer: decrypted.buffer, contentType: inferred.contentType, filename: inferred.filename } };
          } catch (err) {
            target.runtime.error?.(`引用文件解密失败: ${String(err)}`);
            recordOperationalIssue({
              category: "media-decrypt-failed",
              messageId: msg.msgid ? String(msg.msgid) : undefined,
              summary: `quote file decrypt failed url=${url}`,
              raw: { transport: "bot-webhook", envelopeType: "json", body: msg },
              error: err instanceof Error ? err.message : String(err),
            });
            // 下载失败时仍返回原文（包含错误提示）
            return { body: buildInboundBody(msg) };
          }
        }
      }

      // 引用的是图片
      if (quoteMsgtype === "image" && quote.image?.url) {
        const url = String(quote.image.url).trim();
        if (url) {
          try {
            const decrypted = await decryptWecomMediaWithMeta(url, aesKey, { maxBytes, http: { proxyUrl } });
            const inferred = inferInboundMediaMeta({
              kind: "image",
              buffer: decrypted.buffer,
              sourceUrl: decrypted.sourceUrl || url,
              sourceContentType: decrypted.sourceContentType,
              sourceFilename: decrypted.sourceFilename,
              explicitFilename: pickBotFileName(msg, quote),
            });
            return { body: buildInboundBody(msg), media: { buffer: decrypted.buffer, contentType: inferred.contentType, filename: inferred.filename } };
          } catch (err) {
            target.runtime.error?.(`引用图片解密失败: ${String(err)}`);
            recordOperationalIssue({
              category: "media-decrypt-failed",
              messageId: msg.msgid ? String(msg.msgid) : undefined,
              summary: `quote image decrypt failed url=${url}`,
              raw: { transport: "bot-webhook", envelopeType: "json", body: msg },
              error: err instanceof Error ? err.message : String(err),
            });
            return { body: buildInboundBody(msg) };
          }
        }
      }
    }
  }

  return { body: buildInboundBody(msg) };
}
