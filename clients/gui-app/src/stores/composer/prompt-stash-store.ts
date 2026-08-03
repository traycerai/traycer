import { create } from "zustand";

import type {
  PromptStashRow,
  PromptStashSnapshot,
} from "@/lib/composer/prompt-stash-codec";
import {
  deletePromptStashEntry,
  loadPromptStashSnapshot,
  savePromptStashSnapshot,
} from "@/lib/composer/prompt-stash-repository";
import { PROMPT_STASH_CHANNEL } from "@/lib/composer/prompt-stash-channel";

interface PromptStashState {
  readonly rows: ReadonlyArray<PromptStashRow>;
  readonly hydrate: () => Promise<void>;
  readonly save: (snapshot: PromptStashSnapshot) => Promise<void>;
  readonly remove: (entryId: string) => Promise<void>;
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
  remove: async (entryId) => {
    await get().hydrate();
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
