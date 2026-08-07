import { create } from "zustand";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";

/**
 * Navigate-safe pending OAuth state for the Model Providers tab, mirroring
 * `mcp-pending-auth-store.ts`.
 *
 * The key is the host's own attempt identity - `(providerId, modelProviderId)`
 * - because that is what the host keys its pending-auth registry by, and
 * re-issuing `awaitModelProviderAuth` with the same pair plus `attemptId`
 * resumes the same attempt after the user navigates away from Settings and
 * back.
 *
 * `attemptId` is the field this store has that the MCP one does not, and it is
 * the whole reason the entry is worth keeping: attempts are single-flight per
 * key and a newer one SUPERSEDES the pending one, so a resumed panel that
 * polled by key alone would be handed the newer attempt's status under the
 * impression it was its own.
 *
 * No secret is ever stored here. `authorizationUrl` and `instructions` are what
 * the provider itself put on screen.
 */
export type ModelProviderPendingAuthKey = {
  readonly providerId: ProviderId;
  readonly modelProviderId: string;
};

export type ModelProviderPendingAuthEntry = {
  readonly key: ModelProviderPendingAuthKey;
  readonly hostId: string;
  readonly attemptId: string;
  readonly startedAt: number;
  readonly authorizationUrl: string;
  /** `auto` completes on the server's loopback; `code` needs a paste. */
  readonly method: "auto" | "code";
  readonly instructions: string | null;
};

function keyString(key: ModelProviderPendingAuthKey): string {
  return [key.providerId, key.modelProviderId].join("\0");
}

interface ModelProviderPendingAuthStore {
  readonly entries: Readonly<Record<string, ModelProviderPendingAuthEntry>>;
  readonly upsert: (entry: ModelProviderPendingAuthEntry) => void;
  readonly remove: (key: ModelProviderPendingAuthKey) => void;
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
    remove: (key) => {
      const id = keyString(key);
      set((state) => {
        if (!(id in state.entries)) return state;
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
 * The one live attempt for a provider on a host, or null.
 *
 * Takes the whole entry map so a caller can subscribe to `entries` (the only
 * reactive slot) and still ask this question. `hostId` is part of the match
 * because Settings can be scoped to a non-active host: an attempt started while
 * viewing host A must not resume onto host B's tab, where its `attemptId` names
 * nothing.
 */
export function findModelProviderPendingAuth(
  entries: Readonly<Record<string, ModelProviderPendingAuthEntry>>,
  args: { readonly providerId: ProviderId; readonly hostId: string | null },
): ModelProviderPendingAuthEntry | null {
  if (args.hostId === null) return null;
  for (const entry of Object.values(entries)) {
    if (
      entry.key.providerId === args.providerId &&
      entry.hostId === args.hostId
    ) {
      return entry;
    }
  }
  return null;
}
