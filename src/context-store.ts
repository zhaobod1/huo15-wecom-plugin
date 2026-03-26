/**
 * Context store for WeCom Bot WS proactive push.
 *
 * Similar to Weixin's contextToken mechanism, we need to track:
 * - Which accountId has active sessions with which peerId
 * - The contextToken for routing outbound messages
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Simple logger
const logger = {
  info: (...args: unknown[]) => console.log('[wecom-context]', ...args),
  warn: (...args: unknown[]) => console.warn('[wecom-context]', ...args),
  debug: (...args: unknown[]) => process.env.DEBUG && console.log('[wecom-context]', ...args),
};

type PeerKind = "direct" | "group";

type StoredPeerContext = {
  contextToken: string;
  peerKind: PeerKind;
  lastSeen: number;
};

type ResolvedPeerContext = StoredPeerContext & {
  accountId: string;
  peerId: string;
};

// In-memory store: accountId -> peerId -> context info
const peerContextStore = new Map<string, Map<string, StoredPeerContext>>();

// Reverse lookup: peerId -> accountId (for routing outbound)
const peerToAccountMap = new Map<string, string>();
const contextTokenToPeerMap = new Map<string, ResolvedPeerContext>();

function resolveStateDir(): string {
  return process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME || "/tmp", ".openclaw");
}

function resolveContextFilePath(accountId: string): string {
  return path.join(
    resolveStateDir(),
    "wecom",
    "context",
    `${accountId}.json`
  );
}

/** Persist peer contexts for an account to disk */
function persistContexts(accountId: string): void {
  const peerMap = peerContextStore.get(accountId);
  if (!peerMap) return;

  const data: Record<string, StoredPeerContext> = {};
  for (const [peerId, info] of peerMap) {
    data[peerId] = info;
  }

  const filePath = resolveContextFilePath(accountId);
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 0), "utf-8");
  } catch (err) {
    logger.warn?.(`persistContexts: failed to write ${filePath}: ${String(err)}`);
  }
}

function normalizeContextToken(value: unknown): string | undefined {
  const token = typeof value === "string" ? value.trim() : "";
  return token || undefined;
}

function normalizePeerKind(value: unknown): PeerKind {
  return value === "group" ? "group" : "direct";
}

function registerPeerContext(accountId: string, peerId: string, info: StoredPeerContext): void {
  let peerMap = peerContextStore.get(accountId);
  if (!peerMap) {
    peerMap = new Map();
    peerContextStore.set(accountId, peerMap);
  }

  const previous = peerMap.get(peerId);
  if (previous?.contextToken && previous.contextToken !== info.contextToken) {
    contextTokenToPeerMap.delete(previous.contextToken);
  }

  peerMap.set(peerId, info);
  peerToAccountMap.set(peerId, accountId);
  contextTokenToPeerMap.set(info.contextToken, {
    accountId,
    peerId,
    ...info,
  });
}

function resolveStoredPeerContext(
  accountId: string,
  peerId: string,
  params: {
    contextToken?: string;
    peerKind?: PeerKind;
    lastSeen?: number;
  },
): StoredPeerContext {
  const existing = peerContextStore.get(accountId)?.get(peerId);
  return {
    contextToken:
      normalizeContextToken(params.contextToken) ??
      existing?.contextToken ??
      randomUUID(),
    peerKind: params.peerKind ?? existing?.peerKind ?? "direct",
    lastSeen: params.lastSeen ?? Date.now(),
  };
}

/** Restore persisted peer contexts for an account */
export function restorePeerContexts(accountId: string): void {
  const filePath = resolveContextFilePath(accountId);
  try {
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as Record<
      string,
      {
        contextToken?: string;
        peerKind?: string;
        lastSeen?: number;
      }
    >;

    const peerMap = new Map<string, StoredPeerContext>();
    let count = 0;
    let mutated = false;
    for (const [peerId, info] of Object.entries(data)) {
      const normalized: StoredPeerContext = {
        contextToken: normalizeContextToken(info?.contextToken) ?? randomUUID(),
        peerKind: normalizePeerKind(info?.peerKind),
        lastSeen:
          typeof info?.lastSeen === "number" && Number.isFinite(info.lastSeen)
            ? info.lastSeen
            : Date.now(),
      };
      peerMap.set(peerId, normalized);
      peerToAccountMap.set(peerId, accountId);
      contextTokenToPeerMap.set(normalized.contextToken, {
        accountId,
        peerId,
        ...normalized,
      });
      if (
        normalized.contextToken !== info?.contextToken ||
        normalized.peerKind !== info?.peerKind ||
        normalized.lastSeen !== info?.lastSeen
      ) {
        mutated = true;
      }
      count++;
    }
    peerContextStore.set(accountId, peerMap);
    if (mutated) {
      persistContexts(accountId);
    }
    logger.info?.(`restorePeerContexts: restored ${count} peers for account=${accountId}`);
  } catch (err) {
    logger.warn?.(`restorePeerContexts: failed to read ${filePath}: ${String(err)}`);
  }
}

/** Store context for a peer (called on inbound message) */
export function setPeerContext(
  accountId: string,
  peerId: string,
  options?: {
    contextToken?: string;
    peerKind?: PeerKind;
    lastSeen?: number;
  },
): string {
  const resolved = resolveStoredPeerContext(accountId, peerId, options ?? {});
  registerPeerContext(accountId, peerId, resolved);

  // Persist to disk (debounced would be better, but simple for now)
  persistContexts(accountId);

  logger.debug?.(
    `setPeerContext: accountId=${accountId} peerId=${peerId} token=${resolved.contextToken} kind=${resolved.peerKind}`,
  );
  return resolved.contextToken;
}

/** Get the accountId that has an active session with a peer */
export function getAccountIdByPeer(peerId: string): string | undefined {
  return peerToAccountMap.get(peerId);
}

/** Get the most recent peerId for an account (for proactive push) */
export function getRecentPeerForAccount(accountId: string, maxAgeMs = 30 * 60 * 1000): string | undefined {
  const peerMap = peerContextStore.get(accountId);
  if (!peerMap) return undefined;

  let mostRecent: { peerId: string; lastSeen: number } | undefined;

  for (const [peerId, info] of peerMap) {
    if (Date.now() - info.lastSeen > maxAgeMs) continue;
    if (!mostRecent || info.lastSeen > mostRecent.lastSeen) {
      mostRecent = { peerId, lastSeen: info.lastSeen };
    }
  }

  return mostRecent?.peerId;
}

/** Get context token for a peer */
export function getPeerContextToken(accountId: string, peerId: string): string | undefined {
  const peerMap = peerContextStore.get(accountId);
  return peerMap?.get(peerId)?.contextToken;
}

/** Resolve a peer context from a context token. */
export function getPeerContextByToken(contextToken: string): ResolvedPeerContext | undefined {
  return contextTokenToPeerMap.get(contextToken);
}

/** Resolve accountId from a context token. */
export function getAccountIdByContextToken(contextToken: string): string | undefined {
  return contextTokenToPeerMap.get(contextToken)?.accountId;
}

/** Check if we have an active session for routing */
export function hasActiveSession(accountId: string, peerId: string, maxAgeMs = 30 * 60 * 1000): boolean {
  const peerMap = peerContextStore.get(accountId);
  if (!peerMap) return false;

  const info = peerMap.get(peerId);
  if (!info) return false;

  return Date.now() - info.lastSeen < maxAgeMs;
}

/** Clear all contexts for an account */
export function clearPeerContexts(accountId: string): void {
  const peerMap = peerContextStore.get(accountId);
  if (peerMap) {
    for (const [peerId, info] of peerMap) {
      peerToAccountMap.delete(peerId);
      contextTokenToPeerMap.delete(info.contextToken);
    }
  }
  peerContextStore.delete(accountId);

  const filePath = resolveContextFilePath(accountId);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    logger.warn?.(`clearPeerContexts: failed to remove ${filePath}`);
  }
}
