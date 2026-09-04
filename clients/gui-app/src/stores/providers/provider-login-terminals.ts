import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  providerIdSchema,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

/**
 * Which terminal sessions the HOST created for a provider sign-in.
 *
 * The tile ref records this too (`origin: "provider-login"`), but a tile is the
 * wrong place for it to LIVE: the sidebar, the command palette and a drag-drop
 * all mint fresh refs straight from `terminal.list`, which carries no origin,
 * so a sign-in terminal reopened from any of them becomes an ordinary tile that
 * believes it owns the session. When the host later loses the PTY that tile
 * dispatches `terminal.create` for the id and spawns a bare shell with none of
 * the provider's spawn env - a prompt that looks like the sign-in terminal and
 * cannot sign anyone in.
 *
 * Keyed by host + session because session ids are only unique within a host.
 *
 * Persisted, and deliberately so: the whole point is to answer the question
 * after the originating tile is gone, which includes after a renderer reload.
 * Bounded to {@link MAX_TRACKED_SESSIONS} most-recent entries - a sign-in
 * terminal is short-lived, ids are uuids so a stale entry can never be
 * re-matched, and an unbounded map in localStorage would grow forever.
 *
 * The durable home for this is a field on `terminal.list` itself, so the host
 * answers it for every client and every open path. That is a wire change with
 * a frozen-line bump; this store closes the same hole client-side until then.
 */
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
   * Bumped on every change to the records, by whichever path made it - this
   * window's own `record()` or a peer window's `storage` event.
   *
   * The reconciliation passes that CLASSIFY tabs read this store imperatively
   * (`providerLoginTerminalProviderId` is a plain function, called from inside
   * an effect keyed on host state), so nothing else would re-run them when
   * provenance arrives. Without a wake, a session another window listed and
   * adopted before its record arrived stays an ordinary tab - importable,
   * recreatable as a bare shell - until some unrelated host event happens to
   * re-run the pass. Every reconciliation key folds this in.
   *
   * Global rather than per host, deliberately: records change when a sign-in
   * STARTS, which is rare, and a per-host counter would have to attribute a
   * merged peer payload key by key. Not persisted - it is a fact about this
   * window's memory, not about the records.
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

/**
 * A persisted payload, validated entry by entry.
 *
 * Nothing here is trusted: this reads a value another process wrote, so a
 * malformed one must degrade to "no records" rather than reach the store. The
 * shape matters as much as the values - a persisted `providerBySessionKey:
 * null` merged in verbatim would make `providerLoginTerminalProviderId` index
 * `null` and THROW at the very moment it is asked whether a live session is a
 * sign-in. Session ids are uuids, so a dropped entry can never be re-matched
 * and costs nothing.
 */
function sanitizeRecords(state: unknown): SharedProviderLoginRecords {
  if (!isRecord(state)) return NO_SHARED_RECORDS;
  // Bounded and de-duplicated HERE, not only on the write path: this is what
  // hydration merges in, and a current-version payload can carry any number of
  // valid entries. The bound is the store's invariant, so every entry point
  // holds it.
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
  if (a.recentKeys.length !== b.recentKeys.length) return false;
  if (a.recentKeys.some((entry, index) => entry !== b.recentKeys[index])) {
    return false;
  }
  const aEntries = Object.entries(a.providerBySessionKey);
  if (aEntries.length !== Object.keys(b.providerBySessionKey).length) {
    return false;
  }
  return aEntries.every(
    ([entry, value]) => b.providerBySessionKey[entry] === value,
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
            // Persist writes the whole map, so two windows completing sign-ins
            // before either sees the other's `storage` event would have the
            // second write drop the first session - and the listener below
            // then rehydrates from that already-overwritten value, so the lost
            // origin never comes back. The consequence is not cosmetic: an
            // unclassified live session is one a tile recreates as a bare
            // shell.
            const shared = readSharedRecords();
            const key = sessionKey(hostId, sessionId);
            // This window's own order first (it is the one that just acted),
            // then the other window's, so the bound evicts the globally
            // least-recently-seen rather than everything the peer knew.
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
        // The default merge is a shallow spread, so a persisted
        // `providerBySessionKey: null` would REPLACE the map and the next read
        // would throw on `null[key]`. Version-gating does not cover it - a
        // malformed value can carry the current version - so the merge itself
        // validates.
        merge: (persisted, current) => ({
          ...current,
          ...sanitizeRecords(persisted),
          revision: current.revision + 1,
        }),
      },
    ),
  );

// Another window started a sign-in: follow it. Hydration alone is not enough
// because the window that has to ANSWER this question is usually already open -
// a second window lists the same host's independent sessions and would adopt
// the sign-in session as an ordinary terminal, which is exactly the bare-shell
// failure above. The `storage` event fires only in OTHER same-origin windows,
// never the one that wrote, so this cannot loop with `record`.
//
// A peer's `localStorage.clear()` (`event.key === null`) is deliberately NOT
// followed, which is where this departs from `feature-announcements-store`. A
// session that was opened as a sign-in did not stop being one because storage
// was wiped, and the two failure directions are not symmetric: a record kept
// past its usefulness costs nothing (keys are host + uuid, bounded at 32, and
// can never re-match), while a record dropped for a LIVE session is the
// bare-shell recreation this store exists to prevent. The next `record()` in
// this window writes the in-memory set back out, so the peer's wipe does not
// even win the disk for long.
//
// This closes the window-to-window gap, not the general one: the durable answer
// is still an origin field on `terminal.list`, which would also cover a client
// that never saw the write at all.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== PROVIDER_LOGIN_TERMINALS_PERSIST_KEY) return;
    // MERGED from the event's own payload, not re-read from storage. Two
    // windows can each read before either writes, so the value on disk may
    // already have dropped one of the two records - rehydrating from it would
    // adopt that loss, while the event still carries what the peer wrote. The
    // union keeps every origin this window has ever been told about, which is
    // what the classifier actually reads.
    //
    // A `removeItem` arrives with `newValue: null` and merges as "nothing
    // new", for the same reason a `clear()` is ignored above.
    const current = useProviderLoginTerminalsStore.getState();
    const merged = mergeRecords(current, parsePersistedPayload(event.newValue));
    // A merge that adds nothing writes nothing. `setState` goes through
    // persist, which writes the WHOLE payload back to storage, and that write
    // is a `storage` event in the peer. Two windows holding the same set in
    // different orders (each put its own record first) would otherwise trade
    // it forever: A's write fires B's event, B's merge keeps B's order and
    // writes it, which fires A's event, and so on - every hop bumping
    // `revision` and re-running each reconciliation keyed on it. The peer's
    // ORDER is not something this window needs: the union is what the
    // classifier reads, and the bound evicts by this window's own recency.
    if (sameRecords(current, merged)) return;
    useProviderLoginTerminalsStore.setState({
      ...merged,
      revision: current.revision + 1,
    });
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

/** The provider this session was opened to sign in to, or `null` for an
 *  ordinary terminal. Read outside React - the ref builders that need it are
 *  plain functions. */
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
