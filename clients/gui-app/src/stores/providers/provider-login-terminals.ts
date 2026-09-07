import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  providerIdSchema,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

/** Which terminal sessions the HOST created for a provider sign-in. */
const MAX_TRACKED_SESSIONS = 32;

const PROVIDER_LOGIN_TERMINALS_PERSIST_KEY = persistKey(
  STORE_KEYS.providerLoginTerminals,
);

interface ProviderLoginTerminalsState {
  readonly providerBySessionKey: Readonly<
    Record<string, ProviderId | undefined>
  >;
  /** Most-recent-first, the eviction order for the bound above. */
  readonly recentKeys: ReadonlyArray<string>;
  /**
   * Bumped on every change to the records, by whichever path made it - this window's own `record()`
   * or a peer window's `storage` event.
   */
  readonly revision: number;
  readonly record: (args: {
    readonly hostId: string;
    readonly sessionId: string;
    readonly providerId: ProviderId;
  }) => void;
}

function sessionKey(hostId: string, sessionId: string): string {
  return `${hostId}:${sessionId}`;
}

interface SharedProviderLoginRecords {
  readonly providerBySessionKey: Readonly<
    Record<string, ProviderId | undefined>
  >;
  readonly recentKeys: ReadonlyArray<string>;
}

const NO_SHARED_RECORDS: SharedProviderLoginRecords = {
  providerBySessionKey: {},
  recentKeys: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A persisted payload, validated entry by entry. */
function sanitizeRecords(state: unknown): SharedProviderLoginRecords {
  if (!isRecord(state)) return NO_SHARED_RECORDS;
  // Bounded and de-duplicated HERE, not only on the write path: this is what hydration merges in,
  // and a current-version payload can carry any number of valid entries.
  const recentKeys = Array.isArray(state.recentKeys)
    ? [
        ...new Set(
          state.recentKeys.filter(
            (entry): entry is string => typeof entry === "string",
          ),
        ),
      ].slice(0, MAX_TRACKED_SESSIONS)
    : [];
  const kept = new Set(recentKeys);
  const providerBySessionKey: Record<string, ProviderId> = {};
  if (isRecord(state.providerBySessionKey)) {
    for (const [entry, value] of Object.entries(state.providerBySessionKey)) {
      if (!kept.has(entry)) continue;
      const providerId = providerIdSchema.safeParse(value);
      if (providerId.success) providerBySessionKey[entry] = providerId.data;
    }
  }
  return { providerBySessionKey, recentKeys };
}

/** The union of two record sets, `preferred` winning a conflicting key. */
function mergeRecords(
  preferred: SharedProviderLoginRecords,
  other: SharedProviderLoginRecords,
): SharedProviderLoginRecords {
  const recentKeys = [
    ...preferred.recentKeys,
    ...other.recentKeys.filter(
      (entry) => !preferred.recentKeys.includes(entry),
    ),
  ].slice(0, MAX_TRACKED_SESSIONS);
  const kept = new Set(recentKeys);
  const providerBySessionKey: Record<string, ProviderId> = {};
  for (const [entry, value] of [
    ...Object.entries(other.providerBySessionKey),
    ...Object.entries(preferred.providerBySessionKey),
  ]) {
    if (value !== undefined && kept.has(entry)) {
      providerBySessionKey[entry] = value;
    }
  }
  return { providerBySessionKey, recentKeys };
}

/** Same keys in the same order, mapped to the same providers. */
function sameRecords(
  a: SharedProviderLoginRecords,
  b: SharedProviderLoginRecords,
): boolean {
  return (
    a.recentKeys.length === b.recentKeys.length &&
    a.recentKeys.every((entry, index) => entry === b.recentKeys[index]) &&
    sameRecordSet(a, b)
  );
}

/** Same keys mapped to the same providers, in any order. */
function sameRecordSet(
  a: SharedProviderLoginRecords,
  b: SharedProviderLoginRecords,
): boolean {
  const aEntries = Object.entries(a.providerBySessionKey);
  return (
    aEntries.length === Object.keys(b.providerBySessionKey).length &&
    aEntries.every(([entry, value]) => b.providerBySessionKey[entry] === value)
  );
}

/** Every record of `subset` is in `superset`, which has more. */
function strictRecordSubset(
  subset: SharedProviderLoginRecords,
  superset: SharedProviderLoginRecords,
): boolean {
  const subsetEntries = Object.entries(subset.providerBySessionKey);
  return (
    subsetEntries.length < Object.keys(superset.providerBySessionKey).length &&
    subsetEntries.every(
      ([entry, value]) => superset.providerBySessionKey[entry] === value,
    )
  );
}

function parsePersistedPayload(raw: string | null): SharedProviderLoginRecords {
  if (raw === null) return NO_SHARED_RECORDS;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? sanitizeRecords(parsed.state) : NO_SHARED_RECORDS;
  } catch {
    return NO_SHARED_RECORDS;
  }
}

/** What the OTHER windows have written, read straight from storage. */
function readSharedRecords(): SharedProviderLoginRecords {
  if (typeof window === "undefined") return NO_SHARED_RECORDS;
  try {
    return parsePersistedPayload(
      window.localStorage.getItem(PROVIDER_LOGIN_TERMINALS_PERSIST_KEY),
    );
  } catch {
    return NO_SHARED_RECORDS;
  }
}

export const useProviderLoginTerminalsStore =
  create<ProviderLoginTerminalsState>()(
    persist(
      (set) => ({
        providerBySessionKey: {},
        recentKeys: [],
        revision: 0,
        record: ({ hostId, sessionId, providerId }) =>
          set((state) => {
            // Merged against what is ON DISK, not just this window's memory.
            const shared = readSharedRecords();
            const key = sessionKey(hostId, sessionId);
            // This window's own order first (it is the one that just acted), then the other window's, so the
            // bound evicts the globally least-recently-seen rather than everything the peer knew.
            const recentKeys = [
              key,
              ...state.recentKeys.filter((entry) => entry !== key),
              ...shared.recentKeys.filter(
                (entry) => entry !== key && !state.recentKeys.includes(entry),
              ),
            ].slice(0, MAX_TRACKED_SESSIONS);
            const kept = new Set(recentKeys);
            const providerBySessionKey: Record<string, ProviderId> = {
              [key]: providerId,
            };
            // Shared first so this window's own view wins a genuine conflict;
            // the same session key can only ever carry one provider anyway.
            for (const [entry, value] of [
              ...Object.entries(shared.providerBySessionKey),
              ...Object.entries(state.providerBySessionKey),
            ]) {
              if (value !== undefined && kept.has(entry) && entry !== key) {
                providerBySessionKey[entry] = value;
              }
            }
            return {
              providerBySessionKey,
              recentKeys,
              revision: state.revision + 1,
            };
          }),
      }),
      {
        ...basePersistOptions(PROVIDER_LOGIN_TERMINALS_PERSIST_KEY),
        partialize: (state): SharedProviderLoginRecords => ({
          providerBySessionKey: state.providerBySessionKey,
          recentKeys: state.recentKeys,
        }),
        // The default merge is a shallow spread, so a persisted `providerBySessionKey: null` would REPLACE
        // the map and the next read would throw on `null[key]`.
        merge: (persisted, current) => ({
          ...current,
          ...sanitizeRecords(persisted),
          revision: current.revision + 1,
        }),
      },
    ),
  );

// Another window started a sign-in: follow it.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== PROVIDER_LOGIN_TERMINALS_PERSIST_KEY) return;
    // MERGED from the event's own payload, not re-read from storage.
    const current = useProviderLoginTerminalsStore.getState();
    const peer = parsePersistedPayload(event.newValue);
    const merged = mergeRecords(current, peer);
    if (!sameRecords(current, merged)) {
      useProviderLoginTerminalsStore.setState({
        ...merged,
        revision: current.revision + 1,
      });
      return;
    }
    if (sameRecordSet(peer, merged) || !strictRecordSubset(peer, merged)) {
      return;
    }
    // Persist writes on every `setState`, changed or not; `revision` stays,
    // because nothing this window classifies against has changed.
    useProviderLoginTerminalsStore.setState({});
  });
}

/** Records a host-created sign-in terminal. Call this wherever the host hands
 *  one back, not only where a tile is opened for it. */
export function recordProviderLoginTerminal(args: {
  readonly hostId: string;
  readonly sessionId: string;
  readonly providerId: ProviderId;
}): void {
  useProviderLoginTerminalsStore.getState().record(args);
}

/**
 * The provider this session was opened to sign in to, or `null` for an ordinary terminal. Read
 * outside React - the ref builders that need it are plain functions.
 */
export function providerLoginTerminalProviderId(
  hostId: string,
  sessionId: string,
): ProviderId | null {
  return (
    useProviderLoginTerminalsStore.getState().providerBySessionKey[
      sessionKey(hostId, sessionId)
    ] ?? null
  );
}
