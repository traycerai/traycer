import { create } from "zustand";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";

/**
 * Navigate-safe pending OAuth state for the Model Providers tab, mirroring
 * `mcp-pending-auth-store.ts`.
 */
export type ModelProviderPendingAuthKey = {
  readonly hostId: string;
  readonly providerId: ProviderId;
  readonly modelProviderId: string;
};

export type ModelProviderPendingAuthEntry = {
  readonly key: ModelProviderPendingAuthKey;
  readonly attemptId: string;
  readonly startedAt: number;
  readonly authorizationUrl: string;
  /** `auto` completes on the server's loopback; `code` needs a paste. */
  readonly method: "auto" | "code";
  readonly instructions: string | null;
};

function keyString(key: ModelProviderPendingAuthKey): string {
  return [key.hostId, key.providerId, key.modelProviderId].join("\0");
}

interface ModelProviderPendingAuthStore {
  readonly entries: Readonly<Record<string, ModelProviderPendingAuthEntry>>;
  readonly upsert: (entry: ModelProviderPendingAuthEntry) => void;
  /**
   * Drops the record for `key` ONLY if it still belongs to `attemptId`. The guard is load-bearing,
   * not defensive dressing.
   */
  readonly remove: (
    key: ModelProviderPendingAuthKey,
    attemptId: string,
  ) => void;
  readonly get: (
    key: ModelProviderPendingAuthKey,
  ) => ModelProviderPendingAuthEntry | null;
}

export const useModelProviderPendingAuthStore =
  create<ModelProviderPendingAuthStore>()((set, get) => ({
    entries: {},
    upsert: (entry) => {
      const id = keyString(entry.key);
      set((state) => ({ entries: { ...state.entries, [id]: entry } }));
    },
    remove: (key, attemptId) => {
      const id = keyString(key);
      set((state) => {
        const existing = Object.hasOwn(state.entries, id)
          ? state.entries[id]
          : null;
        if (existing === null || existing.attemptId !== attemptId) {
          return state;
        }
        const next = { ...state.entries };
        delete next[id];
        return { entries: next };
      });
    },
    get: (key) => get().entries[keyString(key)] ?? null,
  }));

export function modelProviderPendingAuthKeyString(
  key: ModelProviderPendingAuthKey,
): string {
  return keyString(key);
}

/**
 * The attempt the tab AUTO-ADOPTS on mount: the most recently started of one host+provider's live
 * attempts.
 */
export function findModelProviderPendingAuth(
  entries: Readonly<Record<string, ModelProviderPendingAuthEntry>>,
  args: { readonly providerId: ProviderId; readonly hostId: string | null },
): ModelProviderPendingAuthEntry | null {
  const hostId = args.hostId;
  if (hostId === null) return null;
  let newest: ModelProviderPendingAuthEntry | null = null;
  for (const entry of Object.values(entries)) {
    if (entry.key.hostId !== hostId) continue;
    if (entry.key.providerId !== args.providerId) continue;
    if (newest === null || entry.startedAt > newest.startedAt) newest = entry;
  }
  return newest;
}

/**
 * The attempt belonging to ONE row, by its full key. Separate from {@link
 * findModelProviderPendingAuth} on purpose.
 */
export function getModelProviderPendingAuth(
  entries: Readonly<Record<string, ModelProviderPendingAuthEntry>>,
  key: ModelProviderPendingAuthKey,
): ModelProviderPendingAuthEntry | null {
  const id = keyString(key);
  return Object.hasOwn(entries, id) ? entries[id] : null;
}
