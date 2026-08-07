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
 * The attempt to resume when the Model Providers tab mounts for one provider on
 * one host: the most recently started of that host+provider's live attempts.
 *
 * Matching is EXACT on `hostId` and `providerId` - never "the first row in the
 * map" - because the map spans every host and every Traycer provider, and two
 * different upstream providers on the same host can each hold a live attempt at
 * once (the host's single-flight rule is per `(providerId, modelProviderId)`).
 * Newest wins so the choice is deterministic and lands on the flow the user was
 * most recently in; the caller still matches `modelProviderId` before handing
 * the record to a dialog, so a row never resumes another row's attempt.
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
