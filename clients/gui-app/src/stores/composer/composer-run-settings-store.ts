import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { chatRunSettingsSchema } from "@traycer/protocol/host/agent/gui/subscribe";
import { cappedByUpdatedAt } from "@/lib/bounded-record";
import { basePersistOptions, composerRunSettingsKey } from "@/lib/persist";

export const COMPOSER_RUN_SETTINGS_EPIC_CAP = 200;

export interface ComposerRunSettingsEntry {
  readonly settings: ChatRunSettings;
  readonly updatedAt: number;
}

// One flat record over every (epic, host) pair, space-separated like the
// sibling harness-memory store's `harnessModelKey`. An epic id is a UUID and
// never contains a space, so splitting at the FIRST space always recovers
// the epic id - `clearEpicRunSettings` matches an epic across all hosts - and
// everything after it is the host id (see `cappedForHost`, which LRUs each
// host's slice separately).
function epicHostKey(epicId: string, hostId: string): string {
  return `${epicId} ${hostId}`;
}

function epicIdOfKey(key: string): string {
  const separatorIndex = key.indexOf(" ");
  return separatorIndex === -1 ? key : key.slice(0, separatorIndex);
}

function hostIdOfKey(key: string): string | null {
  const separatorIndex = key.indexOf(" ");
  return separatorIndex === -1 ? null : key.slice(separatorIndex + 1);
}

/**
 * Apply the epic cap WITHIN one host's entries. The record is flat, but the
 * cap has always meant "how many epics one host remembers": capping the flat
 * (epic, host) map instead would divide each host's memory by the number of
 * hosts, so merely enrolling a second host would start evicting the first
 * host's epics. Only the written host's slice is trimmed, so the total is
 * bounded by cap x hosts - hosts are enrolled machines, a handful at most.
 */
function cappedForHost(
  entries: Record<string, ComposerRunSettingsEntry>,
  hostId: string,
): Record<string, ComposerRunSettingsEntry> {
  const hostEntries = Object.fromEntries(
    Object.entries(entries).filter(([key]) => hostIdOfKey(key) === hostId),
  );
  if (Object.keys(hostEntries).length <= COMPOSER_RUN_SETTINGS_EPIC_CAP) {
    return entries;
  }
  const kept = cappedByUpdatedAt(hostEntries, COMPOSER_RUN_SETTINGS_EPIC_CAP);
  return Object.fromEntries(
    Object.entries(entries).filter(
      ([key]) => hostIdOfKey(key) !== hostId || Object.hasOwn(kept, key),
    ),
  );
}

interface ComposerRunSettingsStore {
  // hostId -> the last settings any composer ran with ON THAT HOST. Hosts have
  // different harness/model/profile catalogs, so a cross-host read would seed
  // state the target host may not even be able to serve.
  globalLastRunSettingsByHostId: Record<string, ChatRunSettings>;
  // `${epicId} ${hostId}` -> that pair's last-run entry, LRU-capped per host.
  epicRunSettingsByEpicHost: Record<string, ComposerRunSettingsEntry>;
  // Frozen pre-host-scoping (v1) data, kept as a read-only fallback so the
  // common single-host install keeps its remembered settings across the
  // migration. Never written after migration; per-key reads prefer the host
  // bucket and fall back here only when it has no entry.
  legacyGlobalLastRunSettings: ChatRunSettings | null;
  legacyEpicRunSettingsByEpicId: Record<string, ComposerRunSettingsEntry>;
  // WRITE - `hostId === null` (no resolved target host) drops the write:
  // settings that cannot be attributed to a host must not leak across hosts.
  setGlobalRunSettings: (
    hostId: string | null,
    settings: ChatRunSettings,
    updatedAt: number,
  ) => void;
  setEpicRunSettings: (
    epicId: string,
    hostId: string | null,
    settings: ChatRunSettings,
    updatedAt: number,
  ) => void;
  getGlobalRunSettings: (hostId: string | null) => ChatRunSettings | null;
  getEpicRunSettings: (
    epicId: string,
    hostId: string | null,
  ) => ChatRunSettings | null;
  clearEpicRunSettings: (epicIds: ReadonlyArray<string>) => void;
  resetForTests: () => void;
}

/**
 * Reactive selector for a host's last-run settings (see
 * `getGlobalRunSettings` for the imperative twin). `hostId === null` - no
 * host resolved yet - reads only the legacy fallback.
 */
export function selectGlobalLastRunSettings(
  state: Pick<
    ComposerRunSettingsStore,
    "globalLastRunSettingsByHostId" | "legacyGlobalLastRunSettings"
  >,
  hostId: string | null,
): ChatRunSettings | null {
  if (
    hostId !== null &&
    Object.hasOwn(state.globalLastRunSettingsByHostId, hostId)
  ) {
    return state.globalLastRunSettingsByHostId[hostId];
  }
  return state.legacyGlobalLastRunSettings;
}

/** Reactive selector for one (epic, host) last-run entry, with the same
 *  per-key legacy fallback as `selectGlobalLastRunSettings`. */
export function selectEpicRunSettingsEntry(
  state: Pick<
    ComposerRunSettingsStore,
    "epicRunSettingsByEpicHost" | "legacyEpicRunSettingsByEpicId"
  >,
  epicId: string,
  hostId: string | null,
): ComposerRunSettingsEntry | null {
  if (hostId !== null) {
    const key = epicHostKey(epicId, hostId);
    if (Object.hasOwn(state.epicRunSettingsByEpicHost, key)) {
      return state.epicRunSettingsByEpicHost[key];
    }
  }
  return Object.hasOwn(state.legacyEpicRunSettingsByEpicId, epicId)
    ? state.legacyEpicRunSettingsByEpicId[epicId]
    : null;
}

interface ComposerRunSettingsPersistedState {
  readonly globalLastRunSettingsByHostId: Record<string, ChatRunSettings>;
  readonly epicRunSettingsByEpicHost: Record<string, ComposerRunSettingsEntry>;
  readonly legacyGlobalLastRunSettings: ChatRunSettings | null;
  readonly legacyEpicRunSettingsByEpicId: Record<
    string,
    ComposerRunSettingsEntry
  >;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePersistedChatRunSettings(value: unknown): ChatRunSettings | null {
  const parsed = chatRunSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parsePersistedEntry(value: unknown): ComposerRunSettingsEntry | null {
  if (!isRecord(value)) return null;
  const settings = parsePersistedChatRunSettings(value.settings);
  if (settings === null) return null;
  const { updatedAt } = value;
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return null;
  return { settings, updatedAt };
}

function parsePersistedEntryRecord(
  value: unknown,
): Record<string, ComposerRunSettingsEntry> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const parsed = parsePersistedEntry(entry);
      return parsed === null ? [] : [[key, parsed]];
    }),
  );
}

/**
 * v1 -> v2 migration. v1 stored one flat `globalLastRunSettings` +
 * `epicRunSettingsByEpicId` with no host coordinate, so switching hosts
 * restored another host's provider/model/reasoning. v2 keys both by host and
 * freezes the v1 data as the read-only legacy fallback (a migration cannot
 * know which host the flat data belonged to).
 */
export function migrateComposerRunSettingsPersistedState(
  persisted: unknown,
): ComposerRunSettingsPersistedState {
  if (!isRecord(persisted)) {
    return {
      globalLastRunSettingsByHostId: {},
      epicRunSettingsByEpicHost: {},
      legacyGlobalLastRunSettings: null,
      legacyEpicRunSettingsByEpicId: {},
    };
  }
  return {
    globalLastRunSettingsByHostId: {},
    epicRunSettingsByEpicHost: {},
    legacyGlobalLastRunSettings: parsePersistedChatRunSettings(
      persisted.globalLastRunSettings,
    ),
    legacyEpicRunSettingsByEpicId: parsePersistedEntryRecord(
      persisted.epicRunSettingsByEpicId,
    ),
  };
}

export const useComposerRunSettingsStore = create<ComposerRunSettingsStore>()(
  persist(
    (set, get) => ({
      globalLastRunSettingsByHostId: {},
      epicRunSettingsByEpicHost: {},
      legacyGlobalLastRunSettings: null,
      legacyEpicRunSettingsByEpicId: {},
      setGlobalRunSettings: (hostId, settings, _updatedAt) => {
        if (hostId === null) return;
        if (!chatRunSettingsModelResolved(settings)) return;
        set((state) => {
          const existing = Object.hasOwn(
            state.globalLastRunSettingsByHostId,
            hostId,
          )
            ? state.globalLastRunSettingsByHostId[hostId]
            : null;
          if (existing !== null && sameChatRunSettings(existing, settings)) {
            return state;
          }
          return {
            globalLastRunSettingsByHostId: {
              ...state.globalLastRunSettingsByHostId,
              [hostId]: { ...settings },
            },
          };
        });
      },
      setEpicRunSettings: (epicId, hostId, settings, updatedAt) => {
        if (hostId === null) return;
        if (!chatRunSettingsModelResolved(settings)) return;
        // Always write - no value dedup. `updatedAt` is the recency key the cap
        // sorts on, so even re-selecting the same settings must refresh it; a
        // just-touched epic must not be evicted as "least recently used".
        set((state) => ({
          epicRunSettingsByEpicHost: cappedForHost(
            {
              ...state.epicRunSettingsByEpicHost,
              [epicHostKey(epicId, hostId)]: {
                settings: { ...settings },
                updatedAt,
              },
            },
            hostId,
          ),
        }));
      },
      getGlobalRunSettings: (hostId) => {
        return selectGlobalLastRunSettings(get(), hostId);
      },
      getEpicRunSettings: (epicId, hostId) => {
        return (
          selectEpicRunSettingsEntry(get(), epicId, hostId)?.settings ?? null
        );
      },
      clearEpicRunSettings: (epicIds) => {
        if (epicIds.length === 0) return;
        const epicIdSet = new Set(epicIds);
        set((state) => {
          let changed = false;
          const nextByEpicHost = { ...state.epicRunSettingsByEpicHost };
          for (const key of Object.keys(nextByEpicHost)) {
            if (!epicIdSet.has(epicIdOfKey(key))) continue;
            delete nextByEpicHost[key];
            changed = true;
          }
          const nextLegacy = { ...state.legacyEpicRunSettingsByEpicId };
          for (const epicId of epicIds) {
            if (!Object.hasOwn(nextLegacy, epicId)) continue;
            delete nextLegacy[epicId];
            changed = true;
          }
          return changed
            ? {
                epicRunSettingsByEpicHost: nextByEpicHost,
                legacyEpicRunSettingsByEpicId: nextLegacy,
              }
            : state;
        });
      },
      resetForTests: () => {
        set({
          globalLastRunSettingsByHostId: {},
          epicRunSettingsByEpicHost: {},
          legacyGlobalLastRunSettings: null,
          legacyEpicRunSettingsByEpicId: {},
        });
      },
    }),
    {
      ...basePersistOptions(composerRunSettingsKey(null)),
      version: 2,
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => ({
        globalLastRunSettingsByHostId: state.globalLastRunSettingsByHostId,
        epicRunSettingsByEpicHost: state.epicRunSettingsByEpicHost,
        legacyGlobalLastRunSettings: state.legacyGlobalLastRunSettings,
        legacyEpicRunSettingsByEpicId: state.legacyEpicRunSettingsByEpicId,
      }),
      migrate: (persisted) =>
        migrateComposerRunSettingsPersistedState(persisted),
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
