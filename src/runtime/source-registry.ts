export type WecomSourcePlane = "bot-ws" | "agent-callback";

export type WecomSourceSnapshot = {
  accountId: string;
  source: WecomSourcePlane;
  recordedAt: number;
  messageId?: string;
  sessionKey?: string;
  sessionId?: string;
};

const MAX_MESSAGE_FACTS = 2048;
const MAX_SESSION_SNAPSHOTS = 1024;

const messageFacts = new Map<string, WecomSourceSnapshot>();
const sessionSnapshotsByAccountKey = new Map<string, WecomSourceSnapshot>();
const sessionSnapshotsByLooseKey = new Map<string, WecomSourceSnapshot>();

function normalizeOptional(value: string | null | undefined): string | undefined {
  const trimmed = String(value ?? "").trim();
  return trimmed || undefined;
}

function messageFactKey(accountId: string, messageId: string): string {
  return `${accountId}::${messageId}`;
}

function accountScopedSessionKey(
  accountId: string,
  kind: "sessionKey" | "sessionId",
  value: string,
): string {
  return `${accountId}::${kind}::${value}`;
}

function pruneOldest<T>(map: Map<string, T>, maxSize: number): void {
  while (map.size > maxSize) {
    const oldestKey = map.keys().next().value;
    if (!oldestKey) return;
    map.delete(oldestKey);
  }
}

function writeSessionSnapshot(snapshot: WecomSourceSnapshot): void {
  const sessionKey = normalizeOptional(snapshot.sessionKey);
  const sessionId = normalizeOptional(snapshot.sessionId);
  if (sessionKey) {
    sessionSnapshotsByAccountKey.set(
      accountScopedSessionKey(snapshot.accountId, "sessionKey", sessionKey),
      snapshot,
    );
    sessionSnapshotsByLooseKey.set(`sessionKey::${sessionKey}`, snapshot);
  }
  if (sessionId) {
    sessionSnapshotsByAccountKey.set(
      accountScopedSessionKey(snapshot.accountId, "sessionId", sessionId),
      snapshot,
    );
    sessionSnapshotsByLooseKey.set(`sessionId::${sessionId}`, snapshot);
  }
  pruneOldest(sessionSnapshotsByAccountKey, MAX_SESSION_SNAPSHOTS * 2);
  pruneOldest(sessionSnapshotsByLooseKey, MAX_SESSION_SNAPSHOTS * 2);
}

export function registerWecomSourceSnapshot(params: {
  accountId: string;
  source: WecomSourcePlane;
  messageId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
}): void {
  const accountId = normalizeOptional(params.accountId);
  if (!accountId) return;

  const snapshot: WecomSourceSnapshot = {
    accountId,
    source: params.source,
    recordedAt: Date.now(),
    ...(normalizeOptional(params.messageId)
      ? { messageId: normalizeOptional(params.messageId) }
      : {}),
    ...(normalizeOptional(params.sessionKey)
      ? { sessionKey: normalizeOptional(params.sessionKey) }
      : {}),
    ...(normalizeOptional(params.sessionId)
      ? { sessionId: normalizeOptional(params.sessionId) }
      : {}),
  };

  if (snapshot.messageId) {
    messageFacts.set(messageFactKey(accountId, snapshot.messageId), snapshot);
    pruneOldest(messageFacts, MAX_MESSAGE_FACTS);
  }

  writeSessionSnapshot(snapshot);
}

export function resolveWecomSourceSnapshot(params: {
  accountId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
}): WecomSourceSnapshot | undefined {
  const accountId = normalizeOptional(params.accountId);
  const sessionKey = normalizeOptional(params.sessionKey);
  const sessionId = normalizeOptional(params.sessionId);

  if (accountId && sessionKey) {
    const scoped = sessionSnapshotsByAccountKey.get(
      accountScopedSessionKey(accountId, "sessionKey", sessionKey),
    );
    if (scoped) return scoped;
  }
  if (accountId && sessionId) {
    const scoped = sessionSnapshotsByAccountKey.get(
      accountScopedSessionKey(accountId, "sessionId", sessionId),
    );
    if (scoped) return scoped;
  }
  if (sessionKey) {
    const loose = sessionSnapshotsByLooseKey.get(`sessionKey::${sessionKey}`);
    if (loose) return loose;
  }
  if (sessionId) {
    const loose = sessionSnapshotsByLooseKey.get(`sessionId::${sessionId}`);
    if (loose) return loose;
  }
  return undefined;
}

export function clearWecomSourceAccount(accountId: string): void {
  const normalized = normalizeOptional(accountId);
  if (!normalized) return;

  for (const [key, value] of messageFacts) {
    if (value.accountId === normalized || key.startsWith(`${normalized}::`)) {
      messageFacts.delete(key);
    }
  }
  for (const [key, value] of sessionSnapshotsByAccountKey) {
    if (value.accountId === normalized || key.startsWith(`${normalized}::`)) {
      sessionSnapshotsByAccountKey.delete(key);
    }
  }
  for (const [key, value] of sessionSnapshotsByLooseKey) {
    if (value.accountId === normalized) {
      sessionSnapshotsByLooseKey.delete(key);
    }
  }
}

export function isWecomBotWsSource(params: {
  accountId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
}): boolean {
  return resolveWecomSourceSnapshot(params)?.source === "bot-ws";
}

export function isWecomAgentSource(params: {
  accountId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
}): boolean {
  return resolveWecomSourceSnapshot(params)?.source === "agent-callback";
}
