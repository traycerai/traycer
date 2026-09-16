import { create } from "zustand";

import type {
  PromptStashEntry,
  PromptStashImageBlob,
  PromptStashRow,
  PromptStashSnapshot,
} from "@/lib/composer/prompt-stash-codec";
import { promptStashRowId } from "@/lib/composer/prompt-stash-codec";
import {
  deletePromptStashEntry,
  loadPromptStashSnapshot,
  PromptStashWriteNoLongerCurrentError,
  savePromptStashSnapshot,
  savePromptStashSnapshotWhile,
} from "@/lib/composer/prompt-stash-repository";
import { PROMPT_STASH_CHANNEL } from "@/lib/composer/prompt-stash-channel";

interface PromptStashState {
  readonly rows: ReadonlyArray<PromptStashRow>;
  readonly hydrate: () => Promise<void>;
  readonly save: (snapshot: PromptStashSnapshot) => Promise<void>;
  /**
   * {@link save}, abandoned if `stillCurrent()` stops holding.
   *
   * `save` awaits `hydrate` first, and hydration can be slow or already
   * in flight - so a caller that checked a precondition before calling is
   * checking it against a world that may be several awaits stale by the time
   * the repository write happens. The unrecorded-prompt handoff is the caller
   * this exists for: it must not write the OUTGOING account's prompt into the
   * shared, unpartitioned stash after an identity change, and its own
   * pre-call check cannot see a change that lands during hydration.
   *
   * Checked twice on purpose - before the await and after it - because those
   * answer different questions, and only the second one covers the gap.
   */
  readonly saveWhile: (
    snapshot: PromptStashSnapshot,
    stillCurrent: () => boolean,
  ) => Promise<void>;
  readonly remove: (entryId: string) => Promise<void>;
  /**
   * Host/cloud ingest of an immutable stash-entry. No-ops when the id
   * is already local (the local copy may hold blobs the host echo does
   * not). Never a host upsert — that would re-publish an own row.
   */
  /**
   * `stillCurrent` is the CALLER's liveness question, threaded all the way to
   * the repository's fenced write rather than asked once here. `hydrate()`
   * below is an await, and so is the write - a guard the caller applies before
   * calling this cannot cover either, which is how a remote stash entry
   * belonging to one account came to be written, published and persisted under
   * the next one.
   */
  readonly ingestRemote: (
    entry: PromptStashEntry,
    imagesByHash: ReadonlyMap<string, PromptStashImageBlob>,
    stillCurrent: () => boolean,
  ) => Promise<void>;
  readonly dropRemote: (entryId: string) => Promise<void>;
  readonly markUnavailable: (entryId: string) => void;
}

let hydration: Promise<void> | null = null;

// Cross-window refresh ordering (repository "Cross-window state refresh"
// contract): every mutation bumps `meta.revision` inside its own IndexedDB
// transaction, so revision order always matches true commit order even when
// JS-visible completion order does not.
//
// Load tokens order asynchronous READS ONLY (hydrate, or a
// BroadcastChannel-triggered reload): a read is applied only if it is still
// the most recently issued read AND at least as new as the currently applied
// revision, so two reads completing out of order can never regress the
// store.
//
// A local save/delete result is authoritative and must never be suppressed
// by an intervening read's token - it is applied purely by revision. It does
// not invalidate in-flight reads: the revision gate already rejects older
// snapshots, while a peer read that committed later must remain eligible.
let issuedLoadToken = 0;
let appliedRevision = -1;

function applyLoadIfFresher(
  loadToken: number,
  rows: ReadonlyArray<PromptStashRow>,
  revision: number,
): void {
  if (loadToken !== issuedLoadToken) return;
  if (revision <= appliedRevision) return;
  appliedRevision = revision;
  usePromptStashStore.setState({ rows });
}

function applyMutationResult(
  rows: ReadonlyArray<PromptStashRow>,
  revision: number,
): void {
  if (revision <= appliedRevision) return;
  appliedRevision = revision;
  usePromptStashStore.setState({ rows });
}

export const usePromptStashStore = create<PromptStashState>()((set, get) => ({
  rows: [],
  hydrate: () => {
    hydration ??= (async () => {
      issuedLoadToken += 1;
      const loadToken = issuedLoadToken;
      const { rows, revision } = await loadPromptStashSnapshot();
      applyLoadIfFresher(loadToken, rows, revision);
    })().catch((error: unknown) => {
      hydration = null;
      throw error;
    });
    return hydration;
  },
  save: async (snapshot) => {
    await get().hydrate();
    const { rows, revision } = await savePromptStashSnapshot(snapshot);
    applyMutationResult(rows, revision);
    publishPromptStashChange(revision);
  },
  saveWhile: async (snapshot, stillCurrent) => {
    if (!stillCurrent()) return;
    await get().hydrate();
    // Cheap and early, but NOT the guarantee: see below.
    if (!stillCurrent()) return;
    try {
      // The check that actually holds is the one INSIDE the transaction.
      // These two are before `runTransaction` even opens one, and a
      // transaction can queue behind another and commit long after both
      // passed - so on their own they let a stale durable write through.
      const { rows, revision } = await savePromptStashSnapshotWhile(
        snapshot,
        stillCurrent,
      );
      // And the PUBLICATION is fenced too. A committed write is only half of
      // what a caller sees; pushing these rows into the in-memory store and
      // broadcasting the revision would put the abandoned entry in front of
      // whoever is here now, even with the durable half correctly rolled back.
      if (!stillCurrent()) return;
      applyMutationResult(rows, revision);
      publishPromptStashChange(revision);
    } catch (error: unknown) {
      // The abandonment is not a failure - it is this function doing its job -
      // so it does not propagate to a caller that only asked for a best-effort
      // save. Anything else still does.
      if (error instanceof PromptStashWriteNoLongerCurrentError) return;
      // An EXTERNALLY aborted transaction lands here too - the teardown called
      // `abortLiveFencedPromptStashWrites` while this one was mid-write, so
      // IndexedDB rejected it rather than any check of ours. Same meaning:
      // abandoned on purpose, rolled back whole, not a failure to report.
      if (!stillCurrent()) return;
      throw error;
    }
  },
  remove: async (entryId) => {
    await get().hydrate();
    const { rows, revision } = await deletePromptStashEntry(entryId);
    applyMutationResult(rows, revision);
    publishPromptStashChange(revision);
  },
  ingestRemote: async (
    entry,
    imagesByHash: ReadonlyMap<string, PromptStashImageBlob>,
    stillCurrent: () => boolean,
  ) => {
    await get().hydrate();
    if (!stillCurrent()) return;
    if (get().rows.some((row) => promptStashRowId(row) === entry.id)) {
      return;
    }
    try {
      // The FENCED write: it re-asks inside the transaction, immediately
      // before the first mutation, and aborts the whole transaction when the
      // answer has changed. A check out here could only cover the gap up to
      // the call - and `hydrate()` above is itself an await.
      const { rows, revision } = await savePromptStashSnapshotWhile(
        { entry, imagesByHash },
        stillCurrent,
      );
      // And again before PUBLISHING: a committed row is only half of what a
      // viewer sees, and the in-memory rows are the other half.
      if (!stillCurrent()) return;
      applyMutationResult(rows, revision);
      publishPromptStashChange(revision);
    } catch (error: unknown) {
      // Abandonment is this fence doing its job, not a failure to report.
      if (error instanceof PromptStashWriteNoLongerCurrentError) return;
      // An externally aborted transaction - a teardown calling
      // `abortLiveFencedPromptStashWrites` mid-write - means the same thing.
      if (!stillCurrent()) return;
      throw error;
    }
  },
  dropRemote: async (entryId) => {
    await get().hydrate();
    if (!get().rows.some((row) => promptStashRowId(row) === entryId)) {
      return;
    }
    const { rows, revision } = await deletePromptStashEntry(entryId);
    applyMutationResult(rows, revision);
    publishPromptStashChange(revision);
  },
  markUnavailable: (entryId) => {
    set((state) => ({
      rows: state.rows.map((row) =>
        row.kind === "entry" && row.entry.id === entryId
          ? {
              kind: "unavailable",
              id: row.entry.id,
              createdAt: row.entry.createdAt,
              content: row.entry.content,
            }
          : row,
      ),
    }));
  },
}));

void usePromptStashStore
  .getState()
  .hydrate()
  .catch(() => undefined);

let promptStashChannel: BroadcastChannel | null = null;

function reloadPromptStashFromChannel(): void {
  issuedLoadToken += 1;
  const loadToken = issuedLoadToken;
  void loadPromptStashSnapshot()
    .then(({ rows, revision }) => {
      applyLoadIfFresher(loadToken, rows, revision);
    })
    .catch(() => undefined);
}

if (
  typeof window !== "undefined" &&
  typeof window.BroadcastChannel !== "undefined"
) {
  promptStashChannel = new window.BroadcastChannel(PROMPT_STASH_CHANNEL);
  promptStashChannel.addEventListener("message", (event: MessageEvent) => {
    if (messageIsReset(event.data)) {
      issuedLoadToken += 1;
      appliedRevision = -1;
      hydration = null;
      usePromptStashStore.setState({ rows: [] });
      // Reset delivery can race a save into the newly recreated database.
      // Reload after resetting the revision generation so a delayed reset
      // cannot hide that already-durable post-reset mutation.
      reloadPromptStashFromChannel();
      return;
    }
    const revision = messageRevision(event.data);
    // A message that is provably no newer than what's already applied never
    // needs a re-read; an unrecognized/older-shaped payload falls through and
    // still triggers one, which `applyLoadIfFresher` then gates on its own.
    if (revision !== null && revision <= appliedRevision) return;
    reloadPromptStashFromChannel();
  });
}

function messageIsReset(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    data.type === "reset"
  );
}

function publishPromptStashChange(revision: number): void {
  promptStashChannel?.postMessage({ type: "changed", revision });
}

function messageRevision(data: unknown): number | null {
  if (typeof data !== "object" || data === null || !("revision" in data)) {
    return null;
  }
  return typeof data.revision === "number" ? data.revision : null;
}
