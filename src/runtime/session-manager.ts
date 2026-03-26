import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import type { WecomMediaService } from "../shared/media-service.js";
import type { UnifiedInboundEvent } from "../types/index.js";
import { getPeerContextToken } from "../context-store.js";
import { buildWecomContextTarget } from "../target.js";
import { resolveRuntimeRoute } from "./routing-bridge.js";
import { registerWecomSourceSnapshot } from "./source-registry.js";

export type PreparedSession = {
  route: ReturnType<typeof resolveRuntimeRoute>;
  ctx: ReturnType<PluginRuntime["channel"]["reply"]["finalizeInboundContext"]>;
  storePath: string;
};

export async function prepareInboundSession(params: {
  core: PluginRuntime;
  cfg: OpenClawConfig;
  event: UnifiedInboundEvent;
  mediaService: WecomMediaService;
}): Promise<PreparedSession> {
  const { core, cfg, event, mediaService } = params;
  const route = resolveRuntimeRoute({ core, cfg, event });
  if (event.transport === "bot-ws") {
    registerWecomSourceSnapshot({
      accountId: event.accountId,
      source: "bot-ws",
      messageId: event.messageId,
      sessionKey: route.sessionKey,
    });
  }
  const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "WeCom",
    from: `${event.conversation.peerKind}:${event.conversation.peerId}`,
    previousTimestamp,
    envelope: envelopeOptions,
    body: event.text,
  });

  const firstAttachment = await mediaService.normalizeFirstAttachment(event);
  const mediaPath = firstAttachment
    ? await mediaService.saveInboundAttachment(event, firstAttachment)
    : undefined;
  const defaultOriginatingTo =
    event.conversation.peerKind === "group"
      ? `wecom:group:${event.conversation.peerId}`
      : `wecom:user:${event.conversation.peerId}`;
  const contextToken =
    event.transport === "bot-ws"
      ? getPeerContextToken(event.accountId, event.conversation.peerId)
      : undefined;
  const originatingTo = contextToken
    ? buildWecomContextTarget(contextToken)
    : defaultOriginatingTo;
  const providerContext =
    event.transport === "bot-ws"
      ? {}
      : {
          Provider: "wecom" as const,
        };

  const ctx = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: event.text,
    CommandBody: event.text,
    From:
      event.conversation.peerKind === "group"
        ? `wecom:group:${event.conversation.peerId}`
        : `wecom:user:${event.conversation.senderId}`,
    To:
      event.conversation.peerKind === "group"
        ? `wecom:group:${event.conversation.peerId}`
        : `wecom:user:${event.conversation.peerId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: event.conversation.peerKind,
    ConversationLabel: `${event.conversation.peerKind}:${event.conversation.peerId}`,
    SenderName: event.senderName ?? event.conversation.senderId,
    SenderId: event.conversation.senderId,
    // Bot WS replies need to go through origin routing so outbound can use the
    // live WS handle and context target. Exposing Provider/Surface as "wecom"
    // makes OpenClaw treat the current turn as already on that surface and it
    // suppresses shouldRouteToOriginating.
    ...providerContext,
    OriginatingChannel: "wecom",
    OriginatingTo: originatingTo,
    MessageSid: event.messageId,
    CommandAuthorized: true,
    MediaPath: mediaPath,
    MediaUrl: mediaPath,
    MediaType: firstAttachment?.contentType,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctx.SessionKey ?? route.sessionKey,
    ctx,
    onRecordError: () => {},
  });

  return { route, ctx, storePath };
}
