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

interface ComposerHarnessMemoryStore {
  // harnessId -> last explicitly selected profile. `null` is the ambient
  // Terminal profile and is stored deliberately (rather than represented by
  // a missing key) so it can replace an earlier managed-profile selection.
  lastProfileByHarness: Partial<Record<GuiHarnessId, string | null>>;
  // harnessId -> last committed model slug. Profile memory is deliberately
  // separate so changing credentials cannot change the remembered model.
  lastModelByHarness: Record<string, string>;
  // (harnessId, modelSlug) -> effort/tier, LRU-capped by updatedAt. Like the
  // last model, these settings belong to the provider/model, not a profile.
  effortByHarnessModel: Record<string, HarnessModelEffortRecord>;

  // WRITE — settings.model is always resolved (onSettingsChange guarantees it).
  record: (settings: ChatRunSettings) => void;
  // WRITE — selection commits call this immediately, before model resolution.
  recordProfileSelection: (
    harnessId: GuiHarnessId,
    profileId: string | null,
  ) => void;
  // READ — missing memory falls back to the ambient Terminal profile.
  resolveLastProfile: (harnessId: GuiHarnessId) => string | null;
  // READ — harness switch: last model + its record (or "" / null defaults).
  resolveHarnessSwitch: (harnessId: string) => ResolvedHarnessSwitch;
  // READ — explicit model pick: that pair's record (or null defaults).
  resolveModelSelection: (
    harnessId: string,
    modelSlug: string,
  ) => ResolvedModelSelection;
  resetForTests: () => void;
}

// Keeps the pre-profile persisted key byte-identical, so v1 ambient records
// migrate without rewriting their provider/model identity.
function harnessModelKey(harnessId: string, modelSlug: string): string {
  return `${harnessId} ${modelSlug}`;
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

/**
 * v1 -> v2 migration. v1 scoped model and effort memory to a provider profile,
 * so changing credentials could restore a different model/reasoning tuple.
 * v2 keeps profile memory independent and collapses profile-scoped records to
 * the most recently updated provider/model records.
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

export const useComposerHarnessMemoryStore =
  create<ComposerHarnessMemoryStore>()(
    persist(
      (set, get) => ({
        lastProfileByHarness: {},
        lastModelByHarness: {},
        effortByHarnessModel: {},
        record: (settings) => {
          // The settings callback is also a valid profile-selection signal
          // (permission/reasoning edits can be the first committed edit on a
          // seeded composer), so keep profile memory in the same funnel as the
          // model/effort memory. `commitSelection` records earlier as well so a
          // profile switch is remembered even while its model catalog loads.
          const profileId = settings.profileId ?? null;
          get().recordProfileSelection(settings.harnessId, profileId);
          // Mirror the sibling run-settings store: an unresolved model is not a
          // real selection. Writing an empty model would make
          // `resolveHarnessSwitch` treat it as a record and suppress the lazy
          // `globalLastRunSettings` fallback.
          if (settings.model.length === 0) return;
          const modelKey = harnessModelKey(settings.harnessId, settings.model);
          set((state) => ({
            lastModelByHarness: {
              ...state.lastModelByHarness,
              [settings.harnessId]: settings.model,
            },
            // Always write - no value dedup. `updatedAt` is the recency key the
            // cap sorts on, so even re-selecting the same pair must refresh it;
            // a just-touched record must not be evicted as "least recently
            // used".
            effortByHarnessModel: cappedByUpdatedAt(
              {
                ...state.effortByHarnessModel,
                [modelKey]: {
                  reasoningEffort: settings.reasoningEffort,
                  serviceTier: settings.serviceTier,
                  updatedAt: Date.now(),
                },
              },
              COMPOSER_HARNESS_MEMORY_CAP,
            ),
          }));
        },
        recordProfileSelection: (harnessId, profileId) => {
          const state = get();
          // Return before `set`, not from inside its updater: the persist
          // middleware serializes after every `set` call even when Zustand
          // preserves state identity, so this guard also avoids a redundant
          // localStorage write on the settings emit that follows a commit.
          if (
            Object.hasOwn(state.lastProfileByHarness, harnessId) &&
            state.lastProfileByHarness[harnessId] === profileId
          ) {
            return;
          }
          set({
            lastProfileByHarness: {
              ...state.lastProfileByHarness,
              [harnessId]: profileId,
            },
          });
        },
        resolveLastProfile: (harnessId) => {
          return get().lastProfileByHarness[harnessId] ?? null;
        },
        resolveHarnessSwitch: (harnessId) => {
          const state = get();
          const modelSlug = ownRecordValue(state.lastModelByHarness, harnessId);
          if (modelSlug !== undefined) {
            // Reuse the model-pick resolver for the exact same (harness,
            // model) record lookup - `{ null, null }` when absent.
            return {
              modelSlug,
              ...state.resolveModelSelection(harnessId, modelSlug),
            };
          }
          // Lazy backfill (read-time `getState()` only, no eager hydration-time
          // write): when this harness has no record, fall back to the last-run
          // tuple iff it belongs to the same harness. A real
          // record always wins over this fallback because of the stored-model
          // check above.
          const global =
            useComposerRunSettingsStore.getState().globalLastRunSettings;
          if (global !== null && global.harnessId === harnessId) {
            return {
              modelSlug: global.model,
              reasoningEffort: global.reasoningEffort,
              serviceTier: global.serviceTier,
            };
          }
          return { modelSlug: "", reasoningEffort: null, serviceTier: null };
        },
        resolveModelSelection: (harnessId, modelSlug) => {
          const state = get();
          const key = harnessModelKey(harnessId, modelSlug);
          const record = ownRecordValue(state.effortByHarnessModel, key);
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
            lastProfileByHarness: {},
            lastModelByHarness: {},
            effortByHarnessModel: {},
          });
        },
      }),
      {
        ...basePersistOptions(composerHarnessMemoryKey(null)),
        version: 2,
        storage: createJSONStorage(() => window.localStorage),
        partialize: (state) => ({
          lastProfileByHarness: state.lastProfileByHarness,
          lastModelByHarness: state.lastModelByHarness,
          effortByHarnessModel: state.effortByHarnessModel,
        }),
        migrate: (persisted) =>
          migrateComposerHarnessMemoryPersistedState(persisted),
      },
    ),
  );
