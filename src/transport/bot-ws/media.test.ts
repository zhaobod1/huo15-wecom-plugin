import type { WSClient } from "@wecom/aibot-node-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/media-runtime";

import { uploadAndSendBotWsMedia } from "./media.js";

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  detectMime: vi.fn(),
  loadOutboundMediaFromUrl: vi.fn(),
}));

describe("uploadAndSendBotWsMedia", () => {
  const loadOutboundMediaFromUrlMock = vi.mocked(loadOutboundMediaFromUrl);

  beforeEach(() => {
    loadOutboundMediaFromUrlMock.mockReset();
    loadOutboundMediaFromUrlMock.mockResolvedValue({
      buffer: Buffer.from("png"),
      contentType: "image/png",
      fileName: "sample.png",
    } as never);
  });

  it("passes the configured maxBytes to outbound media loading", async () => {
    const wsClient = {
      uploadMedia: vi.fn().mockResolvedValue({ media_id: "media-1" }),
      sendMediaMessage: vi.fn().mockResolvedValue({ headers: { req_id: "req-1" } }),
    } as unknown as WSClient;

    await uploadAndSendBotWsMedia({
      wsClient,
      chatId: "hidao",
      mediaUrl: "https://example.com/sample.png",
      maxBytes: 42 * 1024 * 1024,
    });

    expect(loadOutboundMediaFromUrlMock).toHaveBeenCalledWith(
      "https://example.com/sample.png",
      expect.objectContaining({
        maxBytes: 42 * 1024 * 1024,
      }),
    );
  });
});
