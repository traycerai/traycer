import { create } from "zustand";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";

/**
 * Navigate-safe pending OAuth state for the Model Providers tab, mirroring
 * `mcp-pending-auth-store.ts`.
 *
 * The key carries `hostId` even though the HOST's own registry keys attempts by
 * `(providerId, modelProviderId)` alone. The two are keying different things:
 * the host keys within one host, while this store is a single client-side map
 * spanning every host Settings can be pointed at. Without `hostId`, starting a
 * sign-in for the same provider on host B would overwrite host A's record, and
 * A's panel would then resume against an `attemptId` that names nothing on A -
 * the same "a visible host name must match the client behind it" rule the rest
 * of Settings is built on.
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
   * Drops the record for `key` ONLY if it still belongs to `attemptId`.
   *
   * The guard is load-bearing, not defensive dressing. Every teardown path
   * (cancel, expiry, a late completion) resolves asynchronously, and by the
   * time one lands the user may already have started a NEWER attempt for the
   * same row - which legitimately overwrote this slot. An unconditional delete
   * would then discard the live attempt's only resume record, leaving a host
   * attempt holding a server lease that no surface can reach.
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
 * The attempt the tab AUTO-ADOPTS on mount: the most recently started of one
 * host+provider's live attempts.
 *
 * Two different upstream providers on the same host can each hold a live
 * attempt (the host's single-flight rule is per `(providerId,
 * modelProviderId)`), so this has to pick one, and newest wins - it is the flow
 * the user was most recently in, and it is deterministic where "first row in
 * the map" was an accident of insertion order.
 *
 * This answers "which row should re-open by itself", NOT "does the row the user
 * just clicked have an attempt". That second question is
 * {@link getModelProviderPendingAuth}, and conflating them is what left the
 * older of two live attempts unreachable: it existed in the store, but the only
 * lookup was one that could never name it.
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
 * The attempt belonging to ONE row, by its full key.
 *
 * Separate from {@link findModelProviderPendingAuth} on purpose. The tab uses
 * that one to decide which row re-opens by itself and this one for whichever
 * row the user actually opened - so an older live attempt stays resumable
 * instead of being restart-only just because a newer attempt for a different
 * provider exists.
 */
export function getModelProviderPendingAuth(
  entries: Readonly<Record<string, ModelProviderPendingAuthEntry>>,
  key: ModelProviderPendingAuthKey,
): ModelProviderPendingAuthEntry | null {
  const id = keyString(key);
  return Object.hasOwn(entries, id) ? entries[id] : null;
}
