/**
 * Author: YanHaidao / 火一五定制版
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
// import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { registerWecomCalendarTools } from "./src/capability/calendar/tool.js";
import { registerWecomDocTools } from "./src/capability/doc/tool.js";
import { createWeComMcpToolFactory } from "./src/capability/mcp/index.js";
import { wecomPlugin } from "./src/channel.js";
import { handleWecomWebhookRequest } from "./src/monitor.js";
import { setWecomRuntime } from "./src/runtime.js";
import { isWecomBotWsSource } from "./src/runtime/source-registry.js";

const WECOM_BOT_WS_MEDIA_GUIDANCE = [
  "【WeCom Bot WS 媒体发送】",
  "当前会话支持企业微信 Bot WS 媒体发送（v2.8.20+ MEDIA 指令在群+DM 都已实装）。",
  "当你需要发送图片、文件、视频或语音时，**必须把 `MEDIA:` 指令独立成一行**，后面跟本地文件路径。",
  "",
  "✅ **正确示例**（MEDIA: 行前面有空行，独立成行）：",
  "```",
  "你要的文件已经准备好。",
  "",
  "MEDIA: ~/.openclaw/media/outbound/report.pdf",
  "```",
  "",
  "❌ **错误示例**（不要这样写，parser 抽不出来）：",
  "- `📎 MEDIA: ~/foo.zip`        ← 行首有 emoji",
  "- `请查收 MEDIA: ~/foo.zip`     ← 行首有正文",
  "- `MEDIA: ~/foo.zip 已发送`     ← 路径后面有正文",
  "- `> MEDIA: ~/foo.zip`         ← markdown 引用 / 列表前缀",
  "- `\"MEDIA: ~/foo.zip\"`        ← 整体被括号/引号/反引号包住（`MEDIA:` 必须是行首关键字，引号会被剥离但需要在路径上而不是整行）",
  "",
  "硬性要求：",
  "- `MEDIA:` 必须是**整行的开头**，前面只能有纯空白（自动 trim），后面只能有路径",
  "- 路径必须是**绝对路径**或 `~/` 开头（自动展开到当前用户 home），相对路径会失败",
  "- **任意文件大小都用本指令发**——包括几 KB 的小文件 zip/txt。不要 emit `📎 path` / `FILE: path` 等其他字面量约定（不会被识别）",
  "- 一次回复可以叠多行 `MEDIA:`（每行独立），按顺序依次发送，单个失败不影响后续",
  "- 媒体行抽出后，剩下的正文会按普通文本同时发出（如有）",
  "- 远程 URL（http/https）也支持，但优先用本地路径，远端拉取可能因防火墙/CDN 失败",
  "",
  "客观限制（企微侧）：",
  "- 图片/视频 > 10MB、语音 > 2MB、文件 > 20MB 自动走 share-fallback（落盘 + 公网下载链接发到群）",
  "- 群是其他企微应用创建的（非本机器人自建群）→ 文件可能撞 errcode 86008，自动降级到 share-fallback 链接（仍能在群里看到下载地址）",
  "- 语音消息仅原生支持 AMR；其他音频格式会按文件发送",
  "",
  "如果你拿不准用 MEDIA: 还是 `enhance_share_file`：群里 ≤ 20MB 的文件优先 MEDIA:（直接附件最佳 UX），> 20MB 或不确定大小用 `enhance_share_file`（链接更稳）。",
].join("\n");

// ── 插件配置 Schema（tips/pet 已移除）──
const wecomPluginConfigSchema = {
  type: "object" as const,
  properties: {},
};

const plugin = {
  id: "wecom",
  name: "WeCom (企业微信)",
  description: "企业微信官方推荐三方插件，默认 Bot WS，支持主动发消息与统一运行时能力，火一五定制版",
  configSchema: wecomPluginConfigSchema,
  /**
   * **register (注册插件)**
   *
   * OpenClaw 插件入口点。
   * 1. 注入统一 runtime compatibility layer。
   * 2. 注册 capability-first WeCom 渠道插件。
   * 3. 注册统一 HTTP 入口（所有 webhook 请求都走共享路由器）。
   */
  register(api: OpenClawPluginApi) {
    setWecomRuntime(api.runtime);
    api.registerChannel({ plugin: wecomPlugin });
    const routes = ["/plugins/wecom", "/wecom"];
    for (const path of routes) {
      api.registerHttpRoute({
        path,
        handler: handleWecomWebhookRequest,
        auth: "plugin",
        match: "prefix",
      });
    }

    // Register WeCom Doc Tools
    registerWecomDocTools(api);
    registerWecomCalendarTools(api);
    api.registerTool(createWeComMcpToolFactory(), { name: "wecom_mcp" });

    api.on("before_prompt_build", (_event, ctx) => {
      if (ctx.channelId !== "wecom") {
        return;
      }
      if (
        !isWecomBotWsSource({
          sessionKey: ctx.sessionKey,
          sessionId: ctx.sessionId,
        })
      ) {
        return;
      }
      return {
        appendSystemContext: WECOM_BOT_WS_MEDIA_GUIDANCE,
      };
    });

    // [已移除] 小贴士+火苗宠物模块 — 导致企微不回复
  },
};

export default plugin;
