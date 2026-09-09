/**
 * Which (host, epic) pairs a REACHABLE host has refused to serve because the
 * epic's chat store was written by a newer build than the one running there.
 *
 * ## Why this exists
 *
 * The chat open decision (`chatOpensPublishedCopy`) routes a chat to its
 * published read-only copy when the owner host is unreachable. A host that is
 * up but answers `chat.subscribe` with `HOST_OLDER_THAN_DATA` is the same
 * situation from the reader's side - the live transcript cannot be had from
 * that machine - but nothing about reachability says so. There is also no
 * per-epic fact to ask for before subscribing: `host.status@1.4` reports the
 * host's chat format and the on-disk MAXIMUM across every epic, which is too
 * coarse (a host whose maximum exceeds its own format still reads every epic
 * stamped at or below it). The fact is only ever learned reactively, from the
 * fatal close of a live open that already failed.
 *
 * This registry keeps that answer where the next open decision can read it.
 * It is keyed by EPIC rather than by chat because the refusal is: the store
 * is one file per epic (`epic-state/<epicId>/chat/chat.db`), and the host
 * refuses the whole file, so one chat's refusal is every sibling's.
 *
 * ## Why the answer is bound to a host BUILD
 *
 * A `hostId` survives an in-place upgrade, and the only remedy for this
 * refusal IS an upgrade. An entry that outlived the build it was recorded
 * against would keep routing every chat in the epic to the read-only copy
 * after the host had already been fixed, with nothing left to disprove it
 * (a copy never dials the store). So an entry remembers the host version the
 * directory reported when the refusal was observed, and the predicate answers
 * `false` - and evicts - as soon as the directory reports a different one.
 * The same shape `use-attachment-blob-src.ts` uses for its per-build
 * "predates `epic.fetchArtifactAttachment`" verdict.
 *
 * A landed snapshot is the other invalidation: a live open that succeeded
 * proves the host reads the file now, whatever the directory says.
 *
 * ## Subscriptions are per KEY
 *
 * Every sidebar row reads this for its own (host, epic), and the row
 * render-stability suite pins that a row re-renders only when something it
 * displays moved. A single process-wide listener set would wake every row's
 * snapshot read on every record for any epic; keying the listeners by the
 * same pair the predicate reads keeps a change to one epic's verdict from
 * touching rows that display another's.
 *
 * Process-wide and never persisted, like the stream method-support memo: a
 * restart re-learns it from the first refused open, at the cost of one live
 * dial that was going to be paid anyway.
 */

interface HostOlderThanDataRefusal {
  /** The directory's `version` for the host when the refusal was observed. */
  readonly hostVersion: string | null;
  readonly recordedAt: number;
}

const refusalsByHostId = new Map<
  string,
  Map<string, HostOlderThanDataRefusal>
>();
const listenersByKey = new Map<string, Set<() => void>>();

/**
 * The (host, epic) key the registry, its subscriptions and the recorder share.
 *
 * Written as an ESCAPE, never as the raw byte: a literal NUL in this file made
 * git classify the whole module as binary, so its diff rendered as "Binary
 * files differ" and no reviewer saw a line of it for eight rounds.
 */
export function hostOlderThanDataRefusalKey(
  hostId: string,
  epicId: string,
): string {
  return `${hostId}\u0000${epicId}`;
}

function keyOf(hostId: string, epicId: string): string {
  return hostOlderThanDataRefusalKey(hostId, epicId);
}

function notify(hostId: string, epicId: string): void {
  const listeners = listenersByKey.get(keyOf(hostId, epicId));
  if (listeners === undefined) return;
  for (const listener of Array.from(listeners)) {
    listener();
  }
}

/**
 * Record that `hostId` (at `hostVersion`) refused `epicId`'s chat store as
 * written by a newer build. Idempotent per build: re-recording the same
 * verdict for the same build notifies nobody.
 */
export function recordHostOlderThanDataRefusal(input: {
  readonly hostId: string;
  readonly epicId: string;
  readonly hostVersion: string | null;
  readonly now: number;
}): void {
  const existing = refusalsByHostId.get(input.hostId)?.get(input.epicId);
  if (existing !== undefined && existing.hostVersion === input.hostVersion) {
    return;
  }
  const epics =
    refusalsByHostId.get(input.hostId) ??
    new Map<string, HostOlderThanDataRefusal>();
  epics.set(input.epicId, {
    hostVersion: input.hostVersion,
    recordedAt: input.now,
  });
  refusalsByHostId.set(input.hostId, epics);
  notify(input.hostId, input.epicId);
}

/**
 * Forget a refusal because the host has proven it reads the store - a live
 * `chat.subscribe` on that epic delivered a snapshot. A no-op when nothing was
 * recorded, so callers may report every landed snapshot without checking.
 */
export function clearHostOlderThanDataRefusal(input: {
  readonly hostId: string;
  readonly epicId: string;
}): void {
  const epics = refusalsByHostId.get(input.hostId);
  if (epics === undefined || !epics.delete(input.epicId)) return;
  if (epics.size === 0) refusalsByHostId.delete(input.hostId);
  notify(input.hostId, input.epicId);
}

/**
 * Whether `hostId`, as the build the directory currently reports, is known to
 * refuse `epicId`'s chat store.
 *
 * `hostVersion` is the directory's CURRENT `version` for the host. A recorded
 * verdict about a different build is stale by definition - the upgrade that
 * moved the version is the one remedy this refusal has - so it answers `false`.
 * Two unknown versions (`null` on both sides) compare equal: a directory that
 * never learned the version cannot report the upgrade either, and the
 * landed-snapshot invalidation still covers that host.
 *
 * PURE, deliberately. This is a `useSyncExternalStore` snapshot read for every
 * sidebar row, and an eviction here notified every other row's listener from
 * inside a render ("Cannot update a component while rendering a different
 * component"). A stale entry costs a few bytes; the recorder's effect is where
 * the registry is written, and it replaces the entry the moment the host
 * answers again.
 */
export function hostRefusesEpicStore(input: {
  readonly hostId: string;
  readonly epicId: string;
  readonly hostVersion: string | null;
}): boolean {
  const entry = refusalsByHostId.get(input.hostId)?.get(input.epicId);
  return entry !== undefined && entry.hostVersion === input.hostVersion;
}

/**
 * Listen for changes to ONE (host, epic) verdict. See the module doc for why
 * the subscription is keyed rather than global.
 */
export function subscribeHostOlderThanDataRefusal(
  hostId: string,
  epicId: string,
  listener: () => void,
): () => void {
  const key = keyOf(hostId, epicId);
  const listeners = listenersByKey.get(key) ?? new Set<() => void>();
  listeners.add(listener);
  listenersByKey.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByKey.delete(key);
  };
}

/** Test seam: drop every recorded refusal and wake every listener. */
export function resetHostOlderThanDataRefusalsForTests(): void {
  refusalsByHostId.clear();
  for (const listeners of Array.from(listenersByKey.values())) {
    for (const listener of Array.from(listeners)) {
      listener();
    }
  }
}
