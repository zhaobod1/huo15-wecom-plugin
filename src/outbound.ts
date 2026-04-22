import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import { WecomAgentDeliveryService } from "./capability/agent/index.js";
import {
  resolveWecomMergedMediaLocalRoots,
  resolveWecomMediaMaxBytes,
  resolveWecomAccount,
  resolveWecomAccountConflict,
  resolveWecomAccounts,
} from "./config/index.js";
import {
  getAccountRuntime,
  getActiveBotWsReplyHandle,
  getBotWsPushHandle,
  getWecomRuntime,
} from "./runtime.js";
import { resolveWecomSourceSnapshot } from "./runtime/source-registry.js";
import { parseKefuScopedTarget, resolveScopedWecomTarget } from "./target.js";
import {
  deliverKefuMediaUrl,
  deliverKefuText,
  type KefuDeliveryTarget,
} from "./transport/kefu/outbound.js";
import { extractMarkdownImages } from "./wecom_msg_adapter/image_extractor.js";
import { loadImageAsPayload } from "./wecom_msg_adapter/image_fetcher.js";
import { toKefuText } from "./wecom_msg_adapter/kefu_text_adapter.js";
import { toWeComMarkdownV2 } from "./wecom_msg_adapter/markdown_adapter.js";

type WecomOutboundBaseContext = Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0];
type WecomOutboundContext = WecomOutboundBaseContext & {
  sessionKey?: string | null;
};
type WecomOutboundConfig = WecomOutboundContext["cfg"];

function resolveOutboundAccountOrThrow(params: {
  cfg: WecomOutboundConfig;
  accountId?: string | null;
}) {
  const resolvedAccounts = resolveWecomAccounts(params.cfg);
  const conflictAccountId = params.accountId?.trim() || resolvedAccounts.defaultAccountId;
  const conflict = resolveWecomAccountConflict({
    cfg: params.cfg,
    accountId: conflictAccountId,
  });
  if (conflict) {
    throw new Error(conflict.message);
  }

  const requestedAccountId = params.accountId?.trim();
  if (requestedAccountId) {
    if (!resolvedAccounts.accounts[requestedAccountId]) {
      throw new Error(
        `WeCom outbound account "${requestedAccountId}" not found. Configure channels.wecom.accounts.${requestedAccountId} or use an existing accountId.`,
      );
    }
  }
  return resolveWecomAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
}

function resolveAgentConfigOrThrow(params: {
  cfg: WecomOutboundConfig;
  accountId?: string | null;
}) {
  const account = resolveOutboundAccountOrThrow(params).agent;
  if (!account?.apiConfigured) {
    throw new Error(
      `WeCom outbound requires Agent mode for account=${params.accountId ?? "default"}. Configure channels.wecom.accounts.<accountId>.agent (or legacy channels.wecom.agent).`,
    );
  }
  if (typeof account.agentId !== "number" || !Number.isFinite(account.agentId)) {
    throw new Error(
      `WeCom outbound requires channels.wecom.accounts.<accountId>.agent.agentId (or legacy channels.wecom.agent.agentId) for account=${params.accountId ?? account.accountId}.`,
    );
  }
  // 注意：不要在日志里输出 corpSecret 等敏感信息
  getAccountRuntime(account.accountId)?.log.info?.(
    `[wecom-outbound] Using agent config: accountId=${account.accountId}, corpId=${account.corpId}, agentId=${account.agentId}`,
  );
  return account;
}

function isExplicitAgentTarget(raw: string | undefined): boolean {
  return /^wecom-agent:/i.test(String(raw ?? "").trim());
}

function isExplicitKefuTarget(raw: string | undefined): boolean {
  return /^wecom-kefu:/i.test(String(raw ?? "").trim());
}

function resolveKefuDeliveryTarget(params: {
  cfg: WecomOutboundConfig;
  accountId?: string | null;
  to: string | undefined;
  sessionKey?: string | null;
}): { target: KefuDeliveryTarget; accountId: string } | undefined {
  const explicit = params.to ? parseKefuScopedTarget(params.to) : undefined;
  const explicitAccountId = explicit?.accountId?.trim();
  const account = resolveOutboundAccountOrThrow({
    cfg: params.cfg,
    accountId: explicitAccountId || params.accountId,
  });
  if (!account.kefu?.apiConfigured) {
    if (explicit) {
      throw new Error(
        `WeCom outbound account="${account.accountId}" is missing kefu credentials (corpId + corpSecret).`,
      );
    }
    return undefined;
  }
  if (explicit) {
    return {
      accountId: account.accountId,
      target: {
        kefu: account.kefu,
        openKfId: explicit.openKfId,
        externalUserId: explicit.externalUserId,
      },
    };
  }
  const scoped = resolveScopedWecomTarget(params.to, account.accountId);
  const externalUserId = scoped?.target.touser?.trim() || scoped?.target.kefu?.externalUserId?.trim();
  if (!externalUserId) return undefined;
  const snapshot = resolveWecomSourceSnapshot({
    accountId: account.accountId,
    sessionKey: params.sessionKey,
    peerKind: "direct",
    peerId: externalUserId,
  });
  if (snapshot?.source !== "kefu" || !snapshot.kefuOpenKfId) return undefined;
  return {
    accountId: account.accountId,
    target: {
      kefu: account.kefu,
      openKfId: snapshot.kefuOpenKfId,
      externalUserId,
    },
  };
}

async function sendTextViaKefu(params: {
  cfg: WecomOutboundConfig;
  accountId?: string | null;
  to: string | undefined;
  text: string;
  sessionKey?: string | null;
}): Promise<boolean> {
  if (isExplicitAgentTarget(params.to)) return false;
  const resolved = resolveKefuDeliveryTarget(params);
  if (!resolved) return false;
  const { images, residualText } = extractMarkdownImages(params.text);
  let textToSend = residualText;
  for (const image of images) {
    try {
      await deliverKefuMediaUrl(resolved.target, image.url);
      getAccountRuntime(resolved.accountId)?.log.info?.(
        `[wecom-outbound] Sent kefu inline image to openKfId=${resolved.target.openKfId} externalUserId=${resolved.target.externalUserId} src=${image.url}`,
      );
    } catch (err) {
      getAccountRuntime(resolved.accountId)?.log.warn?.(
        `[wecom-outbound] kefu inline image failed (src=${image.url}): ${err instanceof Error ? err.message : String(err)}, embedding back into text`,
      );
      textToSend = textToSend
        ? `${textToSend}\n\n![${image.alt}](${image.url})`
        : `![${image.alt}](${image.url})`;
    }
  }
  const plain = toKefuText(textToSend);
  if (plain.trim()) {
    await deliverKefuText(resolved.target, plain);
    getAccountRuntime(resolved.accountId)?.log.info?.(
      `[wecom-outbound] Sent kefu text to openKfId=${resolved.target.openKfId} externalUserId=${resolved.target.externalUserId} (len=${plain.length})`,
    );
  } else if (images.length === 0) {
    getAccountRuntime(resolved.accountId)?.log.info?.(
      `[wecom-outbound] Empty kefu message to openKfId=${resolved.target.openKfId}, skipped`,
    );
    return false;
  }
  return true;
}

async function sendMediaViaKefu(params: {
  cfg: WecomOutboundConfig;
  accountId?: string | null;
  to: string | undefined;
  mediaUrl: string;
  sessionKey?: string | null;
}): Promise<boolean> {
  if (isExplicitAgentTarget(params.to)) return false;
  const resolved = resolveKefuDeliveryTarget(params);
  if (!resolved) return false;
  await deliverKefuMediaUrl(resolved.target, params.mediaUrl);
  getAccountRuntime(resolved.accountId)?.log.info?.(
    `[wecom-outbound] Sent kefu media to openKfId=${resolved.target.openKfId} externalUserId=${resolved.target.externalUserId} url=${params.mediaUrl}`,
  );
  return true;
}


function resolveBotWsChatTarget(params: {
  to: string | undefined;
  accountId: string;
}): string | undefined {
  const scoped = resolveScopedWecomTarget(params.to, params.accountId);
  if (!scoped) {
    return undefined;
  }
  if (scoped.accountId && scoped.accountId !== params.accountId) {
    throw new Error(
      `WeCom outbound account mismatch: target belongs to account=${scoped.accountId}, current account=${params.accountId}.`,
    );
  }
  if (scoped.target.chatid) {
    return scoped.target.chatid;
  }
  if (scoped.target.touser) {
    return scoped.target.touser;
  }
  return undefined;
}

function resolveOutboundPeer(params: {
  to: string | undefined;
  accountId: string;
}): { peerKind: "direct" | "group"; peerId: string } | undefined {
  const scoped = resolveScopedWecomTarget(params.to, params.accountId);
  if (!scoped) {
    return undefined;
  }
  if (scoped.accountId && scoped.accountId !== params.accountId) {
    return undefined;
  }
  if (scoped.target.chatid) {
    return { peerKind: "group", peerId: scoped.target.chatid };
  }
  if (scoped.target.touser) {
    return { peerKind: "direct", peerId: scoped.target.touser };
  }
  return undefined;
}

function shouldPreferBotWsOutbound(params: {
  cfg: WecomOutboundConfig;
  accountId?: string | null;
  to: string | undefined;
  sessionKey?: string | null;
}): { preferred: boolean; accountId: string } {
  const account = resolveOutboundAccountOrThrow({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const peer = resolveOutboundPeer({
    to: params.to,
    accountId: account.accountId,
  });
  const source = resolveWecomSourceSnapshot({
    accountId: account.accountId,
    sessionKey: params.sessionKey,
    peerKind: peer?.peerKind,
    peerId: peer?.peerId,
  });
  const pinnedToAgent = source?.source === "agent-callback";
  const pinnedToBotWs = source?.source === "bot-ws";
  return {
    preferred:
      !isExplicitAgentTarget(params.to) &&
      !pinnedToAgent &&
      Boolean(
        account.bot?.configured &&
        account.bot.wsConfigured &&
        (pinnedToBotWs || account.bot.primaryTransport === "ws"),
      ),
    accountId: account.accountId,
  };
}

function markActiveBotWsReplyHandleActivity(params: {
  accountId: string;
  sessionKey?: string | null;
  to: string | undefined;
}): void {
  const peer = resolveOutboundPeer({
    to: params.to,
    accountId: params.accountId,
  });
  const handle = getActiveBotWsReplyHandle({
    accountId: params.accountId,
    sessionKey: params.sessionKey,
    peerKind: peer?.peerKind,
    peerId: peer?.peerId,
  });
  handle?.markExternalActivity?.();
}

async function sendTextViaBotWs(params: {
  cfg: WecomOutboundConfig;
  accountId?: string | null;
  to: string | undefined;
  text: string;
  sessionKey?: string | null;
}): Promise<boolean> {
  const { preferred, accountId } = shouldPreferBotWsOutbound(params);
  if (!preferred) {
    return false;
  }
  const chatId = resolveBotWsChatTarget({
    to: params.to,
    accountId,
  });
  if (!chatId) {
    return false;
  }
  const handle = getBotWsPushHandle(accountId);
  if (!handle) {
    throw new Error(
      `WeCom outbound account=${accountId} is configured for Bot WS active push, but no live WS runtime is registered.`,
    );
  }
  if (!handle.isConnected()) {
    throw new Error(
      `WeCom outbound account=${accountId} is configured for Bot WS active push, but the WS transport is not connected.`,
    );
  }

  // 先把 markdown 内的 ![](url) 抽成独立图片消息,失败回退为内嵌 markdown
  const { images, residualText } = extractMarkdownImages(params.text);
  const mediaLocalRoots = resolveWecomMergedMediaLocalRoots({ cfg: params.cfg });
  const maxBytes = resolveWecomMediaMaxBytes(params.cfg, accountId);
  let textToSend = residualText;

  for (const image of images) {
    try {
      const result = await handle.sendMedia({
        chatId,
        mediaUrl: image.url,
        mediaLocalRoots,
        maxBytes,
      });
      if (result.ok) {
        console.log(
          `[wecom-outbound] Sent Bot WS inline image to ${chatId} (src=${image.url})`,
        );
        continue;
      }
      const reason = result.rejectReason || result.error || "unknown";
      console.warn(
        `[wecom-outbound] Bot WS inline image failed (src=${image.url}): ${reason}, embedding back into markdown`,
      );
    } catch (imgErr) {
      console.warn(
        `[wecom-outbound] Bot WS inline image threw (src=${image.url}): ${imgErr instanceof Error ? imgErr.message : String(imgErr)}, embedding back into markdown`,
      );
    }
    textToSend = textToSend
      ? `${textToSend}\n\n![${image.alt}](${image.url})`
      : `![${image.alt}](${image.url})`;
  }

  if (textToSend.trim()) {
    const markdownText = toWeComMarkdownV2(textToSend);
    console.log(
      `[wecom-outbound] Sending Bot WS active message to target=${String(params.to ?? "")} chatId=${chatId} (len=${markdownText.length})`,
    );
    await handle.sendMarkdown(chatId, markdownText);
    console.log(`[wecom-outbound] Successfully sent Bot WS active message to ${chatId}`);
  } else if (images.length === 0) {
    console.log(`[wecom-outbound] Empty Bot WS message to ${chatId}, skipped`);
    return false;
  }

  markActiveBotWsReplyHandleActivity({
    accountId,
    sessionKey: params.sessionKey,
    to: params.to,
  });
  return true;
}

async function sendMediaViaBotWs(params: {
  cfg: WecomOutboundConfig;
  accountId?: string | null;
  to: string | undefined;
  mediaUrl: string;
  text?: string;
  mediaLocalRoots?: readonly string[];
  sessionKey?: string | null;
}): Promise<{
  attempted: boolean;
  sent: boolean;
  reason?: string;
}> {
  const { preferred, accountId } = shouldPreferBotWsOutbound(params);
  if (!preferred) {
    return { attempted: false, sent: false };
  }
  const chatId = resolveBotWsChatTarget({
    to: params.to,
    accountId,
  });
  if (!chatId) {
    return { attempted: false, sent: false };
  }
  const handle = getBotWsPushHandle(accountId);
  if (!handle) {
    throw new Error(
      `WeCom outbound account=${accountId} is configured for Bot WS active push, but no live WS runtime is registered.`,
    );
  }
  if (!handle.isConnected()) {
    throw new Error(
      `WeCom outbound account=${accountId} is configured for Bot WS active push, but the WS transport is not connected.`,
    );
  }
  console.log(
    `[wecom-outbound] Sending Bot WS media to target=${String(params.to ?? "")} chatId=${chatId} media=${params.mediaUrl}`,
  );
  const effectiveMediaLocalRoots = resolveWecomMergedMediaLocalRoots({
    cfg: params.cfg,
    baseRoots: params.mediaLocalRoots,
  });
  const result = await handle.sendMedia({
    chatId,
    mediaUrl: params.mediaUrl,
    text: params.text,
    mediaLocalRoots: effectiveMediaLocalRoots,
    maxBytes: resolveWecomMediaMaxBytes(params.cfg, accountId),
  });
  if (result.ok) {
    markActiveBotWsReplyHandleActivity({
      accountId,
      sessionKey: params.sessionKey,
      to: params.to,
    });
    console.log(`[wecom-outbound] Successfully sent Bot WS media to ${chatId}`);
    return { attempted: true, sent: true };
  }
  const reason = result.rejectReason || result.error || "unknown";
  console.warn(`[wecom-outbound] Bot WS media failed for ${chatId}: ${reason}`);
  return { attempted: true, sent: false, reason };
}

export const wecomOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunkerMode: "text",
  textChunkLimit: 20480,
  chunker: (text: string, limit: number) => {
    try {
      return getWecomRuntime().channel.text.chunkText(text, limit);
    } catch {
      return [text];
    }
  },
  sendText: async ({ cfg, to, text, accountId, sessionKey }: WecomOutboundContext) => {
    // signal removed - not supported in current SDK
    // Defer Agent resolution until the Agent fallback path
    // sendTextViaBotWs() can already deliver without Agent mode

    // 体验优化：/new /reset 的“New session started”回执在 OpenClaw 核心里是英文固定文案，
    // 且通过 routeReply 走 wecom outbound（Agent 主动发送）。
    // 在 WeCom“双模式”场景下，这会造成：
    // - 用户在 Bot 会话发 /new，但却收到一条 Agent 私信回执（双重回复/错会话）。
    // 因此：
    // - Bot 会话目标：抑制该回执（Bot 会话里由 wecom 插件补中文回执）。
    // - Agent 会话目标（wecom-agent:）：允许发送，但改写成中文。
    let outgoingText = text;
    const trimmed = String(outgoingText ?? "").trim();
    const rawTo = typeof to === "string" ? to.trim().toLowerCase() : "";
    const isAgentSessionTarget = rawTo.startsWith("wecom-agent:");
    const looksLikeNewSessionAck = /new session started/i.test(trimmed) && /model:/i.test(trimmed);

    if (looksLikeNewSessionAck) {
      if (!isAgentSessionTarget) {
        // Suppress ack without agent resolution
        return { channel: "wecom", messageId: `suppressed-${Date.now()}`, timestamp: Date.now() };
      }

      const modelLabel = (() => {
        const m = trimmed.match(/model:\s*([^\n()]+)\s*/i);
        return m?.[1]?.trim();
      })();
      const rewritten = modelLabel ? `✅ 已开启新会话（模型：${modelLabel}）` : "✅ 已开启新会话。";
      outgoingText = rewritten;
    }

    let sentViaBotWs = false;
    let sentViaKefu = false;
    let agent: ReturnType<typeof resolveAgentConfigOrThrow> | null = null;

    try {
      sentViaKefu = await sendTextViaKefu({
        cfg,
        accountId,
        to,
        text: outgoingText,
        sessionKey,
      });
      if (!sentViaKefu) {
        sentViaBotWs = await sendTextViaBotWs({
          cfg,
          accountId,
          to,
          text: outgoingText,
          sessionKey,
        });
      }
      if (!sentViaKefu && !sentViaBotWs) {
        // Defer Agent resolution until needed for fallback
        agent = resolveAgentConfigOrThrow({ cfg, accountId });
        getAccountRuntime(agent.accountId)?.log.info?.(
          `[wecom-outbound] Sending text to target=${String(to ?? "")} (len=${outgoingText.length})`,
        );
        const deliveryService = new WecomAgentDeliveryService(agent);

        // 先把 markdown 中的 ![alt](url) 抽出来,单独作为 image 消息下发。
        // 企微 markdown_v2 虽然声称支持 ![](url),实际 CDN/外链图片经常渲染失败,
        // 用 uploadMedia + image 消息可靠性更高。失败时回退为内嵌 markdown 图片。
        const { images, residualText } = extractMarkdownImages(outgoingText);
        let textToSend = residualText;

        for (const image of images) {
          try {
            const payload = await loadImageAsPayload(image.url);
            await deliveryService.sendMedia({
              to,
              buffer: payload.buffer,
              filename: payload.filename,
              contentType: payload.contentType,
            });
            console.log(
              `[wecom-outbound] Sent inline image to ${String(to ?? "")} (src=${image.url}, ${payload.buffer.length}B)`,
            );
          } catch (imgErr) {
            console.warn(
              `[wecom-outbound] Inline image upload failed (src=${image.url}), embedding back into markdown: ${imgErr instanceof Error ? imgErr.message : String(imgErr)}`,
            );
            textToSend = textToSend
              ? `${textToSend}\n\n![${image.alt}](${image.url})`
              : `![${image.alt}](${image.url})`;
          }
        }

        // markdown_v2 原生支持表格/链接/标题/粗体/代码块,不再需要 textcard 降级
        const MARKDOWN_PATTERNS = /^#{1,6}\s|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\)|`[^`\n]+`|```|^>\s|^\s*[-*+]\s|\|.*\||!\[[^\]\n]*\]\(/m;
        if (textToSend.trim()) {
          if (MARKDOWN_PATTERNS.test(textToSend)) {
            const markdownText = toWeComMarkdownV2(textToSend);
            console.log(
              `[wecom-outbound] Markdown features detected, sending as markdown_v2 to target=${String(to ?? "")} (len=${markdownText.length})`,
            );
            await deliveryService.sendMarkdown({ to, text: markdownText });
            console.log(`[wecom-outbound] Successfully sent Agent markdown_v2 to ${String(to ?? "")}`);
          } else {
            await deliveryService.sendText({
              to,
              text: textToSend,
            });
            console.log(`[wecom-outbound] Successfully sent Agent text to ${String(to ?? "")}`);
          }
        } else if (images.length === 0) {
          console.log(`[wecom-outbound] Empty text, nothing to send to ${String(to ?? "")}`);
        }
      }
    } catch (err) {
      if (agent) {
        getAccountRuntime(agent.accountId)?.log.error?.(
          `[wecom-outbound] Failed to send text to ${String(to ?? "")}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      throw err;
    }

    const transport = sentViaKefu ? "kefu" : sentViaBotWs ? "bot-ws" : "agent";
    return {
      channel: "wecom",
      messageId: `${transport}-${Date.now()}`,
      timestamp: Date.now(),
    };
  },
  sendMedia: async ({
    cfg,
    to,
    text,
    mediaUrl,
    accountId,
    mediaLocalRoots,
    sessionKey,
  }: WecomOutboundContext) => {
    // signal removed - not supported in current SDK
    if (!mediaUrl) {
      throw new Error("WeCom outbound requires mediaUrl.");
    }

    const sentViaKefu = await sendMediaViaKefu({
      cfg,
      accountId,
      to,
      mediaUrl,
      sessionKey,
    });
    if (sentViaKefu) {
      return {
        channel: "wecom",
        messageId: `kefu-media-${Date.now()}`,
        timestamp: Date.now(),
      };
    }

    const botWs = await sendMediaViaBotWs({
      cfg,
      accountId,
      to,
      text,
      mediaUrl,
      mediaLocalRoots,
      sessionKey,
    });
    if (botWs.sent) {
      return {
        channel: "wecom",
        messageId: `bot-ws-media-${Date.now()}`,
        timestamp: Date.now(),
      };
    }
    if (botWs.attempted) {
      throw new Error(
        `WeCom Bot WS media delivery failed for ${String(to ?? "")}: ${botWs.reason ?? "unknown"}`,
      );
    }

    const agent = resolveAgentConfigOrThrow({ cfg, accountId });
    const deliveryService = new WecomAgentDeliveryService(agent);

    let buffer: Buffer;
    let contentType: string;
    let filename: string;

    // 判断是 URL 还是本地文件路径
    const isRemoteUrl = /^https?:\/\//i.test(mediaUrl);

    if (isRemoteUrl) {
      const res = await fetch(mediaUrl, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) {
        throw new Error(`Failed to download media: ${res.status}`);
      }
      buffer = Buffer.from(await res.arrayBuffer());
      contentType = res.headers.get("content-type") || "application/octet-stream";
      const urlPath = new URL(mediaUrl).pathname;
      filename = urlPath.split("/").pop() || "media";
    } else {
      // 本地文件路径
      const fs = await import("node:fs/promises");
      const path = await import("node:path");

      buffer = await fs.readFile(mediaUrl);
      filename = path.basename(mediaUrl);

      // 根据扩展名推断 content-type
      const ext = path.extname(mediaUrl).slice(1).toLowerCase();
      const mimeTypes: Record<string, string> = {
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        gif: "image/gif",
        webp: "image/webp",
        bmp: "image/bmp",
        mp3: "audio/mpeg",
        wav: "audio/wav",
        amr: "audio/amr",
        mp4: "video/mp4",
        pdf: "application/pdf",
        doc: "application/msword",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xls: "application/vnd.ms-excel",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ppt: "application/vnd.ms-powerpoint",
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        txt: "text/plain",
        csv: "text/csv",
        tsv: "text/tab-separated-values",
        md: "text/markdown",
        json: "application/json",
        xml: "application/xml",
        yaml: "application/yaml",
        yml: "application/yaml",
        zip: "application/zip",
        rar: "application/vnd.rar",
        "7z": "application/x-7z-compressed",
        tar: "application/x-tar",
        gz: "application/gzip",
        tgz: "application/gzip",
        rtf: "application/rtf",
        odt: "application/vnd.oasis.opendocument.text",
      };
      contentType = mimeTypes[ext] || "application/octet-stream";
      console.log(
        `[wecom-outbound] Reading local file: ${mediaUrl}, ext=${ext}, contentType=${contentType}`,
      );
    }

    console.log(
      `[wecom-outbound] Sending media to ${String(to ?? "")} (filename=${filename}, contentType=${contentType})`,
    );

    try {
      await deliveryService.sendMedia({
        to,
        text,
        buffer,
        filename,
        contentType,
      });
      console.log(`[wecom-outbound] Successfully sent media to ${String(to ?? "")}`);
    } catch (err) {
      console.error(`[wecom-outbound] Failed to send media to ${String(to ?? "")}:`, err);
      throw err;
    }

    return {
      channel: "wecom",
      messageId: `${botWs.attempted ? "agent-fallback-media" : "agent-media"}-${Date.now()}`,
      timestamp: Date.now(),
    };
  },
};
