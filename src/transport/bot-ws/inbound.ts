import type { BaseMessage, EventMessage, WsFrame } from "@wecom/aibot-node-sdk";

import { buildInboundBody } from "../bot-webhook/message-shape.js";
import type {
  ResolvedBotAccount,
  UnifiedInboundEvent,
  WecomBotInboundMessage,
  WecomInboundKind,
} from "../../types/index.js";

function resolveInboundKind(message: BaseMessage | EventMessage): WecomInboundKind {
  if (message.msgtype === "event") {
    const eventType = String((message as EventMessage).event?.eventtype ?? "").trim();
    if (eventType === "enter_chat") return "welcome";
    if (eventType === "template_card_event") return "template-card-event";
    return "event";
  }
  switch (message.msgtype) {
    case "image":
      return "image";
    case "file":
      return "file";
    case "voice":
      return "voice";
    case "mixed":
      return "mixed";
    default:
      return "text";
  }
}

function resolveEventText(message: BaseMessage | EventMessage, account: ResolvedBotAccount): string {
  if (message.msgtype !== "event") {
    return buildInboundBody(message as WecomBotInboundMessage);
  }

  const event = message as EventMessage;
  if (event.event?.eventtype === "enter_chat" && account.config.welcomeText) {
    return account.config.welcomeText;
  }
  return `[event:${String(event.event?.eventtype ?? "unknown")}]`;
}

/**
 * **extractQuoteAttachments (从引用消息中提取附件)**
 *
 * 处理带引用的消息（如回复文件/图片），从 quote 字段提取附件信息。
 * 修复问题：当用户发送文本消息引用一个文件时，该文件URL会被当作普通文本而不是下载附件。
 * 这导致AI访问该URL时已经过期。
 */
function extractQuoteAttachments(body: any): UnifiedInboundEvent["attachments"] {
  const quote = body?.quote;
  if (!quote) return undefined;

  const quoteMsgtype = String(quote.msgtype ?? "").toLowerCase();

  // 引用的是文件
  if (quoteMsgtype === "file" && quote.file?.url) {
    return [{ name: "file", remoteUrl: quote.file.url, aesKey: quote.file.aeskey }];
  }

  // 引用的是图片
  if (quoteMsgtype === "image" && quote.image?.url) {
    return [{ name: "image", remoteUrl: quote.image.url, aesKey: quote.image.aeskey }];
  }

  // 引用的是混合消息 (mixed)
  if (quoteMsgtype === "mixed" && Array.isArray(quote.mixed?.msg_item)) {
    const attachments: UnifiedInboundEvent["attachments"] = [];
    for (const item of quote.mixed.msg_item) {
      const itemType = String(item.msgtype ?? "").toLowerCase();
      if (itemType === "image" && item.image?.url) {
        attachments.push({ name: "image", remoteUrl: item.image.url, aesKey: item.image.aeskey });
      } else if (itemType === "file" && item.file?.url) {
        attachments.push({ name: "file", remoteUrl: item.file.url, aesKey: item.file.aeskey });
      }
    }
    return attachments.length > 0 ? attachments : undefined;
  }

  return undefined;
}

export function mapBotWsFrameToInboundEvent(params: {
  account: ResolvedBotAccount;
  frame: WsFrame<BaseMessage | EventMessage>;
}): UnifiedInboundEvent {
  const { account, frame } = params;
  const body = frame.body;
  if (!body) {
    throw new Error("Bot WS frame body is required");
  }
  const peerKind = body.chattype === "group" ? "group" : "direct";
  const senderId = body.from?.userid ?? "unknown";
  const peerId = peerKind === "group" ? body.chatid ?? senderId : senderId;
  const inboundKind = resolveInboundKind(body);

  let attachments: UnifiedInboundEvent["attachments"];
  if (body.msgtype === "image") {
    attachments = [{ name: "image", remoteUrl: (body as any).image?.url, aesKey: (body as any).image?.aeskey }];
  } else if (body.msgtype === "file") {
    attachments = [{ name: "file", remoteUrl: (body as any).file?.url, aesKey: (body as any).file?.aeskey }];
  } else if (body.msgtype === "mixed") {
    const items = (body as any).mixed?.msg_item;
    if (Array.isArray(items)) {
      attachments = [];
      for (const item of items) {
        if (item.msgtype === "image" && item.image?.url) {
          attachments.push({ name: "image", remoteUrl: item.image.url, aesKey: item.image.aeskey });
        } else if (item.msgtype === "file" && item.file?.url) {
          attachments.push({ name: "file", remoteUrl: item.file.url, aesKey: item.file.aeskey });
        }
      }
      if (attachments.length === 0) {
        attachments = undefined;
      }
    }
  }

  // 补充：从 quote 字段提取附件（修复引用文件URL过期问题）
  if (!attachments) {
    attachments = extractQuoteAttachments(body);
  }

  return {
    accountId: account.accountId,
    capability: "bot",
    transport: "bot-ws",
    inboundKind,
    messageId: body.msgid,
    conversation: {
      accountId: account.accountId,
      peerKind,
      peerId,
      senderId,
    },
    senderName: senderId,
    text: resolveEventText(body, account),
    timestamp: typeof body.create_time === "number" ? body.create_time : Date.now(),
    raw: {
      transport: "bot-ws",
      command: frame.cmd,
      headers: frame.headers,
      body,
      envelopeType: "ws",
    },
    replyContext: {
      transport: "bot-ws",
      accountId: account.accountId,
      reqId: frame.headers.req_id,
      raw: {
        transport: "bot-ws",
        command: frame.cmd,
        headers: frame.headers,
        body,
        envelopeType: "ws",
      },
    },
    attachments,
  };
}
