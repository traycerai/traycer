import { create } from "zustand";
import { persist } from "zustand/middleware";
import { v4 as uuidv4 } from "uuid";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import { nextActiveProfileIdAfterDelete } from "@/lib/workspace/next-active-profile-after-delete";
import {
  resolvePrimaryPath,
  trimFoldersPreservingPrimary,
} from "@/lib/worktree/resolve-primary-path";

export const PROJECT_PROFILE_COLORS = [
  "orange",
  "blue",
  "green",
  "purple",
  "rose",
  "amber",
] as const;

export type ProjectProfileColor = (typeof PROJECT_PROFILE_COLORS)[number];

export interface ProjectProfile {
  readonly id: string;
  readonly name: string;
  readonly color: ProjectProfileColor;
  readonly folderPaths: ReadonlyArray<string>;
  readonly primaryPath: string | null;
  readonly epicIds: ReadonlyArray<string>;
}

export interface ProjectProfileCreateInput {
  readonly name: string;
  readonly color: ProjectProfileColor;
  readonly folderPaths: ReadonlyArray<string>;
  readonly primaryPath: string | null;
}

export interface ProjectProfilesHostBucket {
  readonly profiles: ReadonlyArray<ProjectProfile>;
  readonly activeProfileId: string | null;
}

interface ProjectProfilesStore {
  byHost: Readonly<Record<string, ProjectProfilesHostBucket>>;
  createProfile: (
    hostId: string | null,
    input: ProjectProfileCreateInput,
  ) => string | null;
  renameProfile: (
    hostId: string | null,
    profileId: string,
    name: string,
  ) => void;
  setProfileColor: (
    hostId: string | null,
    profileId: string,
    color: ProjectProfileColor,
  ) => void;
  deleteProfile: (hostId: string | null, profileId: string) => void;
  setActiveProfile: (
    hostId: string | null,
    profileId: string | null,
  ) => void;
  setProfileFolders: (
    hostId: string | null,
    profileId: string,
    folderPaths: ReadonlyArray<string>,
    primaryPath: string | null,
  ) => void;
  addProfileFolder: (
    hostId: string | null,
    profileId: string,
    folderPath: string,
  ) => void;
  removeProfileFolder: (
    hostId: string | null,
    profileId: string,
    folderPath: string,
  ) => void;
  setProfilePrimary: (
    hostId: string | null,
    profileId: string,
    folderPath: string,
  ) => void;
  addProfileEpics: (
    hostId: string | null,
    profileId: string,
    epicIds: ReadonlyArray<string>,
  ) => void;
  removeProfileEpic: (
    hostId: string | null,
    profileId: string,
    epicId: string,
  ) => void;
}

const MAX_PROFILES_PER_HOST = 20;
const MAX_FOLDERS_PER_PROFILE = 50;
const MAX_EPICS_PER_PROFILE = 200;

export const EMPTY_PROJECT_PROFILES_BUCKET: ProjectProfilesHostBucket = {
  profiles: [],
  activeProfileId: null,
};

export function selectProjectProfilesBucket(
  state: Pick<ProjectProfilesStore, "byHost">,
  hostId: string | null,
): ProjectProfilesHostBucket {
  if (hostId === null || !Object.hasOwn(state.byHost, hostId)) {
    return EMPTY_PROJECT_PROFILES_BUCKET;
  }
  return state.byHost[hostId];
}

export function selectActiveProjectProfile(
  state: Pick<ProjectProfilesStore, "byHost">,
  hostId: string | null,
): ProjectProfile | null {
  const bucket = selectProjectProfilesBucket(state, hostId);
  if (bucket.activeProfileId === null) return null;
  return (
    bucket.profiles.find((profile) => profile.id === bucket.activeProfileId) ??
    null
  );
}

export const useProjectProfilesStore = create<ProjectProfilesStore>()(
  persist(
    (set, get) => ({
      byHost: {},
      createProfile: (hostId, input) => {
        if (hostId === null) return null;
        const name = input.name.trim();
        if (name.length === 0) return null;
        if (!isProjectProfileColor(input.color)) return null;
        const bucket = selectProjectProfilesBucket(get(), hostId);
        if (bucket.profiles.length >= MAX_PROFILES_PER_HOST) return null;
        const id = uuidv4();
        const profile = normalizeProfile({
          id,
          name,
          color: input.color,
          folderPaths: input.folderPaths,
          primaryPath: input.primaryPath,
          epicIds: [],
        });
        set((state) => ({
          byHost: {
            ...state.byHost,
            [hostId]: {
              profiles: [...bucket.profiles, profile],
              activeProfileId: bucket.activeProfileId,
            },
          },
        }));
        return id;
      },
      renameProfile: (hostId, profileId, name) => {
        const trimmed = name.trim();
        if (trimmed.length === 0) return;
        updateProfile(set, get, { hostId, profileId }, (profile) =>
          profile.name === trimmed ? profile : { ...profile, name: trimmed },
        );
      },
      setProfileColor: (hostId, profileId, color) => {
        if (!isProjectProfileColor(color)) return;
        updateProfile(set, get, { hostId, profileId }, (profile) =>
          profile.color === color ? profile : { ...profile, color },
        );
      },
      deleteProfile: (hostId, profileId) => {
        if (hostId === null) return;
        set((state) => {
          const bucket = selectProjectProfilesBucket(state, hostId);
          if (!bucket.profiles.some((profile) => profile.id === profileId)) {
            return state;
          }
          return {
            byHost: {
              ...state.byHost,
              [hostId]: {
                profiles: bucket.profiles.filter(
                  (profile) => profile.id !== profileId,
                ),
                activeProfileId: nextActiveProfileIdAfterDelete({
                  profiles: bucket.profiles,
                  activeProfileId: bucket.activeProfileId,
                  deletedProfileId: profileId,
                }),
              },
            },
          };
        });
      },
      setActiveProfile: (hostId, profileId) => {
        if (hostId === null) return;
        set((state) => {
          const bucket = selectProjectProfilesBucket(state, hostId);
          if (profileId !== null) {
            const exists = bucket.profiles.some(
              (profile) => profile.id === profileId,
            );
            if (!exists) return state;
          }
          if (bucket.activeProfileId === profileId) return state;
          return {
            byHost: {
              ...state.byHost,
              [hostId]: { ...bucket, activeProfileId: profileId },
            },
          };
        });
      },
      setProfileFolders: (hostId, profileId, folderPaths, primaryPath) => {
        updateProfile(set, get, { hostId, profileId }, (profile) =>
          normalizeProfile({
            ...profile,
            folderPaths,
            primaryPath,
          }),
        );
      },
      addProfileFolder: (hostId, profileId, folderPath) => {
        const path = folderPath.trim();
        if (path.length === 0) return;
        updateProfile(set, get, { hostId, profileId }, (profile) => {
          if (profile.folderPaths.includes(path)) return profile;
          return normalizeProfile({
            ...profile,
            folderPaths: [...profile.folderPaths, path],
            primaryPath: profile.primaryPath,
          });
        });
      },
      removeProfileFolder: (hostId, profileId, folderPath) => {
        updateProfile(set, get, { hostId, profileId }, (profile) => {
          if (!profile.folderPaths.includes(folderPath)) return profile;
          return normalizeProfile({
            ...profile,
            folderPaths: profile.folderPaths.filter(
              (path) => path !== folderPath,
            ),
            primaryPath: profile.primaryPath,
          });
        });
      },
      setProfilePrimary: (hostId, profileId, folderPath) => {
        updateProfile(set, get, { hostId, profileId }, (profile) => {
          if (!profile.folderPaths.includes(folderPath)) return profile;
          if (profile.primaryPath === folderPath) return profile;
          return { ...profile, primaryPath: folderPath };
        });
      },
      addProfileEpics: (hostId, profileId, epicIds) => {
        updateProfile(set, get, { hostId, profileId }, (profile) =>
          mergeProfileEpicIds(profile, epicIds),
        );
      },
      removeProfileEpic: (hostId, profileId, epicId) => {
        updateProfile(set, get, { hostId, profileId }, (profile) => {
          if (!profile.epicIds.includes(epicId)) return profile;
          return {
            ...profile,
            epicIds: profile.epicIds.filter((id) => id !== epicId),
          };
        });
      },
    }),
    {
      ...basePersistOptions(persistKey(STORE_KEYS.projectProfiles)),
      merge: (persistedState, currentState) => {
        const persisted: Record<string, unknown> = isRecord(persistedState)
          ? persistedState
          : {};
        return {
          ...currentState,
          byHost: parsePersistedByHost(persisted.byHost),
        };
      },
    },
  ),
);

function updateProfile(
  set: (partial: {
    byHost: Readonly<Record<string, ProjectProfilesHostBucket>>;
  }) => void,
  get: () => ProjectProfilesStore,
  target: { readonly hostId: string | null; readonly profileId: string },
  update: (profile: ProjectProfile) => ProjectProfile,
): void {
  const { hostId, profileId } = target;
  if (hostId === null) return;
  const bucket = selectProjectProfilesBucket(get(), hostId);
  const current = bucket.profiles.find((profile) => profile.id === profileId);
  if (current === undefined) return;
  const next = update(current);
  if (next === current) return;
  set({
    byHost: {
      ...get().byHost,
      [hostId]: {
        ...bucket,
        profiles: bucket.profiles.map((profile) =>
          profile.id === profileId ? next : profile,
        ),
      },
    },
  });
}

function normalizeProfile(input: ProjectProfile): ProjectProfile {
  const seen = new Set<string>();
  const folderPaths: string[] = [];
  for (const raw of input.folderPaths) {
    const path = raw.trim();
    if (path.length === 0 || seen.has(path)) continue;
    seen.add(path);
    folderPaths.push(path);
  }
  const trimmed = trimFoldersPreservingPrimary(
    folderPaths,
    input.primaryPath,
    MAX_FOLDERS_PER_PROFILE,
  );
  return {
    id: input.id,
    name: input.name,
    color: input.color,
    folderPaths: trimmed,
    primaryPath: resolvePrimaryPath(trimmed, input.primaryPath),
    epicIds: normalizeEpicIds(input.epicIds),
  };
}

function mergeProfileEpicIds(
  profile: ProjectProfile,
  epicIds: ReadonlyArray<string>,
): ProjectProfile {
  const next = normalizeEpicIds([...profile.epicIds, ...epicIds]);
  if (next.length === profile.epicIds.length) {
    const same = next.every((id, index) => id === profile.epicIds[index]);
    if (same) return profile;
  }
  return { ...profile, epicIds: next };
}

function normalizeEpicIds(raw: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Set<string>();
  const epicIds: string[] = [];
  for (const value of raw) {
    const id = value.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    epicIds.push(id);
    if (epicIds.length >= MAX_EPICS_PER_PROFILE) break;
  }
  return epicIds;
}

function parsePersistedByHost(
  value: unknown,
): Readonly<Record<string, ProjectProfilesHostBucket>> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([hostId, rawBucket]) => {
      if (!isRecord(rawBucket) || hostId.length === 0) return [];
      const profiles = parsePersistedProfiles(rawBucket.profiles);
      const activeProfileId = parsePersistedActiveId(
        rawBucket.activeProfileId,
        profiles,
      );
      if (profiles.length === 0 && activeProfileId === null) return [];
      return [[hostId, { profiles, activeProfileId }]];
    }),
  );
}

function parsePersistedProfiles(value: unknown): ReadonlyArray<ProjectProfile> {
  if (!Array.isArray(value)) return [];
  const profiles: ProjectProfile[] = [];
  const seenIds = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    if (typeof raw.id !== "string" || raw.id.length === 0) continue;
    if (seenIds.has(raw.id)) continue;
    if (typeof raw.name !== "string") continue;
    const name = raw.name.trim();
    if (name.length === 0) continue;
    if (!isProjectProfileColor(raw.color)) continue;
    seenIds.add(raw.id);
    profiles.push(
      normalizeProfile({
        id: raw.id,
        name,
        color: raw.color,
        folderPaths: parsePersistedFolderPaths(raw.folderPaths),
        primaryPath:
          typeof raw.primaryPath === "string" ? raw.primaryPath : null,
        epicIds: parsePersistedEpicIds(raw.epicIds),
      }),
    );
    if (profiles.length >= MAX_PROFILES_PER_HOST) break;
  }
  return profiles;
}

function parsePersistedFolderPaths(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    typeof entry === "string" && entry.trim().length > 0 ? [entry] : [],
  );
}

function parsePersistedEpicIds(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    typeof entry === "string" && entry.trim().length > 0 ? [entry] : [],
  );
}

function parsePersistedActiveId(
  value: unknown,
  profiles: ReadonlyArray<ProjectProfile>,
): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return profiles.some((profile) => profile.id === value) ? value : null;
}

export function isProjectProfileColor(
  value: unknown,
): value is ProjectProfileColor {
  return (
    typeof value === "string" &&
    (PROJECT_PROFILE_COLORS as readonly string[]).includes(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
