import {
  generateReqId,
  type WsFrame,
  type BaseMessage,
  type EventMessage,
  type WSClient,
} from "@wecom/aibot-node-sdk";
import { formatErrorMessage } from "openclaw/plugin-sdk/infra-runtime";
import { resolveWecomMediaMaxBytes, resolveWecomMergedMediaLocalRoots } from "../../config/index.js";
import { getAccountRuntime, getReplyTransformer, getWecomRuntime } from "../../runtime.js";
import type { ReplyHandle, ReplyPayload } from "../../types/index.js";
import { toWeComMarkdownV2 } from "../../wecom_msg_adapter/markdown_adapter.js";
import { uploadAndSendBotWsMedia } from "./media.js";
import { sendAgentApiText } from "../agent-api/client.js";

const PLACEHOLDER_KEEPALIVE_MS = 3000;
const MAX_KEEPALIVE_MS = 120 * 1000; // Force stop keepalive after 120s if ignored

// ── WS Health Watchdog ──
// Per-account counter of consecutive ack timeouts within a rolling window.
// When threshold is exceeded, triggers a callback (e.g. WS reconnect).
interface AckTimeoutWatchdog {
  accountId: string;
  count: number;
  firstHitAt: number;
  timer?: ReturnType<typeof setTimeout>;
}
const ACK_TIMEOUT_WARNING_THRESHOLD = 5;  // consecutive timeouts before warning
const ACK_TIMEOUT_RECONNECT_THRESHOLD = 8; // consecutive timeouts before call reconnect
const ACK_TIMEOUT_WINDOW_MS = 120_000;     // reset counter if no hits within 2 min

const ackWatchdogs = new Map<string, AckTimeoutWatchdog>();

function hitAckTimeoutWatchdog(params: {
  accountId: string;
  onReconnectNeeded?: (accountId: string) => void;
}): void {
  const key = params.accountId;
  const now = Date.now();
  let wd = ackWatchdogs.get(key);
  if (!wd || now - wd.firstHitAt > ACK_TIMEOUT_WINDOW_MS) {
    wd = { accountId: key, count: 0, firstHitAt: now };
    ackWatchdogs.set(key, wd);
  }
  wd.count += 1;

  // Reset timer: clear counter if no more timeouts within the window
  if (wd.timer) clearTimeout(wd.timer);
  wd.timer = setTimeout(() => {
    ackWatchdogs.delete(key);
  }, ACK_TIMEOUT_WINDOW_MS);

  if (wd.count >= ACK_TIMEOUT_RECONNECT_THRESHOLD) {
    console.warn(
      `[wecom-ws] watchdog: ${wd.count} consecutive ack timeouts for account=${key}, triggering reconnect`,
    );
    ackWatchdogs.delete(key); // reset after firing
    params.onReconnectNeeded?.(key);
  } else if (wd.count >= ACK_TIMEOUT_WARNING_THRESHOLD) {
    console.warn(
      `[wecom-ws] watchdog: ${wd.count} ack timeouts within window for account=${key} (threshold=${ACK_TIMEOUT_RECONNECT_THRESHOLD})`,
    );
  }
}

function isInvalidReqIdError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const errcode = "errcode" in error ? Number(error.errcode) : undefined;
  const errmsg = "errmsg" in error ? String(error.errmsg ?? "") : "";
  return errcode === 846605 || errmsg.includes("invalid req_id");
}

function isExpiredStreamUpdateError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const errcode = "errcode" in error ? Number(error.errcode) : undefined;
  const errmsg = "errmsg" in error ? String(error.errmsg ?? "").toLowerCase() : "";
  return errcode === 846608 || errmsg.includes("stream message update expired");
}

/** SDK rejects with a plain Error whose message contains "ack timeout" when
 * the WeCom server does not acknowledge a reply within 5 s.  Once timed out
 * the reqId slot is released; further replies on the same reqId will fail. */
function isAckTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("ack timeout");
}

function isTerminalReplyError(error: unknown): boolean {
  return (
    isInvalidReqIdError(error) || isExpiredStreamUpdateError(error) || isAckTimeoutError(error)
  );
}

function formatMediaFailure(mediaUrl: string, error?: string, rejectReason?: string): string {
  const reason = rejectReason || error || "unknown";
  return `媒体发送失败：${mediaUrl} (${reason})`;
}

// Global registry to track active keepalives by peerId
interface ActiveKeepalive {
  reqId: string;
  stop: () => void;
}
const activeKeepalivesByPeer = new Map<string, Set<ActiveKeepalive>>();

export function createBotWsReplyHandle(params: {
  client: WSClient;
  frame: WsFrame<BaseMessage | EventMessage>;
  accountId: string;
  inboundKind: string;
  placeholderContent?: string;
  autoSendPlaceholder?: boolean;
  onDeliver?: () => void;
  onFail?: (error: unknown) => void;
  onReconnectNeeded?: (accountId: string) => void;
}): ReplyHandle {
  let streamId: string | undefined;
  let accumulatedText = "";
  let deferredMediaUrls: string[] = [];
  const resolveStreamId = () => {
    streamId ||= generateReqId("stream");
    return streamId;
  };

  const placeholderText = params.placeholderContent?.trim() || "⏳ 正在思考中...\n\n";
  let streamSettled = false;
  let placeholderInFlight = false;
  let placeholderKeepalive: ReturnType<typeof setInterval> | undefined;
  let placeholderTimeout: ReturnType<typeof setTimeout> | undefined;

  // Extract peerId for clustering handles
  const body = params.frame.body as any;
  const peerId = String(
    (body?.chattype === "group" ? body?.chatid || body?.from?.userid : body?.from?.userid) ||
      "unknown",
  );
  const peerKind: "direct" | "group" =
    body?.chattype === "group" ? "group" : "direct";
  const reqId = params.frame.headers.req_id || "unknown";

  const isEvent =
    params.inboundKind === "welcome" ||
    params.inboundKind === "event" ||
    params.inboundKind === "template-card-event";

  const stopPlaceholderKeepalive = () => {
    if (placeholderKeepalive) {
      clearInterval(placeholderKeepalive);
      placeholderKeepalive = undefined;
    }
    if (placeholderTimeout) {
      clearTimeout(placeholderTimeout);
      placeholderTimeout = undefined;
    }

    // Remove from registry
    const keepalives = activeKeepalivesByPeer.get(peerId);
    if (keepalives) {
      for (const ka of keepalives) {
        if (ka.reqId === reqId) {
          keepalives.delete(ka);
        }
      }
      if (keepalives.size === 0) {
        activeKeepalivesByPeer.delete(peerId);
      }
    }
  };

  const settleStream = () => {
    if (streamSettled) return;
    streamSettled = true;
    stopPlaceholderKeepalive();
  };

  const sendPlaceholder = () => {
    if (streamSettled || placeholderInFlight || isEvent) return;
    placeholderInFlight = true;
    params.client
      .replyStream(params.frame, resolveStreamId(), placeholderText, false)
      .catch((error) => {
        if (!isTerminalReplyError(error)) {
          return;
        }
        settleStream();
        params.onFail?.(error);
      })
      .finally(() => {
        placeholderInFlight = false;
      });
  };

  const notifyPeerActive = () => {
    // A genuine reply or reasoning is happening on THIS handle.
    // It means the core SDK has chosen this handle to deliver the response.
    // We can safely terminate all other orphaned keepalives for this peer to prevent infinite loops.
    const keepalives = activeKeepalivesByPeer.get(peerId);
    if (keepalives) {
      for (const ka of keepalives) {
        if (ka.reqId !== reqId) {
          ka.stop();
        }
      }
    }
  };

  const mergeDeferredMediaUrls = (urls: string[]): string[] => {
    if (urls.length === 0) {
      return deferredMediaUrls;
    }
    const merged = [...deferredMediaUrls];
    for (const url of urls) {
      if (!merged.includes(url)) {
        merged.push(url);
      }
    }
    deferredMediaUrls = merged;
    return deferredMediaUrls;
  };

  /**
   * Fallback delivery via Agent API when WS delivery fails or WS is disconnected.
   * This ensures replies are still delivered even after gateway restart or WS reconnect.
   */
  const fallbackAgentApiDelivery = async (text: string): Promise<void> => {
    const accountRuntime = getAccountRuntime(params.accountId);
    const agent = accountRuntime?.account.agent;
    if (!agent?.apiConfigured) {
      console.warn(
        `[wecom-ws] fallback: no agent API config for account=${params.accountId}, cannot deliver text fallback`,
      );
      return;
    }
    try {
      if (peerKind === "group") {
        await sendAgentApiText({ agent, chatId: peerId, text });
      } else {
        await sendAgentApiText({ agent, toUser: peerId, text });
      }
      console.log(
        `[wecom-ws] fallback: delivered text via Agent API to ${peerKind}=${peerId}`,
      );
    } catch (err) {
      console.error(
        `[wecom-ws] fallback: Agent API delivery failed for ${peerKind}=${peerId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  };

  if (params.autoSendPlaceholder !== false && !isEvent) {
    sendPlaceholder();
    placeholderKeepalive = setInterval(() => {
      sendPlaceholder();
    }, PLACEHOLDER_KEEPALIVE_MS);

    // Safety net: force stop keepalive after MAX_KEEPALIVE_MS
    // in case the message is completely ignored by the core and never triggers deliver/fail
    placeholderTimeout = setTimeout(() => {
      stopPlaceholderKeepalive();
    }, MAX_KEEPALIVE_MS);

    // Register keepalive
    let keepalives = activeKeepalivesByPeer.get(peerId);
    if (!keepalives) {
      keepalives = new Set();
      activeKeepalivesByPeer.set(peerId, keepalives);
    }
    keepalives.add({ reqId, stop: stopPlaceholderKeepalive });
  }

  return {
    context: {
      transport: "bot-ws",
      accountId: params.accountId,
      reqId: params.frame.headers.req_id,
      peerId,
      peerKind,
      raw: {
        transport: "bot-ws",
        command: params.frame.cmd,
        headers: params.frame.headers,
        body: params.frame.body,
        envelopeType: "ws",
      },
    },
    deliver: async (payload: ReplyPayload, info) => {
      // Mark this chat as active on this handle
      notifyPeerActive();

      if (payload.isReasoning) {
        // We reset the safety timeout if reasoning is actively streaming
        if (placeholderTimeout && !isEvent) {
          clearTimeout(placeholderTimeout);
          placeholderTimeout = setTimeout(() => {
            stopPlaceholderKeepalive();
          }, MAX_KEEPALIVE_MS);
        }
        return;
      }

      const text = payload.text?.trim() || "";
      const incomingMediaUrls = payload.mediaUrls || (payload.mediaUrl ? [payload.mediaUrl] : []);
      const hasIncomingMedia = incomingMediaUrls.length > 0;
      if (info.kind !== "final" && hasIncomingMedia) {
        mergeDeferredMediaUrls(incomingMediaUrls);
      }
      const mediaUrls =
        info.kind === "final" ? mergeDeferredMediaUrls(incomingMediaUrls) : incomingMediaUrls;
      if (!text && mediaUrls.length === 0) {
        return;
      }

      if (info.kind === "block") {
        if (!text) {
          return;
        }
        accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;
      }

      const outboundText =
        info.kind === "final"
          ? accumulatedText
            ? text
              ? `${accumulatedText}\n${text}`
              : accumulatedText
            : text
          : accumulatedText || text;

      let finalText = outboundText;
      if (info.kind === "final" && mediaUrls.length > 0) {
        const cfg = getWecomRuntime().config.loadConfig();
        const mediaLocalRoots = resolveWecomMergedMediaLocalRoots({ cfg });
        const mediaMaxBytes = resolveWecomMediaMaxBytes(cfg, params.accountId);
        const mediaFailures: string[] = [];
        const mediaNotes: string[] = [];
        let mediaSent = 0;
        for (const mediaUrl of mediaUrls) {
          const result = await uploadAndSendBotWsMedia({
            wsClient: params.client,
            chatId: peerId,
            mediaUrl,
            mediaLocalRoots,
            maxBytes: mediaMaxBytes,
          });
          if (result.ok) {
            mediaSent += 1;
            if (result.downgradeNote) {
              mediaNotes.push(result.downgradeNote);
            }
            continue;
          }
          mediaFailures.push(formatMediaFailure(mediaUrl, result.error, result.rejectReason));
        }

        if (!finalText && mediaSent > 0) {
          finalText = "文件已发送。";
        }
        if (mediaFailures.length > 0) {
          finalText = finalText
            ? `${finalText}\n\n${mediaFailures.join("\n")}`
            : mediaFailures.join("\n");
        }
        if (mediaNotes.length > 0) {
          finalText = finalText
            ? `${finalText}\n\n${mediaNotes.join("\n")}`
            : mediaNotes.join("\n");
        }
        deferredMediaUrls = [];
      }
      if (!finalText) {
        return;
      }

      // Event frames do not support streaming chunks
      if (isEvent && info.kind !== "final") {
        return;
      }

      // For non-final (block) chunks: only accumulate text, don't send.
      // Sending each block via WS individually feeds the SDK's reply queue,
      // where each item waits 5s for WS ack. If ack is slow, 24 blocks × 5s = 120s.
      // Final delivery handles the full accumulated text in a single shot.
      if (info.kind !== "final") {
        return;
      }

      settleStream();

      // Short-term fix: if WS is disconnected (e.g. after gateway restart),
      // fall back to Agent API delivery to ensure the reply still reaches the user
      if (!params.client.isConnected) {
        console.warn(
          `[wecom-ws] WS not connected for account=${params.accountId} peer=${peerId}, using fallback delivery`,
        );
        try {
          await fallbackAgentApiDelivery(toWeComMarkdownV2(finalText));
          params.onDeliver?.();
        } catch (err) {
          params.onFail?.(err);
        }
        return;
      }

      // 调用 reply transformer（智能贴士 + 火苗宠物）
      if (info.kind === "final" && params.inboundKind !== "welcome") {
        const transformer = getReplyTransformer();
        if (transformer) {
          try {
            finalText = transformer(finalText, {
              peerId,
              accountId: params.accountId,
            });
          } catch (e) {
            console.error("[wecom-ws] reply transformer error:", e);
          }
        }
      }

      try {
        if (params.inboundKind === "welcome") {
          await params.client.replyWelcome(params.frame, {
            msgtype: "text",
            text: { content: finalText },
          });
        } else if (isEvent) {
          // Send push message for other events
          await params.client.sendMessage(peerId, {
            msgtype: "markdown_v2",
            markdown_v2: { content: toWeComMarkdownV2(finalText) },
          } as unknown as Parameters<typeof params.client.sendMessage>[1]);
        } else {
          await params.client.replyStream(
            params.frame,
            resolveStreamId(),
            toWeComMarkdownV2(finalText),
            true,
          );
        }
      } catch (error) {
        if (isTerminalReplyError(error)) {
          // Ack timeout: try Agent API fallback before giving up.
          // The WS reqId slot is released after ack timeout, but the
          // Agent API uses a separate HTTP path so it can still deliver.
          if (isAckTimeoutError(error) || isInvalidReqIdError(error)) {
            // Record this hit in the health watchdog (may trigger reconnect)
            hitAckTimeoutWatchdog({
              accountId: params.accountId,
              onReconnectNeeded: params.onReconnectNeeded,
            });
            console.warn(
              `[wecom-ws] ${error instanceof Error ? error.message : String(error)} for ${peerId}, trying Agent API fallback`,
            );
            try {
              await fallbackAgentApiDelivery(toWeComMarkdownV2(finalText));
              params.onDeliver?.();
              return;
            } catch (fallbackErr) {
              // fallback failed too, proceed to onFail
            }
          }
          params.onFail?.(error);
          return;
        }
        // WS delivery failed (may be disconnected mid-flight). Try fallback.
        console.warn(
          `[wecom-ws] WS delivery failed for ${peerId}: ${error instanceof Error ? error.message : String(error)}, trying fallback`,
        );
        try {
          await fallbackAgentApiDelivery(toWeComMarkdownV2(finalText));
          params.onDeliver?.();
        } catch (fallbackErr) {
          params.onFail?.(fallbackErr);
        }
        return;
      }
      params.onDeliver?.();
    },
    fail: async (error: unknown) => {
      notifyPeerActive();
      settleStream();
      if (isTerminalReplyError(error)) {
        params.onFail?.(error);
        return;
      }
      const message = formatErrorMessage(error);
      const text = `WeCom WS reply failed: ${message}`;

      // Short-term fix: if WS is disconnected, use fallback delivery for error messages too
      if (!params.client.isConnected) {
        console.warn(
          `[wecom-ws] WS not connected in fail() for account=${params.accountId} peer=${peerId}, using fallback`,
        );
        try {
          await fallbackAgentApiDelivery(text);
        } catch {
          // fallback failed, still call onFail
        }
        params.onFail?.(error);
        return;
      }

      try {
        if (params.inboundKind === "welcome") {
          await params.client.replyWelcome(params.frame, {
            msgtype: "text",
            text: { content: text },
          });
        } else if (isEvent) {
          await params.client.sendMessage(peerId, {
            msgtype: "markdown_v2",
            markdown_v2: { content: text },
          } as unknown as Parameters<typeof params.client.sendMessage>[1]);
        } else {
          await params.client.replyStream(params.frame, resolveStreamId(), text, true);
        }
      } catch (sendError) {
        // Fallback for send error
        try {
          await fallbackAgentApiDelivery(text);
        } catch {
          // fallback failed
        }
        params.onFail?.(sendError);
        return;
      }
      params.onFail?.(error);
    },
    markExternalActivity: () => {
      notifyPeerActive();
      stopPlaceholderKeepalive();
    },
  };
}
