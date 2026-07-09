import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
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
  // (harnessId, profileId) -> last committed model slug, keyed via
  // `harnessProfileKey` below (bounded by harness x profile count).
  lastModelByHarness: Record<string, string>;
  // (harnessId, profileId, modelSlug) -> effort/tier, keyed via
  // `harnessModelKey` below, LRU-capped by updatedAt.
  effortByHarnessModel: Record<string, HarnessModelEffortRecord>;

  // WRITE — settings.model is always resolved (onSettingsChange guarantees it).
  record: (settings: ChatRunSettings) => void;
  // READ — harness switch: last model + its record (or "" / null defaults).
  resolveHarnessSwitch: (
    harnessId: string,
    profileId: string | null,
  ) => ResolvedHarnessSwitch;
  // READ — explicit model pick: that pair's record (or null defaults).
  resolveModelSelection: (
    harnessId: string,
    profileId: string | null,
    modelSlug: string,
  ) => ResolvedModelSelection;
  resetForTests: () => void;
}

// Ambient (`profileId === null`) keeps today's exact bare-`harnessId` key -
// byte-identical for single/no-profile providers, and every entry written
// before profiles existed transparently becomes that harness's ambient record
// with no migration step: there is nothing to migrate FROM, since the old key
// already IS the new ambient key (see memory `persisted-store-shape-drift`).
// A managed profile is keyed by the JSON-encoded tuple instead of a
// separator-joined string: a plain separator risks ambiguity if an
// id/slug happens to contain it (e.g. a literal space), while
// `JSON.stringify` of an array always starts with the `[` character - which a
// bare harnessId (a short lowercase enum) or a space-joined ambient key can
// never start with - so the two formats can never collide.
function harnessProfileKey(
  harnessId: string,
  profileId: string | null,
): string {
  return profileId === null
    ? harnessId
    : JSON.stringify([harnessId, profileId]);
}

// Ambient keeps today's exact `"${harnessId} ${modelSlug}"` (space-joined) key
// for the same reason as `harnessProfileKey` above; a managed profile uses the
// same JSON-tuple encoding, so it can never collide with the space-joined
// ambient format.
function harnessModelKey(
  harnessId: string,
  profileId: string | null,
  modelSlug: string,
): string {
  return profileId === null
    ? `${harnessId} ${modelSlug}`
    : JSON.stringify([harnessId, profileId, modelSlug]);
}

export const useComposerHarnessMemoryStore =
  create<ComposerHarnessMemoryStore>()(
    persist(
      (set, get) => ({
        lastModelByHarness: {},
        effortByHarnessModel: {},
        record: (settings) => {
          // Mirror the sibling run-settings store: an unresolved model is not a
          // real selection. Writing an empty model would make
          // `resolveHarnessSwitch` treat it as a record and suppress the lazy
          // `globalLastRunSettings` fallback.
          if (settings.model.length === 0) return;
          // `??` guards a pre-profile persisted `ChatRunSettings` blob (the
          // field is missing, not `null`, on an old serialized object).
          const profileId = settings.profileId ?? null;
          const profileKey = harnessProfileKey(settings.harnessId, profileId);
          const modelKey = harnessModelKey(
            settings.harnessId,
            profileId,
            settings.model,
          );
          set((state) => ({
            lastModelByHarness: {
              ...state.lastModelByHarness,
              [profileKey]: settings.model,
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
        resolveHarnessSwitch: (harnessId, profileId) => {
          const state = get();
          const profileKey = harnessProfileKey(harnessId, profileId);
          if (Object.hasOwn(state.lastModelByHarness, profileKey)) {
            const modelSlug = state.lastModelByHarness[profileKey];
            // Reuse the model-pick resolver for the exact same (harness,
            // profile, model) record lookup - `{ null, null }` when absent.
            return {
              modelSlug,
              ...state.resolveModelSelection(harnessId, profileId, modelSlug),
            };
          }
          // A managed profile with no record of its own inherits the SAME
          // harness's ambient record first - "ambient is the implicit
          // fallback" per the multi-profile decision log - before falling
          // further back to the cross-harness `globalLastRunSettings` sticky
          // below. The ambient profile itself already hit the check above, so
          // this only ever runs for a managed profileId.
          if (profileId !== null) {
            const ambientKey = harnessProfileKey(harnessId, null);
            if (Object.hasOwn(state.lastModelByHarness, ambientKey)) {
              const modelSlug = state.lastModelByHarness[ambientKey];
              return {
                modelSlug,
                ...state.resolveModelSelection(harnessId, null, modelSlug),
              };
            }
          }
          // Lazy backfill (read-time `getState()` only, no eager hydration-time
          // write): when this (harness, profile) has no record, fall back to
          // the last-run tuple iff it belongs to the same harness. A real
          // record always wins over this fallback because of the
          // `Object.hasOwn` checks above.
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
        resolveModelSelection: (harnessId, profileId, modelSlug) => {
          const state = get();
          const key = harnessModelKey(harnessId, profileId, modelSlug);
          if (!Object.hasOwn(state.effortByHarnessModel, key)) {
            return { reasoningEffort: null, serviceTier: null };
          }
          const record = state.effortByHarnessModel[key];
          return {
            reasoningEffort: record.reasoningEffort,
            serviceTier: record.serviceTier,
          };
        },
        resetForTests: () => {
          set({
            lastModelByHarness: {},
            effortByHarnessModel: {},
          });
        },
      }),
      {
        ...basePersistOptions(composerHarnessMemoryKey(null)),
        storage: createJSONStorage(() => window.localStorage),
        partialize: (state) => ({
          lastModelByHarness: state.lastModelByHarness,
          effortByHarnessModel: state.effortByHarnessModel,
        }),
      },
    ),
  );
