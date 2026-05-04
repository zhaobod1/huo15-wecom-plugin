import os from "node:os";
import path from "node:path";
import type { WSClient } from "@wecom/aibot-node-sdk";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/infra-runtime";
import { uploadAndReplyBotWsMedia } from "./media.js";
import { createBotWsReplyHandle } from "./reply.js";

vi.mock("./media.js", () => ({
  uploadAndReplyBotWsMedia: vi.fn(),
}));

type ReplyHandleParams = Parameters<typeof createBotWsReplyHandle>[0];

describe("createBotWsReplyHandle", () => {
  let mockClient: import("vitest").Mocked<WSClient>;
  const uploadAndReplyBotWsMediaMock = vi.mocked(uploadAndReplyBotWsMedia);

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubEnv("OPENCLAW_STATE_DIR", "/tmp/wecom-reply-state");
    mockClient = {
      replyStream: vi.fn(),
      sendMessage: vi.fn(),
      replyWelcome: vi.fn(),
      // v2.8.5 — simulate healthy WS connection so reply paths don't fallback to Agent API
      isConnected: true,
    } as unknown as import("vitest").Mocked<WSClient>;
    mockClient.replyStream.mockResolvedValue({} as any);
    mockClient.sendMessage.mockResolvedValue({} as any);
    mockClient.replyWelcome.mockResolvedValue({} as any);
    uploadAndReplyBotWsMediaMock.mockReset();
    uploadAndReplyBotWsMediaMock.mockResolvedValue({ ok: true, messageId: "media-1" } as any);
    const runtime = await import("../../runtime.js");
    runtime.setWecomRuntime({
      config: {
        loadConfig: () => ({
          channels: {
            wecom: {},
          },
        }),
      },
    } as any);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("uses configured placeholder content for immediate ws ack", async () => {
    createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-1" },
        body: { chatid: "123", chattype: "group" },
        cmd: "aibot_msg_callback",
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      placeholderContent: "正在思考...",
    });

    vi.advanceTimersByTime(3000);
    // Let promises flush
    await Promise.resolve();

    expect(mockClient.replyStream).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { req_id: "req-1" },
      }),
      expect.any(String),
      "正在思考...",
      false,
    );
  });

  it("keeps placeholder alive until the first real ws chunk arrives", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-keepalive" },
        body: {},
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      placeholderContent: "正在思考...",
    });

    vi.advanceTimersByTime(3000);
    // Flush the microtasks so `placeholderInFlight` becomes false
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // Now trigger the next timer
    vi.advanceTimersByTime(3000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);

    handle.deliver({ text: "最终回复", isReasoning: false }, { kind: "final" });
    await Promise.resolve();

    expect(mockClient.replyStream).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { req_id: "req-keepalive" },
      }),
      expect.any(String),
      "最终回复",
      true,
    );

    // Ensure interval is cleared
    vi.advanceTimersByTime(6000);
    await Promise.resolve();
    expect(mockClient.replyStream).toHaveBeenCalledTimes(3);
  });

  it("does not auto-send placeholder when disabled", async () => {
    createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-2" },
        body: {},
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    vi.advanceTimersByTime(3000);
    await Promise.resolve();
    expect(mockClient.replyStream).not.toHaveBeenCalled();
  });

  it("sends cumulative content for block streaming updates", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-blocks" },
        body: {},
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver({ text: "第一段", isReasoning: false }, { kind: "block" });
    await handle.deliver({ text: "第二段", isReasoning: false }, { kind: "block" });
    await handle.deliver({ text: "收尾", isReasoning: false }, { kind: "final" });

    expect(mockClient.replyStream).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ headers: { req_id: "req-blocks" } }),
      expect.any(String),
      "第一段",
      false,
    );
    expect(mockClient.replyStream).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ headers: { req_id: "req-blocks" } }),
      expect.any(String),
      "第一段\n第二段",
      false,
    );
    expect(mockClient.replyStream).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ headers: { req_id: "req-blocks" } }),
      expect.any(String),
      "第一段\n第二段\n收尾",
      true,
    );
  });

  it("streams block text even when media is deferred to final", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-block-media" },
        body: {},
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver(
      {
        text: "正文先发",
        mediaUrls: ["/tmp/a.png", "/tmp/b.png"],
        isReasoning: false,
      },
      { kind: "block" },
    );

    expect(mockClient.replyStream).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { req_id: "req-block-media" } }),
      expect.any(String),
      "正文先发",
      false,
    );
  });

  it("includes default global media local roots for final media sends", async () => {
    const runtime = await import("../../runtime.js");
    runtime.setWecomRuntime({
      config: {
        loadConfig: () => ({}),
      },
    } as any);

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-final-media-roots" },
        body: {
          from: { userid: "hidao" },
          chattype: "single",
        },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver(
      {
        mediaUrls: ["/Users/YanHaidao/Downloads/01.png"],
        isReasoning: false,
      },
      { kind: "final" },
    );

    expect(uploadAndReplyBotWsMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        frame: expect.objectContaining({ headers: { req_id: "req-final-media-roots" } }),
        maxBytes: 80 * 1024 * 1024,
        mediaUrl: "/Users/YanHaidao/Downloads/01.png",
        mediaLocalRoots: expect.arrayContaining([
          path.resolve(resolvePreferredOpenClawTmpDir()),
          "/tmp/wecom-reply-state",
          "/tmp/wecom-reply-state/media",
          path.resolve(os.homedir(), "Desktop"),
          path.resolve(os.homedir(), "Documents"),
          path.resolve(os.homedir(), "Downloads"),
        ]),
      }),
    );
    expect(mockClient.replyStream).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { req_id: "req-final-media-roots" } }),
      expect.any(String),
      "文件已发送。",
      true,
    );
  });

  it("passes configured mediaMaxMb to final media sends", async () => {
    const runtime = await import("../../runtime.js");
    runtime.setWecomRuntime({
      config: {
        loadConfig: () => ({
          agents: {
            defaults: {
              mediaMaxMb: 12,
            },
          },
          channels: {
            wecom: {
              mediaMaxMb: 24,
              accounts: {
                default: {
                  mediaMaxMb: 40,
                },
              },
            },
          },
        }),
      },
    } as any);

    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-final-media-max-bytes" },
        body: {
          from: { userid: "hidao" },
          chattype: "single",
        },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver(
      {
        mediaUrls: ["/Users/YanHaidao/Downloads/01.png"],
        isReasoning: false,
      },
      { kind: "final" },
    );

    expect(uploadAndReplyBotWsMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        frame: expect.objectContaining({ headers: { req_id: "req-final-media-max-bytes" } }),
        maxBytes: 40 * 1024 * 1024,
      }),
    );
  });

  it("stops placeholder keepalive when the first block contains media", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-placeholder-media" },
        body: {},
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      placeholderContent: "正在思考...",
    });

    vi.advanceTimersByTime(3000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);

    await handle.deliver(
      {
        text: "正文先发",
        mediaUrls: ["/tmp/a.png"],
        isReasoning: false,
      },
      { kind: "block" },
    );

    vi.advanceTimersByTime(6000);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(mockClient.replyStream).toHaveBeenCalledTimes(2);
    expect(mockClient.replyStream).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ headers: { req_id: "req-placeholder-media" } }),
      expect.any(String),
      "正文先发",
      false,
    );
  });

  // v2.8.17 ⭐ 长任务结果回流修复：reqId 失效 / 流过期不再短路 onFail，
  // 改为走 sendMessage 主动推送 fallback。详见 changelog/v2.8.17.md
  it.each([
    [
      "stream-expired",
      {
        headers: { req_id: "req-expired" },
        errcode: 846608,
        errmsg: "stream message update expired (>6 minutes), cannot update",
      },
    ],
    [
      "invalid-req-id",
      {
        headers: { req_id: "req-invalid" },
        errcode: 846605,
        errmsg: "invalid req_id",
      },
    ],
  ])(
    "falls back to active push when reply channel is closed by %s during final delivery",
    async (_label, replyChannelError) => {
      mockClient.replyStream.mockRejectedValueOnce(replyChannelError);
      const onFail = vi.fn();
      const onDeliver = vi.fn();

      const handle = createBotWsReplyHandle({
        client: mockClient,
        frame: {
          headers: { req_id: String(replyChannelError.headers.req_id) },
          body: { from: { userid: "alice" }, chattype: "single" },
        } as unknown as ReplyHandleParams["frame"],
        accountId: "default",
        inboundKind: "text",
        autoSendPlaceholder: false,
        onFail,
        onDeliver,
      });

      await handle.deliver({ text: "最终回复", isReasoning: false }, { kind: "final" });

      // 1) tried replyStream once, got reply-channel-closed error
      expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
      // 2) fell back to sendMessage active push so the result actually reaches the user
      expect(mockClient.sendMessage).toHaveBeenCalledWith(
        "alice",
        expect.objectContaining({
          msgtype: "markdown_v2",
          markdown_v2: expect.objectContaining({ content: "最终回复" }),
        }),
      );
      // 3) onDeliver fired (success), onFail NOT fired (the bug we just fixed)
      expect(onDeliver).toHaveBeenCalled();
      expect(onFail).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ headers: { req_id: "req-invalid" }, errcode: 846605, errmsg: "invalid req_id" }],
    [
      {
        headers: { req_id: "req-expired" },
        errcode: 846608,
        errmsg: "stream message update expired (>6 minutes), cannot update",
      },
    ],
  ])("does not retry error reply when the ws reply window is already closed", async (error) => {
    const onFail = vi.fn();
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: String(error.headers.req_id) },
        body: {},
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
      onFail,
    });

    await handle.fail?.(error);

    expect(mockClient.replyStream).not.toHaveBeenCalled();
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it("sends simple fallback message for ordinary events without placeholders", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "event_req" },
        body: { chattype: "single", from: { userid: "alice" } },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "event",
    });

    vi.advanceTimersByTime(3000);
    await Promise.resolve();
    // Events should not send stream placeholders
    expect(mockClient.replyStream).not.toHaveBeenCalled();

    handle.deliver({ text: "Event Reply", isReasoning: false }, { kind: "final" });
    await Promise.resolve();

    expect(mockClient.sendMessage).toHaveBeenCalledWith("alice", {
      msgtype: "markdown_v2",
      markdown_v2: { content: "Event Reply" },
    });
  });

  it("sends replyWelcome for welcome events", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "welcome_req" },
        body: { chattype: "single", from: { userid: "bob" } },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "welcome",
    });

    handle.deliver({ text: "Hello Bob", isReasoning: false }, { kind: "final" });
    await Promise.resolve();

    expect(mockClient.replyWelcome).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { req_id: "welcome_req" } }),
      {
        msgtype: "text",
        text: { content: "Hello Bob" },
      },
    );
  });

  // ── v2.8.17 progressMode tests ──

  it("progressMode=off never sends a placeholder, even after long wait", async () => {
    createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-progress-off" },
        body: {},
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      progressMode: "off",
    });
    vi.advanceTimersByTime(120_000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(mockClient.replyStream).not.toHaveBeenCalled();
  });

  it("progressMode=delayed stays silent until progressDelayedMs, then fires once", async () => {
    createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-progress-delayed" },
        body: {},
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      progressMode: "delayed",
      progressDelayedMs: 5_000,
    });

    // 4s — still silent
    vi.advanceTimersByTime(4_000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(mockClient.replyStream).not.toHaveBeenCalled();

    // 6s — fired exactly once
    vi.advanceTimersByTime(2_000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);

    // 16s+ — still only one (no looping)
    vi.advanceTimersByTime(10_000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(mockClient.replyStream).toHaveBeenCalledTimes(1);
  });

  it("progressMode=heartbeat uses the legacy fixed text on every keepalive tick", async () => {
    createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-progress-heartbeat" },
        body: {},
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      progressMode: "heartbeat",
    });
    vi.advanceTimersByTime(0);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    vi.advanceTimersByTime(3_000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    vi.advanceTimersByTime(3_000);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(mockClient.replyStream.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of mockClient.replyStream.mock.calls) {
      // every keepalive tick uses the same legacy text
      expect(call[2]).toBe("⏳ 正在思考中...\n\n");
    }
  });

  it("progressMode=progress (default) escalates placeholder text as elapsed time crosses tiers", async () => {
    const flush = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };

    createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-progress-progress" },
        body: {},
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      // progressMode default → "progress"
    });

    // 推进 130s（>120s 安全边界），每 3s flush 一次让 placeholderInFlight 释放
    // 否则一次性推进会让 keepalive 锁住，后续 tick 全 skip
    await flush();
    for (let i = 0; i < 50; i++) {
      vi.advanceTimersByTime(3_000);
      await flush();
    }

    const allTexts = mockClient.replyStream.mock.calls.map((c) => String(c[2]));
    // 阶段化文案应该都出现过（不强约束顺序，避免 timer 触发顺序变更带来的脆弱性）
    expect(allTexts.some((t) => t.includes("正在思考中"))).toBe(true);
    expect(allTexts.some((t) => t.includes("仍在处理中"))).toBe(true);
    expect(allTexts.some((t) => t.includes("任务较复杂"))).toBe(true);
    expect(allTexts.some((t) => t.includes("完成后会主动推送结果"))).toBe(true);
  });

  it("explicit placeholderContent overrides progressMode escalation (legacy behaviour preserved)", async () => {
    createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-override" },
        body: {},
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      placeholderContent: "Custom 等等...",
      progressMode: "progress",
    });
    vi.advanceTimersByTime(0);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    vi.advanceTimersByTime(40_000);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    for (const call of mockClient.replyStream.mock.calls) {
      // override always wins regardless of elapsed time
      expect(call[2]).toBe("Custom 等等...");
    }
  });

  // ── v2.8.20 — MEDIA: 指令在 reply 路径接管（修群里发 zip 失败事故的真根因）─────
  it("v2.8.20: extracts MEDIA: directive from final text and triggers media upload via reply channel", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-media-directive" },
        body: { from: { userid: "ZhaoBo" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    // LLM 模拟输出：含 MEDIA: 单行指令 + 普通正文
    await handle.deliver(
      {
        text: "📎\n\nMEDIA: /tmp/zhaobo-test.zip",
        isReasoning: false,
      },
      { kind: "final" },
    );

    // uploadAndReplyBotWsMedia 被调用（reply 路径绑 reqId 走 aibot_respond_msg）
    expect(uploadAndReplyBotWsMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        frame: expect.objectContaining({ headers: { req_id: "req-media-directive" } }),
        mediaUrl: "/tmp/zhaobo-test.zip",
      }),
    );
    // 残余文本（"📎"）走 replyStream 作为 final
    expect(mockClient.replyStream).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { req_id: "req-media-directive" } }),
      expect.any(String),
      expect.stringContaining("📎"),
      true,
    );
  });

  it("v2.8.20: MEDIA: directive in block payload defers media to final, accumulates correctly", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-media-block" },
        body: { from: { userid: "ZhaoBo" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    // 第一个 block 含 MEDIA: 行
    await handle.deliver(
      { text: "请查收：\nMEDIA: /tmp/a.pdf", isReasoning: false },
      { kind: "block" },
    );
    // 第二个 block 普通文本
    await handle.deliver({ text: "完成", isReasoning: false }, { kind: "block" });
    // final 不带新 text
    await handle.deliver({ text: "", isReasoning: false }, { kind: "final" });

    // media 在 final 时一起发（deferredMediaUrls 累积起作用）
    expect(uploadAndReplyBotWsMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "/tmp/a.pdf",
      }),
    );
  });

  it("v2.8.20: multiple MEDIA: directives in one final payload all get uploaded", async () => {
    const handle = createBotWsReplyHandle({
      client: mockClient,
      frame: {
        headers: { req_id: "req-media-multi" },
        body: { from: { userid: "ZhaoBo" }, chattype: "single" },
      } as unknown as ReplyHandleParams["frame"],
      accountId: "default",
      inboundKind: "text",
      autoSendPlaceholder: false,
    });

    await handle.deliver(
      {
        text: "三个文件：\nMEDIA: /tmp/1.pdf\nMEDIA: /tmp/2.zip\nMEDIA: /tmp/3.png",
        isReasoning: false,
      },
      { kind: "final" },
    );

    const allMediaCalls = uploadAndReplyBotWsMediaMock.mock.calls.map(
      (c) => (c[0] as { mediaUrl: string }).mediaUrl,
    );
    expect(allMediaCalls).toEqual(["/tmp/1.pdf", "/tmp/2.zip", "/tmp/3.png"]);
  });
});
