import { describe, expect, it } from "vitest";

import { mapBotWsFrameToInboundEvent } from "./inbound.js";
import type { ResolvedBotAccount } from "../../types/index.js";

function createBotAccount(): ResolvedBotAccount {
  return {
    accountId: "haidao",
    configured: true,
    primaryTransport: "ws",
    wsConfigured: true,
    webhookConfigured: false,
    config: {},
    ws: {
      botId: "bot-id",
      secret: "secret",
    },
    token: "",
    encodingAESKey: "",
    receiveId: "",
    botId: "bot-id",
    secret: "secret",
  };
}

describe("mapBotWsFrameToInboundEvent", () => {
  it("includes quote content in text events", () => {
    const event = mapBotWsFrameToInboundEvent({
      account: createBotAccount(),
      frame: {
        cmd: "aibot_msg_callback",
        headers: { req_id: "req-1" },
        body: {
          msgid: "msg-1",
          msgtype: "text",
          chattype: "group",
          chatid: "group-1",
          from: { userid: "user-1" },
          text: { content: "@daodao 这个线索价值" },
          quote: {
            msgtype: "text",
            text: { content: "原始引用内容" },
          },
        },
      },
    });

    expect(event.text).toBe("@daodao 这个线索价值\n\n> 原始引用内容");
  });

  it("extracts attachments from mixed events", () => {
    const event = mapBotWsFrameToInboundEvent({
      account: createBotAccount(),
      frame: {
        cmd: "aibot_msg_callback",
        headers: { req_id: "req-2" },
        body: {
          msgid: "msg-2",
          msgtype: "mixed",
          chattype: "group",
          chatid: "group-2",
          from: { userid: "user-2" },
          mixed: {
            msg_item: [
              {
                msgtype: "text",
                text: { content: "来看看这张图" },
              },
              {
                msgtype: "image",
                image: { url: "https://example.com/image.jpg", aeskey: "mock-aes-key" },
              },
              {
                msgtype: "file",
                file: { url: "https://example.com/doc.pdf", aeskey: "mock-file-key" },
              },
            ],
          },
        },
      },
    });

    expect(event.attachments).toBeDefined();
    expect(event.attachments).toHaveLength(2);
    expect(event.attachments![0]).toEqual({
      name: "image",
      remoteUrl: "https://example.com/image.jpg",
      aesKey: "mock-aes-key",
    });
    expect(event.attachments![1]).toEqual({
      name: "file",
      remoteUrl: "https://example.com/doc.pdf",
      aesKey: "mock-file-key",
    });
  });
});
