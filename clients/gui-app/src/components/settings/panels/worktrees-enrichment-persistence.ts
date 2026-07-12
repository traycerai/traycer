// Warm-open persistence for the worktrees activity overlay.
//
// The TanStack Query cache is renderer-memory only, so every app launch used
// to open Settings ▸ Worktrees fully cold: each row sat at "Checking…" until
// its per-path probe resolved, and the tier-filtered counts churned while the
// list re-converged. This module persists the last-known fully-warm per-path
// entries to localStorage - one snapshot per host - so the next launch can
// seed the cache and render last-known tiers instantly while the viewport
// observers and the background sweep revalidate everything.
//
// STORAGE layer only: reading/writing/pruning snapshots. Cache seeding lives
// in `worktrees-enrichment.ts`, which owns the query-key layout - keeping the
// import direction one-way (enrichment → persistence, never back).

import { z } from "zod";
import {
  worktreeHostEntrySchemaV12,
  type WorktreeHostEntryV12,
} from "@traycer/protocol/host/worktree-schemas";
import { persistKey, worktreeActivityCacheKey } from "@/lib/persist";
import { appLogger, describeLogError } from "@/lib/logger";

export const WORKTREE_ACTIVITY_CACHE_VERSION = 1;
// A snapshot is only a warm-open hint; one this old is likelier to mislead
// (branches move, PRs merge, worktrees get deleted) than to help, so it is
// dropped unread and the next open is simply cold.
export const WORKTREE_ACTIVITY_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
// Bounds the localStorage footprint (a serialized entry is roughly a
// kilobyte): fleets larger than this persist their first N listing-order
// rows and the tail opens cold.
export const WORKTREE_ACTIVITY_CACHE_MAX_ENTRIES = 1_000;

// Persisted entries round-trip through the protocol's own zod schema: a
// snapshot whose shape no longer parses (older app, protocol evolution,
// corrupt disk state) is discarded wholesale - a cold open, never a
// malformed seed.
const worktreeActivitySnapshotSchema = z.object({
  version: z.literal(WORKTREE_ACTIVITY_CACHE_VERSION),
  savedAt: z.number(),
  entries: z.array(worktreeHostEntrySchemaV12),
});

export interface WorktreeActivitySnapshot {
  readonly savedAt: number;
  readonly entries: readonly WorktreeHostEntryV12[];
}

// Only fully-warm entries are worth seeding: `prState === null` on any leg
// means "not yet probed" - restoring it would render the same "Checking…"
// state a cold open shows, then consume a revalidation probe anyway.
function worktreeEntryIsWarm(entry: WorktreeHostEntryV12): boolean {
  return (
    entry.prState !== null &&
    entry.submodules.every((submodule) => submodule.prState !== null)
  );
}

function parseSnapshot(raw: string): WorktreeActivitySnapshot | null {
  // Boundary catch: corrupt disk state must read as "no snapshot", never
  // throw into the panel's render path.
  try {
    const parsed = worktreeActivitySnapshotSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The last run's snapshot for `hostId`, or `null` when there is none, it no
 * longer parses, or it aged past {@link WORKTREE_ACTIVITY_CACHE_MAX_AGE_MS}
 * (unusable snapshots are removed on the spot).
 */
export function readWorktreeActivitySnapshot(
  hostId: string,
  now: number,
): WorktreeActivitySnapshot | null {
  const key = worktreeActivityCacheKey(hostId);
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

/**
 * Writes the snapshot for `hostId`: the warm entries of the currently listed
 * paths, in listing order, capped at
 * {@link WORKTREE_ACTIVITY_CACHE_MAX_ENTRIES}. Filtering by `worktreePaths`
 * drops deleted worktrees on the first write after they leave the listing.
 * An EMPTY result never writes - an early fold (nothing enriched yet) must
 * not clobber the previous run's still-useful snapshot.
 */
export function persistWorktreeActivitySnapshot(args: {
  readonly hostId: string;
  readonly worktreePaths: readonly string[];
  readonly enrichedByPath: ReadonlyMap<string, WorktreeHostEntryV12>;
  readonly now: number;
}): void {
  const entries = args.worktreePaths
    .flatMap((path) => {
      const entry = args.enrichedByPath.get(path);
      return entry !== undefined && worktreeEntryIsWarm(entry) ? [entry] : [];
    })
    .slice(0, WORKTREE_ACTIVITY_CACHE_MAX_ENTRIES);
  if (entries.length === 0) return;
  const serialized = JSON.stringify({
    version: WORKTREE_ACTIVITY_CACHE_VERSION,
    savedAt: args.now,
    entries,
  });
  // Boundary catch: see `persistWriteFailureLogged`.
  try {
    window.localStorage.setItem(
      worktreeActivityCacheKey(args.hostId),
      serialized,
    );
  } catch (error) {
    if (persistWriteFailureLogged) return;
    persistWriteFailureLogged = true;
    appLogger.warn("[worktrees] failed to persist the activity snapshot", {
      error: describeLogError(error),
    });
  }
}

/**
 * Drops every host's snapshot that no longer parses or aged past
 * {@link WORKTREE_ACTIVITY_CACHE_MAX_AGE_MS}, so hosts that stopped being
 * opened don't hold their last fleet in localStorage forever. Run once per
 * app session (alongside the first restore), not per write.
 */
export function pruneWorktreeActivitySnapshots(now: number): void {
  // The `:` boundary mirrors `wipe.ts`: only this store's namespace.
  const prefix = `${persistKey("worktree-activity-cache")}:`;
  const staleKeys = Object.keys(window.localStorage).filter((key) => {
    if (!key.startsWith(prefix)) return false;
    const raw = window.localStorage.getItem(key);
    const snapshot = raw === null ? null : parseSnapshot(raw);
    return (
      snapshot === null ||
      now - snapshot.savedAt > WORKTREE_ACTIVITY_CACHE_MAX_AGE_MS
    );
  });
  for (const key of staleKeys) window.localStorage.removeItem(key);
}
