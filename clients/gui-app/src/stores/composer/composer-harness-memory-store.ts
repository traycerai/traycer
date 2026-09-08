import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { GuiHarnessId } from "@traycer/protocol/host";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { cappedByUpdatedAt } from "@/lib/bounded-record";
import { basePersistOptions, composerHarnessMemoryKey } from "@/lib/persist";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";

// LRU cap on the per-(harness, model) effort/tier map. Matches the epic cap in
// `composer-run-settings-store`; an evicted record falls back to the model's
// own default effort/tier on the next visit.
export const COMPOSER_HARNESS_MEMORY_CAP = 200;

// Effort + service tier as stored on `ChatRunSettings` (both nullable). Every
// memory shape below carries this pair, so it is their single shared base.
export interface EffortTier {
  readonly reasoningEffort: string | null; // ChatRunSettings.reasoningEffort shape
  readonly serviceTier: string | null; // ChatRunSettings.serviceTier shape
}

export interface HarnessModelEffortRecord extends EffortTier {
  readonly updatedAt: number;
}

export interface ResolvedHarnessSwitch extends EffortTier {
  readonly modelSlug: string;
}

export type ResolvedModelSelection = EffortTier;

/**
 * One host's harness memory. Hosts have different harness/model/profile
 * catalogs, so every map is bucketed by the host the selection was committed
 * on - a cross-host read would restore state the reading host may not serve.
 */
export interface ComposerHarnessMemoryHostBucket {
  // harnessId -> last explicitly selected profile. `null` is the ambient
  // Terminal profile and is stored deliberately (rather than represented by
  // a missing key) so it can replace an earlier managed-profile selection.
  readonly lastProfileByHarness: Partial<Record<GuiHarnessId, string | null>>;
  // (harnessId, profileId) -> last committed model slug, keyed by the same
  // JSON tuple spelling `parseLegacyHarnessProfileKey` parses (D09 reverses
  // the prior "profile memory is separate" split, reused below as
  // `harnessProfileKey`). An API-key profile can point at a different
  // endpoint with an entirely different model catalog, so a profile is no
  // longer "the same models under different credentials" - one remembered
  // model per harness is wrong for exactly the rows this refactor adds.
  readonly lastModelByHarness: Record<string, string>;
  // (harnessId, modelSlug) -> effort/tier, LRU-capped by updatedAt. Like the
  // last model, these settings belong to the provider/model, not a profile.
  readonly effortByHarnessModel: Record<string, HarnessModelEffortRecord>;
}

const EMPTY_HOST_BUCKET: ComposerHarnessMemoryHostBucket = {
  lastProfileByHarness: {},
  lastModelByHarness: {},
  effortByHarnessModel: {},
};

interface ComposerHarnessMemoryStore {
  // hostId -> that host's memory. Writes ALWAYS land here (never in
  // `legacy`), keyed by the composer's target host.
  byHost: Record<string, ComposerHarnessMemoryHostBucket>;
  // Frozen pre-host-scoping data (v2 and earlier), kept as a read-only
  // per-key fallback so the common single-host install keeps its remembered
  // selections across the migration. A migration cannot know which host the
  // flat data belonged to; catalog-availability rerouting in the toolbar
  // store remains the safety net when the fallback names a harness/model the
  // reading host does not serve.
  legacy: ComposerHarnessMemoryHostBucket;

  // WRITE — settings.model is always resolved (onSettingsChange guarantees
  // it). `hostId === null` (no resolved target host) drops the write.
  record: (hostId: string | null, settings: ChatRunSettings) => void;
  // WRITE — selection commits call this immediately, before model resolution.
  recordProfileSelection: (
    hostId: string | null,
    harnessId: GuiHarnessId,
    profileId: string | null,
  ) => void;
  // READ — missing memory falls back to the ambient Terminal profile.
  resolveLastProfile: (
    hostId: string | null,
    harnessId: GuiHarnessId,
  ) => string | null;
  // READ — harness switch: last model + its record (or "" / null defaults).
  // `profileId` selects which (harness, profile) pair's remembered model to
  // read (D09) - required so a profile switch can never restore another
  // profile's last model. The "" result carries no defaultModel fallback:
  // that seeding lives in the reader the toolbar calls, never here, because
  // the store must stay a pure persisted map with no knowledge of the wire.
  resolveHarnessSwitch: (
    hostId: string | null,
    harnessId: string,
    profileId: string | null,
  ) => ResolvedHarnessSwitch;
  // READ — explicit model pick: that pair's effort/tier record (or null
  // defaults). No `profileId` parameter - `effortByHarnessModel` stays keyed
  // by (harnessId, modelSlug) only (D09 scopes just the model memory), so a
  // profile has no branch here to select.
  resolveModelSelection: (
    hostId: string | null,
    harnessId: string,
    modelSlug: string,
  ) => ResolvedModelSelection;
  resetForTests: () => void;
}

function hostBucket(
  state: Pick<ComposerHarnessMemoryStore, "byHost">,
  hostId: string | null,
): ComposerHarnessMemoryHostBucket {
  if (hostId === null || !Object.hasOwn(state.byHost, hostId)) {
    return EMPTY_HOST_BUCKET;
  }
  return state.byHost[hostId];
}

/**
 * The per-host `lastProfileByHarness` view the header rate-limit surfaces
 * read: the host bucket overlaid on the legacy fallback, so a harness the
 * host has no record for yet still resolves its pre-migration profile.
 * Returns a fresh object - subscribe through `useShallow`.
 */
export function selectLastProfileByHarness(
  state: Pick<ComposerHarnessMemoryStore, "byHost" | "legacy">,
  hostId: string | null,
): Partial<Record<GuiHarnessId, string | null>> {
  return {
    ...state.legacy.lastProfileByHarness,
    ...hostBucket(state, hostId).lastProfileByHarness,
  };
}

// Keeps the pre-profile persisted key byte-identical, so v1 ambient records
// migrate without rewriting their provider/model identity.
function harnessModelKey(harnessId: string, modelSlug: string): string {
  return `${harnessId} ${modelSlug}`;
}

// (harnessId, profileId) -> `lastModelByHarness` key (D09). Same JSON tuple
// spelling `parseLegacyHarnessProfileKey` already parses - that was the v1
// per-profile shape the v1->v2 collapse flattened away - so V4-migrated and
// freshly written records share one key format with no fresh migration.
function harnessProfileKey(
  harnessId: string,
  profileId: string | null,
): string {
  return JSON.stringify([harnessId, profileId]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is ReadonlyArray<unknown> {
  return Array.isArray(value);
}

function ownRecordValue<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

interface LegacyHarnessProfileKey {
  readonly harnessId: string;
  readonly profileId: string | null;
}

interface LegacyHarnessModelKey extends LegacyHarnessProfileKey {
  readonly modelSlug: string;
}

interface LegacyEffortCandidate {
  readonly profileId: string | null;
  readonly record: HarnessModelEffortRecord;
}

function parseJsonTuple(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    return null;
  }
}

function parseLegacyHarnessProfileKey(
  key: string,
): LegacyHarnessProfileKey | null {
  if (!key.startsWith("[")) return { harnessId: key, profileId: null };
  const tuple = parseJsonTuple(key);
  if (
    !isUnknownArray(tuple) ||
    tuple.length !== 2 ||
    typeof tuple[0] !== "string" ||
    (typeof tuple[1] !== "string" && tuple[1] !== null)
  ) {
    return null;
  }
  return { harnessId: tuple[0], profileId: tuple[1] };
}

function parseLegacyHarnessModelKey(key: string): LegacyHarnessModelKey | null {
  if (key.startsWith("[")) {
    const tuple = parseJsonTuple(key);
    if (
      !isUnknownArray(tuple) ||
      tuple.length !== 3 ||
      typeof tuple[0] !== "string" ||
      (typeof tuple[1] !== "string" && tuple[1] !== null) ||
      typeof tuple[2] !== "string"
    ) {
      return null;
    }
    return {
      harnessId: tuple[0],
      profileId: tuple[1],
      modelSlug: tuple[2],
    };
  }
  const separatorIndex = key.indexOf(" ");
  if (separatorIndex <= 0 || separatorIndex === key.length - 1) return null;
  return {
    harnessId: key.slice(0, separatorIndex),
    profileId: null,
    modelSlug: key.slice(separatorIndex + 1),
  };
}

function parseEffortRecord(value: unknown): HarnessModelEffortRecord | null {
  if (!isRecord(value)) return null;
  const { reasoningEffort, serviceTier, updatedAt } = value;
  if (
    (typeof reasoningEffort !== "string" && reasoningEffort !== null) ||
    (typeof serviceTier !== "string" && serviceTier !== null) ||
    typeof updatedAt !== "number" ||
    !Number.isFinite(updatedAt)
  ) {
    return null;
  }
  return { reasoningEffort, serviceTier, updatedAt };
}

function legacySelectionKey(input: LegacyHarnessModelKey): string {
  return JSON.stringify([input.harnessId, input.profileId, input.modelSlug]);
}

interface ComposerHarnessMemoryPersistedState {
  readonly lastProfileByHarness: Record<string, string | null>;
  readonly lastModelByHarness: Record<string, string>;
  readonly effortByHarnessModel: Record<string, HarnessModelEffortRecord>;
}

interface ComposerHarnessMemoryPersistedStateV3 {
  readonly byHost: Record<string, ComposerHarnessMemoryHostBucket>;
  readonly legacy: ComposerHarnessMemoryHostBucket;
}

/**
 * v1/v2 -> flat-map normalization, reused by the v3 migration as the `legacy`
 * bucket. v1 scoped model and effort memory to a provider profile, so
 * changing credentials could restore a different model/reasoning tuple; v2
 * keeps profile memory independent and collapses profile-scoped records to
 * the most recently updated provider/model records. Running it on v2 data is
 * a no-op normalization (plain keys parse as themselves), so one tolerant
 * pass covers both stored versions.
 */
export function migrateComposerHarnessMemoryPersistedState(
  persisted: unknown,
): ComposerHarnessMemoryPersistedState {
  if (!isRecord(persisted)) {
    return {
      lastProfileByHarness: {},
      lastModelByHarness: {},
      effortByHarnessModel: {},
    };
  }
  const lastProfileByHarness = isRecord(persisted.lastProfileByHarness)
    ? Object.entries(persisted.lastProfileByHarness).reduce<
        Record<string, string | null>
      >((profiles, [harnessId, profileId]) => {
        if (typeof profileId === "string" || profileId === null) {
          profiles[harnessId] = profileId;
        }
        return profiles;
      }, {})
    : {};
  const legacyEffortEntries = isRecord(persisted.effortByHarnessModel)
    ? Object.entries(persisted.effortByHarnessModel).flatMap(([key, value]) => {
        const parsedKey = parseLegacyHarnessModelKey(key);
        const record = parseEffortRecord(value);
        return parsedKey === null || record === null
          ? []
          : [{ ...parsedKey, record }];
      })
    : [];
  const updatedAtByLegacySelection = new Map(
    legacyEffortEntries.map((entry) => [
      legacySelectionKey(entry),
      entry.record.updatedAt,
    ]),
  );
  const effortCandidates = legacyEffortEntries.reduce<
    Record<string, LegacyEffortCandidate>
  >((records, entry) => {
    const key = harnessModelKey(entry.harnessId, entry.modelSlug);
    const existing = ownRecordValue(records, key);
    const rememberedProfile = lastProfileByHarness[entry.harnessId];
    const candidateBreaksTie =
      existing !== undefined &&
      entry.record.updatedAt === existing.record.updatedAt &&
      entry.profileId === rememberedProfile &&
      existing.profileId !== rememberedProfile;
    if (
      existing === undefined ||
      entry.record.updatedAt > existing.record.updatedAt ||
      candidateBreaksTie
    ) {
      records[key] = {
        profileId: entry.profileId,
        record: entry.record,
      };
    }
    return records;
  }, {});
  const effortByHarnessModel = Object.fromEntries(
    Object.entries(effortCandidates).map(([key, candidate]) => [
      key,
      candidate.record,
    ]),
  );
  const lastModelCandidates = isRecord(persisted.lastModelByHarness)
    ? Object.entries(persisted.lastModelByHarness).flatMap(
        ([key, modelSlug]) => {
          const parsedKey = parseLegacyHarnessProfileKey(key);
          if (parsedKey === null || typeof modelSlug !== "string") return [];
          return [
            {
              ...parsedKey,
              modelSlug,
              updatedAt:
                updatedAtByLegacySelection.get(
                  legacySelectionKey({ ...parsedKey, modelSlug }),
                ) ?? -1,
            },
          ];
        },
      )
    : [];
  const lastModelByHarness = lastModelCandidates.reduce<
    Record<string, LegacyHarnessModelKey & { readonly updatedAt: number }>
  >((candidates, candidate) => {
    const existing = ownRecordValue(candidates, candidate.harnessId);
    const rememberedProfile = lastProfileByHarness[candidate.harnessId];
    const candidateBreaksTie =
      existing !== undefined &&
      candidate.updatedAt === existing.updatedAt &&
      candidate.profileId === rememberedProfile;
    if (
      existing === undefined ||
      candidate.updatedAt > existing.updatedAt ||
      candidateBreaksTie
    ) {
      candidates[candidate.harnessId] = candidate;
    }
    return candidates;
  }, {});
  return {
    lastProfileByHarness,
    lastModelByHarness: Object.fromEntries(
      Object.entries(lastModelByHarness).map(([harnessId, candidate]) => [
        harnessId,
        candidate.modelSlug,
      ]),
    ),
    effortByHarnessModel,
  };
}

/**
 * v3 migration: every earlier version's flat maps become the read-only
 * `legacy` fallback; per-host buckets start empty and fill as each host is
 * actually used. A migration cannot know which host the flat data belonged
 * to, so it is deliberately NOT assigned to any host bucket.
 */
export function migrateComposerHarnessMemoryPersistedStateV3(
  persisted: unknown,
): ComposerHarnessMemoryPersistedStateV3 {
  return {
    byHost: {},
    legacy: migrateComposerHarnessMemoryPersistedState(persisted),
  };
}

function parseLastProfileByHarnessField(
  value: unknown,
): Record<string, string | null> {
  if (!isRecord(value)) return {};
  return Object.entries(value).reduce<Record<string, string | null>>(
    (profiles, [harnessId, profileId]) => {
      if (typeof profileId === "string" || profileId === null) {
        profiles[harnessId] = profileId;
      }
      return profiles;
    },
    {},
  );
}

function parseFlatStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.entries(value).reduce<Record<string, string>>(
    (candidates, [key, candidate]) => {
      if (typeof candidate === "string") candidates[key] = candidate;
      return candidates;
    },
    {},
  );
}

function parseEffortByHarnessModelField(
  value: unknown,
): Record<string, HarnessModelEffortRecord> {
  if (!isRecord(value)) return {};
  return Object.entries(value).reduce<Record<string, HarnessModelEffortRecord>>(
    (records, [key, candidate]) => {
      const record = parseEffortRecord(candidate);
      if (record !== null) records[key] = record;
      return records;
    },
    {},
  );
}

// Parses one host bucket (or the `legacy` bucket) from a V3-shaped persisted
// blob defensively, field by field - the same tolerance level the v1/v2
// collapse above applies, so one malformed field degrades to empty rather
// than throwing or discarding the bucket's other fields (rule 10: fail
// closed on the corrupt piece, not on everything reachable from it).
function parseHostBucket(value: unknown): ComposerHarnessMemoryHostBucket {
  if (!isRecord(value)) return EMPTY_HOST_BUCKET;
  return {
    lastProfileByHarness: parseLastProfileByHarnessField(
      value.lastProfileByHarness,
    ),
    lastModelByHarness: parseFlatStringRecord(value.lastModelByHarness),
    effortByHarnessModel: parseEffortByHarnessModelField(
      value.effortByHarnessModel,
    ),
  };
}

/**
 * Re-keys one host bucket's `lastModelByHarness` from flat `harnessId` to the
 * `(harnessId, profileId)` tuple (D09), attributing each remembered model to
 * THAT SAME bucket's `lastProfileByHarness[harnessId]` - the same association
 * the V1->V2 collapse used above, and the only honest attribution a migration
 * can make: the flat map never recorded which profile a model belonged to.
 */
function rekeyHostBucketModelMemory(
  bucket: ComposerHarnessMemoryHostBucket,
): ComposerHarnessMemoryHostBucket {
  // `Object.entries` always returns plain-string keys regardless of the
  // source's key union, so this side-steps indexing `lastProfileByHarness`
  // (keyed by `GuiHarnessId`) with the plain `string` harnessId that
  // `lastModelByHarness`'s own keys carry.
  const profileByHarnessId = new Map(
    Object.entries(bucket.lastProfileByHarness),
  );
  return {
    ...bucket,
    lastModelByHarness: Object.fromEntries(
      Object.entries(bucket.lastModelByHarness).map(
        ([harnessId, modelSlug]) => [
          harnessProfileKey(
            harnessId,
            profileByHarnessId.get(harnessId) ?? null,
          ),
          modelSlug,
        ],
      ),
    ),
  };
}

/**
 * v4 migration (D09): every V3 host bucket's `lastModelByHarness` is re-keyed
 * from bare `harnessId` to the `(harnessId, profileId)` tuple via
 * {@link rekeyHostBucketModelMemory}. Input predating v3 host-scoping (no
 * `byHost` field) is first collapsed the same way v3 did - its `byHost`
 * starts empty, so there is nothing to re-key. The `legacy` tier is left
 * exactly as v3 produced it: it predates per-host `lastProfileByHarness`
 * entirely, so there is no attribution to re-key it with (D09's own
 * `resolveHarnessSwitch` keeps reading it flat, by harnessId).
 */
export function migrateComposerHarnessMemoryPersistedStateV4(
  persisted: unknown,
): ComposerHarnessMemoryPersistedStateV3 {
  const v3: ComposerHarnessMemoryPersistedStateV3 =
    isRecord(persisted) && isRecord(persisted.byHost)
      ? {
          byHost: Object.fromEntries(
            Object.entries(persisted.byHost).map(([hostId, bucket]) => [
              hostId,
              parseHostBucket(bucket),
            ]),
          ),
          legacy: parseHostBucket(persisted.legacy),
        }
      : migrateComposerHarnessMemoryPersistedStateV3(persisted);
  return {
    byHost: Object.fromEntries(
      Object.entries(v3.byHost).map(([hostId, bucket]) => [
        hostId,
        rekeyHostBucketModelMemory(bucket),
      ]),
    ),
    legacy: v3.legacy,
  };
}

export const useComposerHarnessMemoryStore =
  create<ComposerHarnessMemoryStore>()(
    persist(
      (set, get) => ({
        byHost: {},
        legacy: EMPTY_HOST_BUCKET,
        record: (hostId, settings) => {
          if (hostId === null) return;
          // The settings callback is also a valid profile-selection signal
          // (permission/reasoning edits can be the first committed edit on a
          // seeded composer), so keep profile memory in the same funnel as the
          // model/effort memory. `commitSelection` records earlier as well so a
          // profile switch is remembered even while its model catalog loads.
          const profileId = settings.profileId ?? null;
          get().recordProfileSelection(hostId, settings.harnessId, profileId);
          // Mirror the sibling run-settings store: an unresolved model is not a
          // real selection. Writing an empty model would make
          // `resolveHarnessSwitch` treat it as a record and suppress the lazy
          // `globalLastRunSettings` fallback.
          if (settings.model.length === 0) return;
          const modelKey = harnessModelKey(settings.harnessId, settings.model);
          const profileModelKey = harnessProfileKey(
            settings.harnessId,
            profileId,
          );
          set((state) => {
            const bucket = hostBucket(state, hostId);
            return {
              byHost: {
                ...state.byHost,
                [hostId]: {
                  ...bucket,
                  lastModelByHarness: {
                    ...bucket.lastModelByHarness,
                    [profileModelKey]: settings.model,
                  },
                  // Always write - no value dedup. `updatedAt` is the recency
                  // key the cap sorts on, so even re-selecting the same pair
                  // must refresh it; a just-touched record must not be evicted
                  // as "least recently used".
                  effortByHarnessModel: cappedByUpdatedAt(
                    {
                      ...bucket.effortByHarnessModel,
                      [modelKey]: {
                        reasoningEffort: settings.reasoningEffort,
                        serviceTier: settings.serviceTier,
                        updatedAt: Date.now(),
                      },
                    },
                    COMPOSER_HARNESS_MEMORY_CAP,
                  ),
                },
              },
            };
          });
        },
        recordProfileSelection: (hostId, harnessId, profileId) => {
          if (hostId === null) return;
          const state = get();
          const bucket = hostBucket(state, hostId);
          // Return before `set`, not from inside its updater: the persist
          // middleware serializes after every `set` call even when Zustand
          // preserves state identity, so this guard also avoids a redundant
          // localStorage write on the settings emit that follows a commit.
          if (
            Object.hasOwn(bucket.lastProfileByHarness, harnessId) &&
            bucket.lastProfileByHarness[harnessId] === profileId
          ) {
            return;
          }
          set({
            byHost: {
              ...state.byHost,
              [hostId]: {
                ...bucket,
                lastProfileByHarness: {
                  ...bucket.lastProfileByHarness,
                  [harnessId]: profileId,
                },
              },
            },
          });
        },
        resolveLastProfile: (hostId, harnessId) => {
          const state = get();
          const bucket = hostBucket(state, hostId);
          // `hasOwn`, not `??` on the value: a stored `null` IS the remembered
          // ambient choice and must not fall through to the legacy fallback.
          if (Object.hasOwn(bucket.lastProfileByHarness, harnessId)) {
            return bucket.lastProfileByHarness[harnessId] ?? null;
          }
          return state.legacy.lastProfileByHarness[harnessId] ?? null;
        },
        resolveHarnessSwitch: (hostId, harnessId, profileId) => {
          const state = get();
          // Per-host memory first at BOTH tiers (a record on this host is
          // always fresher than the frozen legacy fallback), then the same
          // two tiers of the pre-host-scoping legacy data. Within each tier
          // the stored per-harness model wins over the lazy last-run backfill
          // (read-time `getState()` only, no eager hydration-time write),
          // which applies iff the last-run tuple belongs to the same harness.
          const hostModel = ownRecordValue(
            hostBucket(state, hostId).lastModelByHarness,
            harnessProfileKey(harnessId, profileId),
          );
          if (hostModel !== undefined) {
            // Reuse the model-pick resolver for the exact same (harness,
            // model) record lookup - `{ null, null }` when absent.
            return {
              modelSlug: hostModel,
              ...state.resolveModelSelection(hostId, harnessId, hostModel),
            };
          }
          const runSettings = useComposerRunSettingsStore.getState();
          const hostGlobal =
            hostId !== null &&
            Object.hasOwn(runSettings.globalLastRunSettingsByHostId, hostId)
              ? runSettings.globalLastRunSettingsByHostId[hostId]
              : null;
          if (hostGlobal !== null && hostGlobal.harnessId === harnessId) {
            return {
              modelSlug: hostGlobal.model,
              reasoningEffort: hostGlobal.reasoningEffort,
              serviceTier: hostGlobal.serviceTier,
            };
          }
          // The legacy tier predates host scoping AND profile scoping - it is
          // never re-keyed by the V4 migration (there is no per-host
          // `lastProfileByHarness` to attribute it to) - so it stays a flat
          // per-harness lookup, same as before D09.
          const legacyModel = ownRecordValue(
            state.legacy.lastModelByHarness,
            harnessId,
          );
          if (legacyModel !== undefined) {
            return {
              modelSlug: legacyModel,
              ...state.resolveModelSelection(hostId, harnessId, legacyModel),
            };
          }
          const legacyGlobal = runSettings.legacyGlobalLastRunSettings;
          if (legacyGlobal !== null && legacyGlobal.harnessId === harnessId) {
            return {
              modelSlug: legacyGlobal.model,
              reasoningEffort: legacyGlobal.reasoningEffort,
              serviceTier: legacyGlobal.serviceTier,
            };
          }
          return { modelSlug: "", reasoningEffort: null, serviceTier: null };
        },
        resolveModelSelection: (hostId, harnessId, modelSlug) => {
          const state = get();
          const key = harnessModelKey(harnessId, modelSlug);
          const record =
            ownRecordValue(
              hostBucket(state, hostId).effortByHarnessModel,
              key,
            ) ?? ownRecordValue(state.legacy.effortByHarnessModel, key);
          if (record === undefined) {
            return { reasoningEffort: null, serviceTier: null };
          }
          return {
            reasoningEffort: record.reasoningEffort,
            serviceTier: record.serviceTier,
          };
        },
        resetForTests: () => {
          set({
            byHost: {},
            legacy: EMPTY_HOST_BUCKET,
          });
        },
      }),
      {
        ...basePersistOptions(composerHarnessMemoryKey(null)),
        version: 4,
        storage: createJSONStorage(() => window.localStorage),
        partialize: (state) => ({
          byHost: state.byHost,
          legacy: state.legacy,
        }),
        migrate: (persisted) =>
          migrateComposerHarnessMemoryPersistedStateV4(persisted),
      },
    ),
  );
