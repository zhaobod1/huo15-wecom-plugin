import type { PluginRuntime } from "openclaw/plugin-sdk";
import { clearWecomSourceAccount } from "../runtime/source-registry.js";
import { WecomAccountRuntime } from "./account-runtime.js";

let runtime: PluginRuntime | null = null;
const runtimes = new Map<string, WecomAccountRuntime>();
const botWsPushHandles = new Map<string, BotWsPushHandle>();

export type BotWsPushHandle = {
  isConnected: () => boolean;
  sendMarkdown: (chatId: string, content: string) => Promise<void>;
  replyCommand: (params: {
    cmd: string;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
  }) => Promise<Record<string, unknown>>;
  sendMedia: (params: {
    chatId: string;
    mediaUrl: string;
    text?: string;
    mediaLocalRoots?: readonly string[];
  }) => Promise<{
    ok: boolean;
    messageId?: string;
    rejected?: boolean;
    rejectReason?: string;
    error?: string;
  }>;
};

export function setWecomRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getWecomRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("WeCom runtime not initialized");
  }
  return runtime;
}

export function registerAccountRuntime(accountRuntime: WecomAccountRuntime): void {
  runtimes.set(accountRuntime.account.accountId, accountRuntime);
  console.log(`[wecom-runtime] register account=${accountRuntime.account.accountId}`);
}

export function getAccountRuntime(accountId: string): WecomAccountRuntime | undefined {
  return runtimes.get(accountId);
}

export function getAccountRuntimeSnapshot(accountId: string) {
  return runtimes.get(accountId)?.buildRuntimeStatus();
}

export function registerBotWsPushHandle(accountId: string, handle: BotWsPushHandle): void {
  botWsPushHandles.set(accountId, handle);
}

export function getBotWsPushHandle(accountId: string): BotWsPushHandle | undefined {
  return botWsPushHandles.get(accountId);
}

export function unregisterBotWsPushHandle(accountId: string): void {
  botWsPushHandles.delete(accountId);
}

export function unregisterAccountRuntime(accountId: string): void {
  runtimes.delete(accountId);
  botWsPushHandles.delete(accountId);
  clearWecomSourceAccount(accountId);
  console.log(`[wecom-runtime] unregister account=${accountId}`);
}
