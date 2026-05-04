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
  "当前会话支持企业微信 Bot WS 媒体发送（v2.8.19+ MEDIA 指令真正生效，群里直接收到附件）。",
  "当你需要发送图片、文件、视频或语音时，**必须在回复中单独一行**使用 `MEDIA:` 指令，后面跟本地文件路径。",
  "",
  "格式：`MEDIA: <绝对路径或 ~/ 开头的家目录路径>`",
  "示例（任选其一）：",
  "  MEDIA: /Users/jobzhao/.openclaw/media/outbound/foo.png",
  "  MEDIA: ~/.openclaw/media/outbound/report.pdf",
  "  MEDIA: ~/workspace/huo15-rustdesk-deploy.zip",
  "",
  "硬性要求：",
  "- `MEDIA:` 必须**整行单独**出现，前后可以有空格但不能与正文同行",
  "- 路径必须是**绝对路径**或 `~/` 开头（自动展开到当前用户 home），相对路径会失败",
  "- **任意文件大小都用本指令发**——包括几 KB 的小文件 zip/txt。不要 emit `📎 path` / `FILE: path` 等其他字面量约定（不会被识别）",
  "- 一次回复可以叠多行 `MEDIA:`，会按顺序依次发送，单个失败不影响后续",
  "- 媒体行抽出后，剩下的正文会按普通文本同时发出（如有）",
  "- 远程 URL（http/https）也支持，但优先用本地路径，远端拉取可能因防火墙/CDN 失败",
  "",
  "客观限制（企微侧）：",
  "- 图片/视频 > 10MB、语音 > 2MB、文件 > 20MB 可能会降级或失败 —— 此类大文件优先用 `enhance_share_file` 出公网下载链接",
  "- 语音消息仅原生支持 AMR；其他音频格式会按文件发送",
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
