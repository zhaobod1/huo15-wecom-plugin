import type { ResolvedAgentAccount } from "../../types/index.js";
import {
  downloadMedia as downloadLegacyMedia,
  getAccessToken as getLegacyAccessToken,
  sendMedia as sendLegacyMedia,
  sendMarkdown as sendLegacyMarkdown,
  sendText as sendLegacyText,
  sendTextcard as sendLegacyTextcard,
} from "./core.js";

export async function getAgentApiAccessToken(agent: ResolvedAgentAccount): Promise<string> {
  return getLegacyAccessToken(agent);
}

export async function sendAgentApiText(params: {
  agent: ResolvedAgentAccount;
  toUser?: string;
  toParty?: string;
  toTag?: string;
  chatId?: string;
  text: string;
}): Promise<void> {
  await sendLegacyText(params);
}

export async function sendAgentApiMarkdown(params: {
  agent: ResolvedAgentAccount;
  toUser?: string;
  toParty?: string;
  toTag?: string;
  chatId?: string;
  text: string;
}): Promise<void> {
  console.log(
    `[wecom-agent-api] sendMarkdown account=${params.agent.accountId} ` +
      `toUser=${params.toUser ?? ""} toParty=${params.toParty ?? ""} toTag=${params.toTag ?? ""} chatId=${params.chatId ?? ""} ` +
      `textLen=${params.text.length}`,
  );
  await sendLegacyMarkdown(params);
}

export async function sendAgentApiMedia(params: {
  agent: ResolvedAgentAccount;
  toUser?: string;
  toParty?: string;
  toTag?: string;
  chatId?: string;
  mediaId: string;
  mediaType: "image" | "voice" | "video" | "file";
  title?: string;
  description?: string;
}): Promise<void> {
  await sendLegacyMedia(params);
}

export async function downloadAgentApiMedia(params: {
  agent: ResolvedAgentAccount;
  mediaId: string;
  maxBytes?: number;
}): Promise<{ buffer: Buffer; contentType: string; filename?: string }> {
  return downloadLegacyMedia(params);
}

export async function sendAgentApiTextcard(params: {
  agent: ResolvedAgentAccount;
  toUser?: string;
  toParty?: string;
  toTag?: string;
  chatId?: string;
  title: string;
  description: string;
  url?: string;
  btntxt?: string;
}): Promise<void> {
  console.log(
    `[wecom-agent-api] sendTextcard account=${params.agent.accountId} ` +
      `toUser=${params.toUser ?? ""} toParty=${params.toParty ?? ""} toTag=${params.toTag ?? ""} chatId=${params.chatId ?? ""} ` +
      `title=${JSON.stringify(params.title)} descLen=${params.description.length}`,
  );
  await sendLegacyTextcard(params);
}
