import { appLogger, describeLogError } from "@/lib/logger";
import { readingPositionKeyPrefix } from "@/lib/persist/keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import type {
  ReadingPositionAnchorValidator,
  ReadingPositionIdentity,
  ReadingPositionSurfaceKind,
} from "@/lib/reading-position/types";

const SCHEMA_VERSION = 1;
const PERSIST_DELAY_MS = 160;
const MAX_STORED_RECORDS = 1_000;
const TOMBSTONE_LIMIT = 500;
const PRESERVED_VIEW_TTL_MS = 5_000;

type ReadingPositionSlot = "view" | "content";

interface ReadingPositionRecord {
  readonly schemaVersion: 1;
  readonly updatedAt: number;
  readonly surfaceKind: ReadingPositionSurfaceKind;
  readonly slot: ReadingPositionSlot;
  readonly identity: ReadingPositionIdentity;
  readonly anchor: unknown;
}

interface CaptureRegistration {
  readonly captureKey: string;
  readonly identity: ReadingPositionIdentity;
  readonly capture: () => void;
}

interface ReadingPositionSubscription {
  readonly identity: ReadingPositionIdentity;
  readonly surfaceKind: ReadingPositionSurfaceKind;
  readonly listener: () => void;
  boundKeys: ReadonlyArray<string>;
}

let activeAccountId: string | null = null;
let lastUpdatedAt = 0;
let persistTimer: number | null = null;
let warnedForStorageFailure = false;
const records = new Map<string, ReadingPositionRecord>();
const pendingWrites = new Map<string, ReadingPositionRecord>();
const captures = new Map<string, CaptureRegistration>();
const listeners = new Map<string, Set<ReadingPositionSubscription>>();
const subscriptions = new Set<ReadingPositionSubscription>();
const tombstonedEpics = new Set<string>();
const tombstonedDeletionKeys = new Set<string>();
const preservedViewDeletions = new Map<string, number>();
let nextPreservedViewGeneration = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function currentAuthAccountId(): string | null {
  const auth = useAuthStore.getState();
  if (auth.status !== "signed-in") return null;
  return auth.contextMetadata?.userId ?? auth.profile?.userId ?? null;
}

function ensureCurrentAccount(): void {
  const accountId = currentAuthAccountId();
  if (accountId !== null && accountId !== activeAccountId) {
    activateReadingPositionAccount(accountId);
  }
}

function accountPrefix(accountId: string): string {
  return readingPositionKeyPrefix(accountId);
}

function epicPrefix(accountId: string, epicId: string): string {
  return `${accountPrefix(accountId)}${encodeURIComponent(epicId)}:`;
}

function storageKey(
  identity: ReadingPositionIdentity,
  surfaceKind: ReadingPositionSurfaceKind,
  slot: ReadingPositionSlot,
): string | null {
  if (activeAccountId === null || identity.epicId === null) return null;
  const coordinate = slot === "view" ? identity.viewKey : identity.contentKey;
  if (coordinate === null) return null;
  return `${epicPrefix(activeAccountId, identity.epicId)}${slot}:${encodeURIComponent(surfaceKind)}:${encodeURIComponent(coordinate)}`;
}

function memoryKey(
  identity: ReadingPositionIdentity,
  surfaceKind: ReadingPositionSurfaceKind,
  slot: ReadingPositionSlot,
): string | null {
  const persisted = storageKey(identity, surfaceKind, slot);
  if (persisted !== null) return persisted;
  const coordinate = slot === "view" ? identity.viewKey : identity.contentKey;
  return coordinate === null
    ? null
    : `session:${slot}:${surfaceKind}:${coordinate}`;
}

function nextUpdatedAt(): number {
  const now = Date.now();
  lastUpdatedAt = Math.max(now, lastUpdatedAt + 1);
  return lastUpdatedAt;
}

function isIdentity(value: unknown): value is ReadingPositionIdentity {
  if (!isRecord(value)) return false;
  return (
    typeof value.viewKey === "string" &&
    (typeof value.contentKey === "string" || value.contentKey === null) &&
    (typeof value.deletionKey === "string" || value.deletionKey === null) &&
    (typeof value.epicId === "string" || value.epicId === null) &&
    (typeof value.hostId === "string" || value.hostId === null) &&
    (value.durability === "durable" || value.durability === "renderer-live")
  );
}

function parseRecord(raw: string): ReadingPositionRecord | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return null;
    if (value.schemaVersion !== SCHEMA_VERSION) return null;
    if (
      typeof value.updatedAt !== "number" ||
      !Number.isFinite(value.updatedAt)
    ) {
      return null;
    }
    if (
      value.surfaceKind !== "native" &&
      value.surfaceKind !== "bundle-diff" &&
      value.surfaceKind !== "chat" &&
      value.surfaceKind !== "managed-command" &&
      value.surfaceKind !== "terminal"
    ) {
      return null;
    }
    if (value.slot !== "view" && value.slot !== "content") return null;
    if (!isIdentity(value.identity)) return null;
    return {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: value.updatedAt,
      surfaceKind: value.surfaceKind,
      slot: value.slot,
      identity: value.identity,
      anchor: value.anchor,
    };
  } catch {
    return null;
  }
}

function recordMatches(
  record: ReadingPositionRecord,
  identity: ReadingPositionIdentity,
  surfaceKind: ReadingPositionSurfaceKind,
  slot: ReadingPositionSlot,
): boolean {
  const expectedCoordinate =
    slot === "view" ? identity.viewKey : identity.contentKey;
  const recordCoordinate =
    slot === "view" ? record.identity.viewKey : record.identity.contentKey;
  return (
    record.surfaceKind === surfaceKind &&
    record.slot === slot &&
    record.identity.epicId === identity.epicId &&
    record.identity.hostId === identity.hostId &&
    recordCoordinate === expectedCoordinate
  );
}

function isEpicTombstoned(identity: ReadingPositionIdentity): boolean {
  return identity.epicId !== null && tombstonedEpics.has(identity.epicId);
}

function isContentTombstoned(identity: ReadingPositionIdentity): boolean {
  return (
    identity.deletionKey !== null &&
    tombstonedDeletionKeys.has(identity.deletionKey)
  );
}

function touchMemory(key: string, record: ReadingPositionRecord): void {
  records.delete(key);
  records.set(key, record);
  while (records.size > MAX_STORED_RECORDS) {
    const oldest = records.keys().next().value;
    if (typeof oldest !== "string") break;
    records.delete(oldest);
  }
}

function warnStorageFailure(error: unknown): void {
  if (warnedForStorageFailure) return;
  warnedForStorageFailure = true;
  appLogger.warn("[reading-position] local persistence unavailable", {
    error: describeLogError(error),
  });
}

function writeRecord(key: string, record: ReadingPositionRecord): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(record));
  } catch (error) {
    warnStorageFailure(error);
  }
}

function schedulePersist(): void {
  if (typeof window === "undefined" || persistTimer !== null) return;
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    flushPendingReadingPositionWrites();
  }, PERSIST_DELAY_MS);
}

function saveSlot(
  identity: ReadingPositionIdentity,
  surfaceKind: ReadingPositionSurfaceKind,
  input: {
    readonly slot: ReadingPositionSlot;
    readonly anchor: unknown;
    readonly persistDurably: boolean;
  },
): void {
  const { anchor, persistDurably, slot } = input;
  const key = memoryKey(identity, surfaceKind, slot);
  if (key === null) return;
  const record: ReadingPositionRecord = {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: nextUpdatedAt(),
    surfaceKind,
    slot,
    identity,
    anchor,
  };
  touchMemory(key, record);
  if (
    persistDurably &&
    identity.durability === "durable" &&
    activeAccountId !== null &&
    key.startsWith(accountPrefix(activeAccountId))
  ) {
    pendingWrites.set(key, record);
    schedulePersist();
  }
}

export function saveReadingPosition(
  identity: ReadingPositionIdentity,
  surfaceKind: ReadingPositionSurfaceKind,
  anchor: unknown,
): void {
  ensureCurrentAccount();
  const durableWriteAllowed =
    !isEpicTombstoned(identity) && !isContentTombstoned(identity);
  // A deletion fence blocks durable resurrection, not renderer-local
  // continuity. This mirrors the established chat cache: a late live view
  // can still hand off within the renderer, while no durable fallback is
  // recreated after access loss/deletion.
  saveSlot(identity, surfaceKind, {
    slot: "view",
    anchor,
    persistDurably: durableWriteAllowed,
  });
  if (
    durableWriteAllowed &&
    identity.contentKey !== null &&
    !isContentTombstoned(identity)
  ) {
    saveSlot(identity, surfaceKind, {
      slot: "content",
      anchor,
      persistDurably: true,
    });
  }
}

export function saveReadingPositionContentFallback(
  identity: ReadingPositionIdentity,
  surfaceKind: ReadingPositionSurfaceKind,
  anchor: unknown,
): void {
  ensureCurrentAccount();
  if (
    identity.contentKey === null ||
    isEpicTombstoned(identity) ||
    isContentTombstoned(identity)
  ) {
    return;
  }
  saveSlot(identity, surfaceKind, {
    slot: "content",
    anchor,
    persistDurably: true,
  });
}

function readSlot<T>(
  identity: ReadingPositionIdentity,
  surfaceKind: ReadingPositionSurfaceKind,
  slot: ReadingPositionSlot,
  validate: ReadingPositionAnchorValidator<T>,
): T | null {
  const key = memoryKey(identity, surfaceKind, slot);
  if (key === null) return null;
  let record = records.get(key) ?? null;
  if (
    record === null &&
    typeof window !== "undefined" &&
    activeAccountId !== null &&
    key.startsWith(accountPrefix(activeAccountId))
  ) {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) {
        const parsed = parseRecord(raw);
        if (
          parsed !== null &&
          recordMatches(parsed, identity, surfaceKind, slot)
        ) {
          record = parsed;
          touchMemory(key, parsed);
        } else {
          window.localStorage.removeItem(key);
        }
      }
    } catch (error) {
      warnStorageFailure(error);
    }
  }
  if (
    record === null ||
    !recordMatches(record, identity, surfaceKind, slot) ||
    !validate(record.anchor)
  ) {
    if (record !== null) {
      records.delete(key);
      pendingWrites.delete(key);
    }
    return null;
  }
  // Refresh only renderer-memory recency; reads never rewrite storage or
  // change the record's durable timestamp.
  touchMemory(key, record);
  return record.anchor;
}

export function readReadingPosition<T>(
  identity: ReadingPositionIdentity,
  surfaceKind: ReadingPositionSurfaceKind,
  validate: ReadingPositionAnchorValidator<T>,
): T | null {
  ensureCurrentAccount();
  const exact = readSlot(identity, surfaceKind, "view", validate);
  if (
    exact !== null ||
    isEpicTombstoned(identity) ||
    isContentTombstoned(identity)
  ) {
    return exact;
  }
  return readSlot(identity, surfaceKind, "content", validate);
}

export function readExactReadingPosition<T>(
  identity: ReadingPositionIdentity,
  surfaceKind: ReadingPositionSurfaceKind,
  validate: ReadingPositionAnchorValidator<T>,
): T | null {
  ensureCurrentAccount();
  return readSlot(identity, surfaceKind, "view", validate);
}

export function deleteReadingPositionView(viewKey: string): void {
  if (preservedViewDeletions.delete(viewKey)) return;
  const removeMatching = (key: string, record: ReadingPositionRecord): void => {
    if (record.slot !== "view" || record.identity.viewKey !== viewKey) return;
    records.delete(key);
    pendingWrites.delete(key);
    if (typeof window !== "undefined" && !key.startsWith("session:")) {
      window.localStorage.removeItem(key);
    }
  };
  for (const [key, record] of [...records]) removeMatching(key, record);
  if (typeof window === "undefined" || activeAccountId === null) return;
  const prefix = accountPrefix(activeAccountId);
  try {
    for (const key of storageKeys()) {
      if (!key.startsWith(prefix)) continue;
      const raw = window.localStorage.getItem(key);
      const record = raw === null ? null : parseRecord(raw);
      if (record !== null) removeMatching(key, record);
    }
  } catch (error) {
    warnStorageFailure(error);
  }
}

/**
 * A successful cross-window move removes the source canvas records but keeps
 * the same serialized tile instance ids in the destination. Arm a one-shot
 * exception for that source removal so the ordinary permanent-close sweep
 * does not erase the exact-view anchors the destination is about to read.
 */
export function preserveReadingPositionViewsForMove(
  viewKeys: ReadonlyArray<string>,
): void {
  const generation = nextPreservedViewGeneration;
  nextPreservedViewGeneration += 1;
  viewKeys.forEach((viewKey) =>
    preservedViewDeletions.set(viewKey, generation),
  );
  if (typeof window === "undefined") return;
  window.setTimeout(() => {
    for (const viewKey of viewKeys) {
      if (preservedViewDeletions.get(viewKey) === generation) {
        preservedViewDeletions.delete(viewKey);
      }
    }
  }, PRESERVED_VIEW_TTL_MS);
}

export function flushPendingReadingPositionWrites(): void {
  if (typeof window === "undefined") return;
  if (persistTimer !== null) {
    window.clearTimeout(persistTimer);
    persistTimer = null;
  }
  const writes = [...pendingWrites];
  pendingWrites.clear();
  for (const [key, record] of writes) writeRecord(key, record);
  pruneStorage();
}

export function registerReadingPositionCapture(args: {
  readonly captureKey: string;
  readonly identity: ReadingPositionIdentity;
  readonly capture: () => void;
}): () => void {
  captures.set(args.captureKey, args);
  return () => {
    const current = captures.get(args.captureKey);
    if (current?.capture === args.capture) {
      captures.delete(args.captureKey);
    }
  };
}

export function flushLiveReadingPositions(epicId: string | null): void {
  for (const registration of captures.values()) {
    if (epicId !== null && registration.identity.epicId !== epicId) continue;
    try {
      registration.capture();
    } catch (error) {
      appLogger.error(
        "reading position capture failed during lifecycle handoff",
        { viewKey: registration.identity.viewKey },
        error,
      );
    }
  }
  flushPendingReadingPositionWrites();
}

export function flushLiveReadingPositionViews(
  viewKeys: ReadonlyArray<string>,
): void {
  for (const viewKey of viewKeys) {
    const registration = captures.get(viewKey);
    if (registration === undefined) continue;
    try {
      registration.capture();
    } catch (error) {
      appLogger.error(
        "reading position capture failed during structural handoff",
        { viewKey },
        error,
      );
    }
  }
}

function notifyKey(key: string): void {
  listeners.get(key)?.forEach((registration) => registration.listener());
}

function bindReadingPositionSubscription(
  registration: ReadingPositionSubscription,
): void {
  const keys = (["view", "content"] as const).flatMap((slot) => {
    const key = storageKey(
      registration.identity,
      registration.surfaceKind,
      slot,
    );
    return key === null ? [] : [key];
  });
  registration.boundKeys = keys;
  for (const key of keys) {
    const bucket = listeners.get(key) ?? new Set<ReadingPositionSubscription>();
    bucket.add(registration);
    listeners.set(key, bucket);
  }
}

function unbindReadingPositionSubscription(
  registration: ReadingPositionSubscription,
): void {
  for (const key of registration.boundKeys) {
    const bucket = listeners.get(key);
    if (bucket === undefined) continue;
    bucket.delete(registration);
    if (bucket.size === 0) listeners.delete(key);
  }
  registration.boundKeys = [];
}

function rebindReadingPositionSubscriptions(): void {
  listeners.clear();
  subscriptions.forEach(bindReadingPositionSubscription);
}

export function subscribeReadingPosition(
  identity: ReadingPositionIdentity,
  surfaceKind: ReadingPositionSurfaceKind,
  listener: () => void,
): () => void {
  ensureCurrentAccount();
  const registration: ReadingPositionSubscription = {
    identity,
    surfaceKind,
    listener,
    boundKeys: [],
  };
  subscriptions.add(registration);
  bindReadingPositionSubscription(registration);
  return () => {
    unbindReadingPositionSubscription(registration);
    subscriptions.delete(registration);
  };
}

function storageKeys(): ReadonlyArray<string> {
  const keys: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key !== null) keys.push(key);
  }
  return keys;
}

function removeStoragePrefix(prefix: string): void {
  if (typeof window === "undefined") return;
  try {
    storageKeys()
      .filter((key) => key.startsWith(prefix))
      .forEach((key) => window.localStorage.removeItem(key));
  } catch (error) {
    warnStorageFailure(error);
  }
}

function pruneStorage(): void {
  if (typeof window === "undefined" || activeAccountId === null) return;
  // Avoid a prefix scan on ordinary settled scroll writes. Other Traycer keys
  // can make this threshold conservative (scan early), never unsafe.
  if (window.localStorage.length <= MAX_STORED_RECORDS) return;
  const prefix = accountPrefix(activeAccountId);
  try {
    const candidates = storageKeys().flatMap((key) => {
      if (!key.startsWith(prefix)) return [];
      const raw = window.localStorage.getItem(key);
      if (raw === null) return [];
      const record = parseRecord(raw);
      if (record === null) {
        window.localStorage.removeItem(key);
        return [];
      }
      return [{ key, updatedAt: record.updatedAt }];
    });
    candidates.sort((left, right) => left.updatedAt - right.updatedAt);
    for (const candidate of candidates.slice(
      0,
      Math.max(0, candidates.length - MAX_STORED_RECORDS),
    )) {
      window.localStorage.removeItem(candidate.key);
      records.delete(candidate.key);
    }
  } catch (error) {
    warnStorageFailure(error);
  }
}

export function activateReadingPositionAccount(accountId: string): void {
  if (activeAccountId === accountId) return;
  // A renderer can publish its first position before the passive account
  // lifecycle bridge has mounted. Preserve those anonymous-session records
  // when binding the service to its initial signed-in account. Records from a
  // previous signed-in account are never carried across an account switch.
  const sessionRecords =
    activeAccountId === null
      ? [...records.values()].filter((record) =>
          Boolean(
            memoryKey(
              record.identity,
              record.surfaceKind,
              record.slot,
            )?.startsWith("session:") &&
            !isEpicTombstoned(record.identity) &&
            !isContentTombstoned(record.identity),
          ),
        )
      : [];
  flushPendingReadingPositionWrites();
  activeAccountId = accountId;
  records.clear();
  pendingWrites.clear();
  rebindReadingPositionSubscriptions();
  tombstonedEpics.clear();
  tombstonedDeletionKeys.clear();
  preservedViewDeletions.clear();
  warnedForStorageFailure = false;
  pruneStorage();
  for (const record of sessionRecords) {
    const key = memoryKey(record.identity, record.surfaceKind, record.slot);
    if (key === null) continue;
    touchMemory(key, record);
    if (
      record.identity.durability === "durable" &&
      key.startsWith(accountPrefix(accountId))
    ) {
      pendingWrites.set(key, record);
    }
  }
  if (pendingWrites.size > 0) schedulePersist();
}

export function deactivateReadingPositionAccount(
  clearPersisted: boolean,
): void {
  flushPendingReadingPositionWrites();
  if (clearPersisted && activeAccountId !== null) {
    removeStoragePrefix(accountPrefix(activeAccountId));
  }
  activeAccountId = null;
  records.clear();
  pendingWrites.clear();
  rebindReadingPositionSubscriptions();
  tombstonedEpics.clear();
  tombstonedDeletionKeys.clear();
  preservedViewDeletions.clear();
}

function pruneTombstones(
  values: Set<string>,
  protectedValues: ReadonlySet<string>,
): void {
  if (values.size <= TOMBSTONE_LIMIT) return;
  for (const value of values) {
    if (values.size <= TOMBSTONE_LIMIT) return;
    if (protectedValues.has(value)) continue;
    values.delete(value);
  }
}

export function tombstoneReadingPositionEpic(epicId: string): void {
  tombstoneReadingPositionEpics([epicId]);
}

/** Fence a whole access-loss transaction before its canvas close sweep. */
export function tombstoneReadingPositionEpics(
  epicIds: ReadonlyArray<string>,
): void {
  const batch = new Set(epicIds);
  batch.forEach((epicId) => tombstonedEpics.add(epicId));
  pruneTombstones(tombstonedEpics, batch);
  batch.forEach(deleteReadingPositionsForEpic);
}

export function deleteReadingPositionsForEpic(epicId: string): void {
  for (const [key, record] of [...records]) {
    if (record.identity.epicId !== epicId) continue;
    records.delete(key);
    pendingWrites.delete(key);
  }
  for (const [key, record] of [...pendingWrites]) {
    if (record.identity.epicId === epicId) pendingWrites.delete(key);
  }
  if (activeAccountId !== null) {
    const prefix = epicPrefix(activeAccountId, epicId);
    removeStoragePrefix(prefix);
  }
}

export function tombstoneReadingPositionContent(
  identity: ReadingPositionIdentity,
): void {
  if (identity.deletionKey === null) return;
  tombstonedDeletionKeys.add(identity.deletionKey);
  pruneTombstones(tombstonedDeletionKeys, new Set([identity.deletionKey]));
  deleteReadingPositionsForContent(identity);
}

export function deleteReadingPositionsForContent(
  identity: ReadingPositionIdentity,
): void {
  if (identity.deletionKey === null) return;
  const matches = (record: ReadingPositionRecord): boolean =>
    record.identity.epicId === identity.epicId &&
    record.identity.deletionKey === identity.deletionKey;
  for (const [key, record] of [...records]) {
    if (!matches(record)) continue;
    records.delete(key);
    pendingWrites.delete(key);
    if (typeof window !== "undefined") window.localStorage.removeItem(key);
  }
  if (typeof window === "undefined" || activeAccountId === null) return;
  const prefix =
    identity.epicId === null
      ? accountPrefix(activeAccountId)
      : epicPrefix(activeAccountId, identity.epicId);
  for (const key of storageKeys()) {
    if (!key.startsWith(prefix)) continue;
    const raw = window.localStorage.getItem(key);
    const record = raw === null ? null : parseRecord(raw);
    if (record !== null && matches(record)) window.localStorage.removeItem(key);
  }
}

export function clearReadingPositionTombstones(
  identity: ReadingPositionIdentity,
): void {
  if (identity.epicId !== null) tombstonedEpics.delete(identity.epicId);
  if (identity.deletionKey !== null) {
    tombstonedDeletionKeys.delete(identity.deletionKey);
  }
}

export function resetReadingPositionServiceForTests(): void {
  if (persistTimer !== null && typeof window !== "undefined") {
    window.clearTimeout(persistTimer);
  }
  persistTimer = null;
  activeAccountId = null;
  lastUpdatedAt = 0;
  warnedForStorageFailure = false;
  records.clear();
  pendingWrites.clear();
  captures.clear();
  listeners.clear();
  subscriptions.clear();
  tombstonedEpics.clear();
  tombstonedDeletionKeys.clear();
  preservedViewDeletions.clear();
}

function handleStorageEvent(event: StorageEvent): void {
  if (activeAccountId === null) return;
  const prefix = accountPrefix(activeAccountId);
  if (event.key === null) {
    records.clear();
    subscriptions.forEach((registration) => registration.listener());
    return;
  }
  if (!event.key.startsWith(prefix)) return;
  if (event.newValue === null) {
    records.delete(event.key);
  } else {
    const parsed = parseRecord(event.newValue);
    if (parsed === null) records.delete(event.key);
    else touchMemory(event.key, parsed);
  }
  notifyKey(event.key);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", handleStorageEvent);
  window.addEventListener("pagehide", () => flushLiveReadingPositions(null));
}
