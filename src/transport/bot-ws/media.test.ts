import type { WSClient } from "@wecom/aibot-node-sdk";
import { fetchRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uploadAndSendBotWsMedia } from "./media.js";

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  assertLocalMediaAllowed: vi.fn(),
  detectMime: vi.fn(),
  fetchRemoteMedia: vi.fn(),
}));

describe("uploadAndSendBotWsMedia", () => {
  const fetchRemoteMediaMock = vi.mocked(fetchRemoteMedia);

  beforeEach(() => {
    fetchRemoteMediaMock.mockReset();
    fetchRemoteMediaMock.mockResolvedValue({
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

    expect(fetchRemoteMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/sample.png",
        maxBytes: 42 * 1024 * 1024,
      }),
    );
  });
});
