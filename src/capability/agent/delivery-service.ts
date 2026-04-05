import type { ResolvedAgentAccount } from "../../types/index.js";
import { resolveScopedWecomTarget } from "../../target.js";
import { deliverAgentApiMedia, deliverAgentApiMarkdown, deliverAgentApiText, deliverAgentApiTextcard } from "../../transport/agent-api/delivery.js";
import { canUseAgentApiDelivery } from "./fallback-policy.js";
import { getWecomRuntime } from "../../runtime.js";

export class WecomAgentDeliveryService {
  constructor(private readonly agent: ResolvedAgentAccount) { }

  assertAvailable(): void {
    if (!canUseAgentApiDelivery(this.agent)) {
      throw new Error(
        `WeCom outbound requires channels.wecom.accounts.<accountId>.agent.agentId (or legacy channels.wecom.agent.agentId) for account=${this.agent.accountId}.`,
      );
    }
  }

  resolveTargetOrThrow(to: string | undefined) {
    const scoped = resolveScopedWecomTarget(to, this.agent.accountId);
    if (!scoped) {
      console.error(`[wecom-agent-delivery] missing target account=${this.agent.accountId}`);
      throw new Error("WeCom outbound requires a target (userid, partyid, tagid or chatid).");
    }
    if (scoped.accountId && scoped.accountId !== this.agent.accountId) {
      console.error(
        `[wecom-agent-delivery] account mismatch current=${this.agent.accountId} targetAccount=${scoped.accountId} raw=${String(to ?? "")}`,
      );
      throw new Error(
        `WeCom outbound account mismatch: target belongs to account=${scoped.accountId}, current account=${this.agent.accountId}.`,
      );
    }
    const target = scoped.target;
    if (target.chatid) {
      console.warn(
        `[wecom-agent-delivery] blocked chat target account=${this.agent.accountId} chatId=${target.chatid}`,
      );
      throw new Error(
        `企业微信（WeCom）Agent 主动发送不支持向群 chatId 发送（chatId=${target.chatid}）。` +
        `该路径在实际环境中经常失败（例如 86008：无权限访问该会话/会话由其他应用创建）。` +
        `请改为发送给用户（userid / user:xxx），或由 Bot 模式在群内交付。`,
      );
    }
    return target;
  }

  async sendText(params: { to: string | undefined; text: string }): Promise<void> {
    this.assertAvailable();
    const target = this.resolveTargetOrThrow(params.to);
    console.log(
      `[wecom-agent-delivery] sendText account=${this.agent.accountId} to=${String(params.to ?? "")} len=${params.text.length}`,
    );

    const runtime = getWecomRuntime();
    const chunks = runtime.channel.text.chunkText(params.text, 2048);

    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      await deliverAgentApiText({
        agent: this.agent,
        target,
        text: chunk,
      });
    }
  }

  async sendMarkdown(params: { to: string | undefined; text: string }): Promise<void> {
    this.assertAvailable();
    const target = this.resolveTargetOrThrow(params.to);
    console.log(
      `[wecom-agent-delivery] sendMarkdown account=${this.agent.accountId} to=${String(params.to ?? "")} len=${params.text.length}`,
    );
    await deliverAgentApiMarkdown({
      agent: this.agent,
      target,
      text: params.text,
    });
  }

  async sendMedia(params: {
    to: string | undefined;
    text?: string;
    buffer: Buffer;
    filename: string;
    contentType: string;
  }): Promise<void> {
    this.assertAvailable();
    const target = this.resolveTargetOrThrow(params.to);
    console.log(
      `[wecom-agent-delivery] sendMedia account=${this.agent.accountId} to=${String(params.to ?? "")} filename=${params.filename} contentType=${params.contentType}`,
    );
    await deliverAgentApiMedia({
      agent: this.agent,
      target,
      buffer: params.buffer,
      filename: params.filename,
      contentType: params.contentType,
      text: params.text,
    });
  }

  async sendTextcard(params: {
    to: string | undefined;
    title: string;
    description: string;
    url?: string;
    btntxt?: string;
  }): Promise<void> {
    this.assertAvailable();
    const target = this.resolveTargetOrThrow(params.to);
    console.log(
      `[wecom-agent-delivery] sendTextcard account=${this.agent.accountId} to=${String(params.to ?? "")} title=${params.title} descLen=${params.description.length}`,
    );
    await deliverAgentApiTextcard({
      agent: this.agent,
      target,
      title: params.title,
      description: params.description,
      url: params.url,
      btntxt: params.btntxt,
    });
  }
}
