// Cache seeding lives with the hooks that own each query-key layout - keeping the import direction one-way
// (enrichment/listing → persistence, never back).

import { z } from "zod";
import {
  worktreeHostEntrySchemaV12,
  type WorktreeHostEntryV14,
} from "@traycer/protocol/host/worktree-schemas";
import {
  persistKey,
  worktreeActivityCacheKey,
  worktreeListingCacheKey,
} from "@/lib/persist";
import { appLogger, describeLogError } from "@/lib/logger";

export const WORKTREE_ACTIVITY_CACHE_VERSION = 1;
// A snapshot is only a warm-open hint; one this old is likelier to mislead (branches move, PRs merge,
// worktrees get deleted) than to help, so it is dropped unread and the next open is simply cold.
export const WORKTREE_ACTIVITY_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
// Bounds the localStorage footprint (a serialized entry is roughly a kilobyte): fleets larger than this
// persist their first N listing-order rows and the tail opens cold.
export const WORKTREE_ACTIVITY_CACHE_MAX_ENTRIES = 1_000;

// Persisted entries round-trip through the protocol's own zod schema: a snapshot whose shape no longer parses
// (older app, protocol evolution, corrupt disk state) is discarded wholesale.
const persistedWorktreeHostEntrySchema = worktreeHostEntrySchemaV12.extend({
  // Snapshots written before listAllForHost@1.4 had no freshness marker.
  // Restore them fail-closed as unresolved until a live host response lands.
  resolvedAt: z.number().nonnegative().nullable().default(null),
  gitUnreadable: z.boolean().default(false),
});

const worktreeSnapshotSchema = z.object({
  version: z.literal(WORKTREE_ACTIVITY_CACHE_VERSION),
  savedAt: z.number(),
  entries: z.array(persistedWorktreeHostEntrySchema),
});

export interface WorktreeActivitySnapshot {
  readonly savedAt: number;
  readonly entries: readonly WorktreeHostEntryV14[];
}

// Only fully-warm entries are worth seeding: `prState === null` on any leg means "not yet probed" - restoring
// it would render the same "Checking…" state a cold open shows, then consume a revalidation probe anyway.
function worktreeEntryIsWarm(entry: WorktreeHostEntryV14): boolean {
  return (
    entry.prState !== null &&
    entry.submodules.every((submodule) => submodule.prState !== null)
  );
}

/** Distinct from worktreeEntryIsWarm, which is about the (later) `gh` PR probe: a row can be fully resolved
 * with its PR fact still warming. */
function worktreeEntryIsResolved(entry: WorktreeHostEntryV14): boolean {
  return entry.resolvedAt !== null;
}

function parseSnapshot(raw: string): WorktreeActivitySnapshot | null {
  // Boundary catch: corrupt disk state must read as "no snapshot", never
  // throw into the panel's render path.
  try {
    const parsed = worktreeSnapshotSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The last run's snapshot under `key`, or `null` when there is none, it no longer parses, or it aged past
 * WORKTREE_ACTIVITY_CACHE_MAX_AGE_MS (unusable snapshots are removed on the spot). */
function readSnapshotAt(
  key: string,
  now: number,
): WorktreeActivitySnapshot | null {
  const raw = window.localStorage.getItem(key);
  if (raw === null) return null;
  const snapshot = parseSnapshot(raw);
  if (
    snapshot === null ||
    now - snapshot.savedAt > WORKTREE_ACTIVITY_CACHE_MAX_AGE_MS
  ) {
    window.localStorage.removeItem(key);
    return null;
  }
  return snapshot;
}

// Quota exhaustion (or a storage-less context) degrades to "no warm open
// next launch". Logged once, not per debounced write.
let persistWriteFailureLogged = false;

/** An empty result never writes - an early fold (nothing enriched / no rows listed yet) must not clobber the
 * previous run's still-useful snapshot. */
function writeSnapshotAt(
  key: string,
  entries: readonly WorktreeHostEntryV14[],
  now: number,
): void {
  const capped = entries.slice(0, WORKTREE_ACTIVITY_CACHE_MAX_ENTRIES);
  if (capped.length === 0) return;
  const serialized = JSON.stringify({
    version: WORKTREE_ACTIVITY_CACHE_VERSION,
    savedAt: now,
    entries: capped,
  });
  // Boundary catch: see `persistWriteFailureLogged`.
  try {
    window.localStorage.setItem(key, serialized);
  } catch (error) {
    if (persistWriteFailureLogged) return;
    persistWriteFailureLogged = true;
    appLogger.warn("[worktrees] failed to persist a warm-open snapshot", {
      error: describeLogError(error),
    });
  }
}

/** The last run's activity snapshot for `hostId`, or `null` when there is none, it no longer parses, or it aged
 * out. */
export function readWorktreeActivitySnapshot(
  hostId: string,
  now: number,
): WorktreeActivitySnapshot | null {
  return readSnapshotAt(worktreeActivityCacheKey(hostId), now);
}

/** Filtering by `worktreePaths` drops deleted worktrees on the first write after they leave the listing. */
export function persistWorktreeActivitySnapshot(args: {
  readonly hostId: string;
  readonly worktreePaths: readonly string[];
  readonly enrichedByPath: ReadonlyMap<string, WorktreeHostEntryV14>;
  readonly now: number;
}): void {
  const entries = args.worktreePaths.flatMap((path) => {
    const entry = args.enrichedByPath.get(path);
    return entry !== undefined && worktreeEntryIsWarm(entry) ? [entry] : [];
  });
  writeSnapshotAt(worktreeActivityCacheKey(args.hostId), entries, args.now);
}

/** The last run's base-listing snapshot for `hostId`, or `null` when there is none, it no longer parses, or it
 * aged out. */
export function readWorktreeListingSnapshot(
  hostId: string,
  now: number,
): WorktreeActivitySnapshot | null {
  return readSnapshotAt(worktreeListingCacheKey(hostId), now);
}

/** The caller only persists complete listings (all pages landed), so a restored row list is never a
 * silently-truncated prefix. */
export function persistWorktreeListingSnapshot(args: {
  readonly hostId: string;
  readonly entries: readonly WorktreeHostEntryV14[];
  readonly now: number;
}): void {
  const key = worktreeListingCacheKey(args.hostId);
  const previousByPath = new Map(
    (readSnapshotAt(key, args.now)?.entries ?? []).map((entry) => [
      entry.worktreePath,
      entry,
    ]),
  );
  const entries = args.entries.map((entry) => {
    if (worktreeEntryIsResolved(entry)) return entry;
    const previous = previousByPath.get(entry.worktreePath);
    return previous !== undefined && worktreeEntryIsResolved(previous)
      ? previous
      : entry;
  });
  writeSnapshotAt(key, entries, args.now);
}

/** Drops every host's snapshot - across both the activity and listing namespaces. */
export function pruneWorktreeSnapshots(now: number): void {
  // The `:` boundary mirrors `wipe.ts`: only these stores' namespaces.
  const prefixes = [
    `${persistKey("worktree-activity-cache")}:`,
    `${persistKey("worktree-listing-cache")}:`,
  ];
  const staleKeys = Object.keys(window.localStorage).filter((key) => {
    if (!prefixes.some((prefix) => key.startsWith(prefix))) return false;
    const raw = window.localStorage.getItem(key);
    const snapshot = raw === null ? null : parseSnapshot(raw);
    return (
      snapshot === null ||
      now - snapshot.savedAt > WORKTREE_ACTIVITY_CACHE_MAX_AGE_MS
    );
  });
  for (const key of staleKeys) window.localStorage.removeItem(key);
}
