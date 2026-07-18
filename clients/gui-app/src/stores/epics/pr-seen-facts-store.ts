import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import type { PrSeenFact } from "@/lib/pr/pr-changed-dot";

/**
 * Renderer-owned seen-facts baseline for the PR changed-dot (T7).
 * Scoped per `(hostId, epicId)` so baselines never mix across machines.
 *
 * - `factsByPrKey`: last-seen state / checks rollup / comment count per PR
 * - `seeded`: first frame for this scope has been absorbed (silent; no dot)
 * - `hasChanged`: directional delta lit the rail badge since last panel open
 */
export interface PrSeenFactsScopeState {
  readonly seeded: boolean;
  readonly hasChanged: boolean;
  readonly factsByPrKey: Readonly<Record<string, PrSeenFact>>;
}

export interface PrSeenFactsStore {
  readonly stateByScopeKey: Readonly<Record<string, PrSeenFactsScopeState>>;
  readonly seedBaseline: (
    hostId: string,
    epicId: string,
    factsByPrKey: Readonly<Record<string, PrSeenFact>>,
  ) => void;
  readonly advanceBaseline: (
    hostId: string,
    epicId: string,
    factsByPrKey: Readonly<Record<string, PrSeenFact>>,
  ) => void;
  readonly markChanged: (hostId: string, epicId: string) => void;
  readonly clearChanged: (hostId: string, epicId: string) => void;
}

export const defaultPrSeenFactsScopeState: PrSeenFactsScopeState = {
  seeded: false,
  hasChanged: false,
  factsByPrKey: {},
};

export const PR_SEEN_FACTS_PERSIST_KEY = persistKey(STORE_KEYS.prSeenFacts);

export function prSeenFactsScopeKey(hostId: string, epicId: string): string {
  return `${hostId}\u0000${epicId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseChecksRollup(value: unknown): PrSeenFact["checks"] | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const { success, failure, pending, total } = value;
  if (
    typeof success !== "number" ||
    typeof failure !== "number" ||
    typeof pending !== "number" ||
    typeof total !== "number"
  ) {
    return undefined;
  }
  return { success, failure, pending, total };
}

function parsePrSeenFact(value: unknown): PrSeenFact | null {
  if (!isRecord(value)) return null;
  const { state, checks, commentCount } = value;
  if (state !== "open" && state !== "merged" && state !== "closed") {
    return null;
  }
  if (
    commentCount !== null &&
    commentCount !== undefined &&
    typeof commentCount !== "number"
  ) {
    return null;
  }
  const parsedChecks = parseChecksRollup(checks);
  if (parsedChecks === undefined) return null;
  return {
    state,
    checks: parsedChecks,
    commentCount: typeof commentCount === "number" ? commentCount : null,
  };
}

function migrateScopeState(value: unknown): PrSeenFactsScopeState {
  if (!isRecord(value)) return defaultPrSeenFactsScopeState;
  const factsRaw = value.factsByPrKey;
  const factsByPrKey: Record<string, PrSeenFact> = {};
  if (isRecord(factsRaw)) {
    for (const [key, fact] of Object.entries(factsRaw)) {
      const parsed = parsePrSeenFact(fact);
      if (parsed !== null) factsByPrKey[key] = parsed;
    }
  }
  return {
    seeded: value.seeded === true,
    hasChanged: value.hasChanged === true,
    factsByPrKey,
  };
}

export function migratePrSeenFactsPersistedState(persisted: unknown): {
  readonly stateByScopeKey: Record<string, PrSeenFactsScopeState>;
} {
  if (!isRecord(persisted) || !isRecord(persisted.stateByScopeKey)) {
    return { stateByScopeKey: {} };
  }
  return {
    stateByScopeKey: Object.fromEntries(
      Object.entries(persisted.stateByScopeKey).map(([scopeKey, value]) => [
        scopeKey,
        migrateScopeState(value),
      ]),
    ),
  };
}

function factsMapsEqual(
  left: Readonly<Record<string, PrSeenFact>>,
  right: Readonly<Record<string, PrSeenFact>>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key)) return false;
    const a = left[key];
    const b = right[key];
    if (a.state !== b.state) return false;
    if (a.commentCount !== b.commentCount) return false;
    if (a.checks === null && b.checks === null) continue;
    if (a.checks === null || b.checks === null) return false;
    if (
      a.checks.success !== b.checks.success ||
      a.checks.failure !== b.checks.failure ||
      a.checks.pending !== b.checks.pending ||
      a.checks.total !== b.checks.total
    ) {
      return false;
    }
  }
  return true;
}

export const usePrSeenFactsStore = create<PrSeenFactsStore>()(
  persist(
    (set) => ({
      stateByScopeKey: {},

      seedBaseline: (hostId, epicId, factsByPrKey) => {
        const scopeKey = prSeenFactsScopeKey(hostId, epicId);
        set((state) => {
          const current =
            state.stateByScopeKey[scopeKey] ?? defaultPrSeenFactsScopeState;
          if (
            current.seeded &&
            !current.hasChanged &&
            factsMapsEqual(current.factsByPrKey, factsByPrKey)
          ) {
            return state;
          }
          return {
            stateByScopeKey: {
              ...state.stateByScopeKey,
              [scopeKey]: {
                seeded: true,
                hasChanged: false,
                factsByPrKey,
              },
            },
          };
        });
      },

      advanceBaseline: (hostId, epicId, factsByPrKey) => {
        const scopeKey = prSeenFactsScopeKey(hostId, epicId);
        set((state) => {
          const current =
            state.stateByScopeKey[scopeKey] ?? defaultPrSeenFactsScopeState;
          if (
            current.seeded &&
            factsMapsEqual(current.factsByPrKey, factsByPrKey)
          ) {
            return state;
          }
          return {
            stateByScopeKey: {
              ...state.stateByScopeKey,
              [scopeKey]: {
                ...current,
                seeded: true,
                factsByPrKey,
              },
            },
          };
        });
      },

      markChanged: (hostId, epicId) => {
        const scopeKey = prSeenFactsScopeKey(hostId, epicId);
        set((state) => {
          const current =
            state.stateByScopeKey[scopeKey] ?? defaultPrSeenFactsScopeState;
          if (current.hasChanged) return state;
          return {
            stateByScopeKey: {
              ...state.stateByScopeKey,
              [scopeKey]: { ...current, hasChanged: true },
            },
          };
        });
      },

      clearChanged: (hostId, epicId) => {
        const scopeKey = prSeenFactsScopeKey(hostId, epicId);
        set((state) => {
          const current =
            state.stateByScopeKey[scopeKey] ?? defaultPrSeenFactsScopeState;
          if (!current.hasChanged) return state;
          return {
            stateByScopeKey: {
              ...state.stateByScopeKey,
              [scopeKey]: { ...current, hasChanged: false },
            },
          };
        });
      },
    }),
    {
      ...basePersistOptions(PR_SEEN_FACTS_PERSIST_KEY),
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => ({
        stateByScopeKey: Object.entries(state.stateByScopeKey).reduce<
          Record<string, unknown>
        >((acc, [scopeKey, scopeState]) => {
          acc[scopeKey] = {
            seeded: scopeState.seeded,
            hasChanged: scopeState.hasChanged,
            factsByPrKey: scopeState.factsByPrKey,
          };
          return acc;
        }, {}),
      }),
      migrate: (persisted) => migratePrSeenFactsPersistedState(persisted),
    },
  ),
);

export function selectPrSeenFactsScope(hostId: string, epicId: string) {
  const scopeKey = prSeenFactsScopeKey(hostId, epicId);
  return (s: PrSeenFactsStore): PrSeenFactsScopeState =>
    s.stateByScopeKey[scopeKey] ?? defaultPrSeenFactsScopeState;
}

export function selectPrHasChangedDot(hostId: string | null, epicId: string) {
  return (s: PrSeenFactsStore): boolean => {
    if (hostId === null) return false;
    return selectPrSeenFactsScope(hostId, epicId)(s).hasChanged;
  };
}
