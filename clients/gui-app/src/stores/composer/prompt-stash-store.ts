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

interface PromptStashState {
  readonly rows: ReadonlyArray<PromptStashRow>;
  readonly hydrate: () => Promise<void>;
  readonly save: (snapshot: PromptStashSnapshot) => Promise<void>;
  readonly remove: (entryId: string) => Promise<void>;
  readonly markUnavailable: (entryId: string) => void;
}

let hydration: Promise<void> | null = null;
const PROMPT_STASH_CHANNEL = "traycer-gui-app:prompt-stash:v1";

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
// by an intervening read's token - it is applied purely by revision. It also
// bumps the token itself, invalidating any in-flight read so a stale one
// that resolves afterward cannot later overwrite the mutation it raced.
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
  issuedLoadToken += 1;
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
if (
  typeof window !== "undefined" &&
  typeof window.BroadcastChannel !== "undefined"
) {
  promptStashChannel = new window.BroadcastChannel(PROMPT_STASH_CHANNEL);
  promptStashChannel.addEventListener("message", (event: MessageEvent) => {
    const revision = messageRevision(event.data);
    // A message that is provably no newer than what's already applied never
    // needs a re-read; an unrecognized/older-shaped payload falls through and
    // still triggers one, which `applyLoadIfFresher` then gates on its own.
    if (revision !== null && revision <= appliedRevision) return;
    issuedLoadToken += 1;
    const loadToken = issuedLoadToken;
    void loadPromptStashSnapshot()
      .then(({ rows, revision: loadedRevision }) => {
        applyLoadIfFresher(loadToken, rows, loadedRevision);
      })
      .catch(() => undefined);
  });
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
