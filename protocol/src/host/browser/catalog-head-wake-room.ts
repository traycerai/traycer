/** Catalog versions are invalidation hints only; periodic authorized reads repair missed wakes. */
import * as Y from "yjs";

export const BROWSER_CATALOG_HEAD_WAKE_MAP_KEY = "cloudBrowserCatalogHead";
export const MAX_BROWSER_CATALOG_HEAD_WAKE_ENTRIES = 64;
export const BROWSER_CATALOG_HEAD_WAKE_ENTRY_TTL_MS = 24 * 60 * 60 * 1000;
export const BROWSER_CATALOG_HEAD_WAKE_STALE_TTL_MS = 10 * 60 * 1000;
export const BROWSER_CATALOG_HEAD_WAKE_FUTURE_SKEW_MS = 2 * 60 * 1000;

interface WakeEntry {
  readonly epicId: string;
  readonly version: number;
  readonly updatedAt: number;
}

export interface BrowserCatalogHeadWakeWrite extends WakeEntry {
  readonly writerHostId: string;
  readonly now: number;
}

function wakeMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>(BROWSER_CATALOG_HEAD_WAKE_MAP_KEY);
}

function keyFor(writerHostId: string, epicId: string): string {
  return JSON.stringify([writerHostId, epicId]);
}

function parseEntry(value: unknown): WakeEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const raw: Record<string, unknown> = { ...value };
  if (
    typeof raw.epicId !== "string" ||
    raw.epicId.length === 0 ||
    typeof raw.version !== "number" ||
    !Number.isSafeInteger(raw.version) ||
    raw.version < 0 ||
    typeof raw.updatedAt !== "number" ||
    !Number.isSafeInteger(raw.updatedAt) ||
    raw.updatedAt < 0
  ) {
    return null;
  }
  return {
    epicId: raw.epicId,
    version: raw.version,
    updatedAt: raw.updatedAt,
  };
}

function fresh(entry: WakeEntry, now: number): boolean {
  return (
    entry.updatedAt >= now - BROWSER_CATALOG_HEAD_WAKE_STALE_TTL_MS &&
    entry.updatedAt <= now + BROWSER_CATALOG_HEAD_WAKE_FUTURE_SKEW_MS
  );
}

export function readBrowserCatalogHeadWakeVersion(
  doc: Y.Doc,
  epicId: string,
  now: number,
): number | null {
  let version: number | null = null;
  for (const value of wakeMap(doc).values()) {
    const entry = parseEntry(value);
    if (entry === null || entry.epicId !== epicId || !fresh(entry, now)) {
      continue;
    }
    version =
      version === null ? entry.version : Math.max(version, entry.version);
  }
  return version;
}

export function writeBrowserCatalogHeadWakeVersion(
  doc: Y.Doc,
  write: BrowserCatalogHeadWakeWrite,
): boolean {
  const current = readBrowserCatalogHeadWakeVersion(
    doc,
    write.epicId,
    write.now,
  );
  if (current !== null && current >= write.version) return false;

  const ownKey = keyFor(write.writerHostId, write.epicId);
  wakeMap(doc).set(ownKey, {
    epicId: write.epicId,
    version: write.version,
    updatedAt: write.updatedAt,
  } satisfies WakeEntry);
  prune(doc, ownKey, write.now);
  return true;
}

function prune(doc: Y.Doc, ownKey: string, now: number): void {
  const map = wakeMap(doc);
  const candidates = [...map.entries()]
    .filter(([key]) => key !== ownKey)
    .map(([key, value]) => ({ key, entry: parseEntry(value) }))
    .sort(
      (left, right) =>
        (left.entry?.updatedAt ?? Number.NEGATIVE_INFINITY) -
        (right.entry?.updatedAt ?? Number.NEGATIVE_INFINITY),
    );
  for (const candidate of candidates) {
    const expired =
      candidate.entry === null ||
      now - candidate.entry.updatedAt > BROWSER_CATALOG_HEAD_WAKE_ENTRY_TTL_MS;
    if (expired || map.size > MAX_BROWSER_CATALOG_HEAD_WAKE_ENTRIES) {
      map.delete(candidate.key);
    }
  }
}
