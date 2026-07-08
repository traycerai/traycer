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
  // harnessId → last committed model slug (small, bounded by harness count).
  lastModelByHarness: Record<string, string>;
  // `${harnessId} ${modelSlug}` → effort/tier, LRU-capped by updatedAt.
  effortByHarnessModel: Record<string, HarnessModelEffortRecord>;

  // WRITE — settings.model is always resolved (onSettingsChange guarantees it).
  record: (settings: ChatRunSettings) => void;
  // READ — harness switch: last model + its record (or "" / null defaults).
  resolveHarnessSwitch: (harnessId: string) => ResolvedHarnessSwitch;
  // READ — explicit model pick: that pair's record (or null defaults).
  resolveModelSelection: (
    harnessId: string,
    modelSlug: string,
  ) => ResolvedModelSelection;
  resetForTests: () => void;
}

function harnessModelKey(harnessId: string, modelSlug: string): string {
  return `${harnessId} ${modelSlug}`;
}

export const useComposerHarnessMemoryStore =
  create<ComposerHarnessMemoryStore>()(
    persist(
      (set, get) => ({
        lastModelByHarness: {},
        effortByHarnessModel: {},
        record: (settings) => {
          // Mirror the sibling run-settings store: an unresolved model is not a
          // real selection. Writing `lastModelByHarness[harnessId] = ""` would
          // make `resolveHarnessSwitch` treat the empty string as a record and
          // suppress the lazy `globalLastRunSettings` fallback.
          if (settings.model.length === 0) return;
          const key = harnessModelKey(settings.harnessId, settings.model);
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
                [key]: {
                  reasoningEffort: settings.reasoningEffort,
                  serviceTier: settings.serviceTier,
                  updatedAt: Date.now(),
                },
              },
              COMPOSER_HARNESS_MEMORY_CAP,
            ),
          }));
        },
        resolveHarnessSwitch: (harnessId) => {
          const state = get();
          if (Object.hasOwn(state.lastModelByHarness, harnessId)) {
            const modelSlug = state.lastModelByHarness[harnessId];
            // Reuse the model-pick resolver for the exact same (harness, model)
            // record lookup - `{ null, null }` when the pair has no record.
            return {
              modelSlug,
              ...state.resolveModelSelection(harnessId, modelSlug),
            };
          }
          // Lazy backfill (read-time `getState()` only, no eager hydration-time
          // write): when this harness has no record, fall back to the last-run
          // tuple iff it belongs to the same harness. A real record always wins
          // over this fallback because of the `Object.hasOwn` check above.
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
