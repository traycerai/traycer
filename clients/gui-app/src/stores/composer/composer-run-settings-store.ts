import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { cappedByUpdatedAt } from "@/lib/bounded-record";
import { basePersistOptions, composerRunSettingsKey } from "@/lib/persist";

export const COMPOSER_RUN_SETTINGS_EPIC_CAP = 200;

export interface ComposerRunSettingsEntry {
  readonly settings: ChatRunSettings;
  readonly updatedAt: number;
}

interface ComposerRunSettingsStore {
  globalLastRunSettings: ChatRunSettings | null;
  epicRunSettingsByEpicId: Record<string, ComposerRunSettingsEntry>;
  setGlobalRunSettings: (settings: ChatRunSettings, updatedAt: number) => void;
  setEpicRunSettings: (
    epicId: string,
    settings: ChatRunSettings,
    updatedAt: number,
  ) => void;
  getEpicRunSettings: (epicId: string) => ChatRunSettings | null;
  clearEpicRunSettings: (epicIds: ReadonlyArray<string>) => void;
  resetForTests: () => void;
}

export const useComposerRunSettingsStore = create<ComposerRunSettingsStore>()(
  persist(
    (set, get) => ({
      globalLastRunSettings: null,
      epicRunSettingsByEpicId: {},
      setGlobalRunSettings: (settings, _updatedAt) => {
        if (!chatRunSettingsModelResolved(settings)) return;
        set((state) => {
          if (
            state.globalLastRunSettings !== null &&
            sameChatRunSettings(state.globalLastRunSettings, settings)
          ) {
            return state;
          }
          return { globalLastRunSettings: { ...settings } };
        });
      },
      setEpicRunSettings: (epicId, settings, updatedAt) => {
        if (!chatRunSettingsModelResolved(settings)) return;
        // Always write - no value dedup. `updatedAt` is the recency key the cap
        // sorts on, so even re-selecting the same settings must refresh it; a
        // just-touched epic must not be evicted as "least recently used".
        set((state) => ({
          epicRunSettingsByEpicId: cappedByUpdatedAt(
            {
              ...state.epicRunSettingsByEpicId,
              [epicId]: { settings: { ...settings }, updatedAt },
            },
            COMPOSER_RUN_SETTINGS_EPIC_CAP,
          ),
        }));
      },
      getEpicRunSettings: (epicId) => {
        const entries = get().epicRunSettingsByEpicId;
        return Object.hasOwn(entries, epicId) ? entries[epicId].settings : null;
      },
      clearEpicRunSettings: (epicIds) => {
        if (epicIds.length === 0) return;
        set((state) => {
          let changed = false;
          const next = { ...state.epicRunSettingsByEpicId };
          for (const epicId of epicIds) {
            if (!Object.hasOwn(next, epicId)) continue;
            delete next[epicId];
            changed = true;
          }
          return changed ? { epicRunSettingsByEpicId: next } : state;
        });
      },
      resetForTests: () => {
        set({
          globalLastRunSettings: null,
          epicRunSettingsByEpicId: {},
        });
      },
    }),
    {
      ...basePersistOptions(composerRunSettingsKey(null)),
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => ({
        globalLastRunSettings: state.globalLastRunSettings,
        epicRunSettingsByEpicId: state.epicRunSettingsByEpicId,
      }),
    },
  ),
);

function chatRunSettingsModelResolved(settings: ChatRunSettings): boolean {
  return settings.model.length > 0;
}

function sameChatRunSettings(a: ChatRunSettings, b: ChatRunSettings): boolean {
  // Keyed by every `ChatRunSettings` field via `satisfies`: adding a field to
  // the type forces an entry here (compile error otherwise), so the
  // comparison can't silently ignore a new field.
  const fieldsEqual = {
    harnessId: a.harnessId === b.harnessId,
    model: a.model === b.model,
    permissionMode: a.permissionMode === b.permissionMode,
    reasoningEffort: a.reasoningEffort === b.reasoningEffort,
    serviceTier: a.serviceTier === b.serviceTier,
    agentMode: a.agentMode === b.agentMode,
    // `??` guards a pre-profile persisted blob (the field is missing, not
    // `null`, on an old serialized `ChatRunSettings`).
    profileId: (a.profileId ?? null) === (b.profileId ?? null),
  } satisfies Record<keyof ChatRunSettings, boolean>;
  return Object.values(fieldsEqual).every((equal) => equal);
}
