import { create } from "zustand";
import { persist } from "zustand/middleware";
import { v4 as uuidv4 } from "uuid";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import type {
  NoteScope,
  ProjectNote,
} from "@/lib/workspace/project-notes-visibility";

export const MAX_NOTES_PER_HOST = 200;

export interface ProjectNotesHostBucket {
  readonly notes: ReadonlyArray<ProjectNote>;
}

export interface ProjectNoteCreateInput {
  readonly title: string;
  readonly body: string;
  readonly scope: NoteScope;
}

export interface ProjectNotePatch {
  readonly title: string | undefined;
  readonly body: string | undefined;
  readonly scope: NoteScope | undefined;
}

interface ProjectNotesStore {
  byHost: Readonly<Record<string, ProjectNotesHostBucket>>;
  createNote: (
    hostId: string | null,
    input: ProjectNoteCreateInput,
  ) => string | null;
  updateNote: (
    hostId: string | null,
    noteId: string,
    patch: ProjectNotePatch,
  ) => void;
  deleteNote: (hostId: string | null, noteId: string) => void;
  reassignProjectNotesToGeneral: (
    hostId: string | null,
    profileId: string,
  ) => void;
}

export const EMPTY_PROJECT_NOTES_BUCKET: ProjectNotesHostBucket = {
  notes: [],
};

export function selectProjectNotesBucket(
  state: Pick<ProjectNotesStore, "byHost">,
  hostId: string | null,
): ProjectNotesHostBucket {
  if (hostId === null || !Object.hasOwn(state.byHost, hostId)) {
    return EMPTY_PROJECT_NOTES_BUCKET;
  }
  return state.byHost[hostId];
}

export const useProjectNotesStore = create<ProjectNotesStore>()(
  persist(
    (set, get) => ({
      byHost: {},
      createNote: (hostId, input) => {
        if (hostId === null) return null;
        if (!isValidScope(input.scope)) return null;
        const bucket = selectProjectNotesBucket(get(), hostId);
        if (bucket.notes.length >= MAX_NOTES_PER_HOST) return null;
        const now = Date.now();
        const id = uuidv4();
        const note: ProjectNote = {
          id,
          title: input.title,
          body: input.body,
          scope: input.scope,
          createdAt: now,
          updatedAt: now,
        };
        set({
          byHost: {
            ...get().byHost,
            [hostId]: { notes: [...bucket.notes, note] },
          },
        });
        return id;
      },
      updateNote: (hostId, noteId, patch) => {
        if (hostId === null) return;
        if (patch.scope !== undefined && !isValidScope(patch.scope)) return;
        const bucket = selectProjectNotesBucket(get(), hostId);
        const current = bucket.notes.find((note) => note.id === noteId);
        if (current === undefined) return;
        const next: ProjectNote = {
          ...current,
          title: patch.title ?? current.title,
          body: patch.body ?? current.body,
          scope: patch.scope ?? current.scope,
          updatedAt: Date.now(),
        };
        if (
          next.title === current.title &&
          next.body === current.body &&
          scopesEqual(next.scope, current.scope)
        ) {
          return;
        }
        set({
          byHost: {
            ...get().byHost,
            [hostId]: {
              notes: bucket.notes.map((note) =>
                note.id === noteId ? next : note,
              ),
            },
          },
        });
      },
      deleteNote: (hostId, noteId) => {
        if (hostId === null) return;
        const bucket = selectProjectNotesBucket(get(), hostId);
        if (!bucket.notes.some((note) => note.id === noteId)) return;
        set({
          byHost: {
            ...get().byHost,
            [hostId]: {
              notes: bucket.notes.filter((note) => note.id !== noteId),
            },
          },
        });
      },
      reassignProjectNotesToGeneral: (hostId, profileId) => {
        if (hostId === null) return;
        const bucket = selectProjectNotesBucket(get(), hostId);
        let changed = false;
        const now = Date.now();
        const notes = bucket.notes.map((note) => {
          if (
            note.scope.kind !== "project" ||
            note.scope.profileId !== profileId
          ) {
            return note;
          }
          changed = true;
          return {
            ...note,
            scope: { kind: "general" as const },
            updatedAt: now,
          };
        });
        if (!changed) return;
        set({
          byHost: {
            ...get().byHost,
            [hostId]: { notes },
          },
        });
      },
    }),
    {
      ...basePersistOptions(persistKey(STORE_KEYS.projectNotes)),
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

function scopesEqual(left: NoteScope, right: NoteScope): boolean {
  if (left.kind === "general" && right.kind === "general") return true;
  return (
    left.kind === "project" &&
    right.kind === "project" &&
    left.profileId === right.profileId
  );
}

function isValidScope(value: NoteScope): boolean {
  if (value.kind === "general") return true;
  return value.kind === "project" && value.profileId.trim().length > 0;
}

function parsePersistedByHost(
  value: unknown,
): Readonly<Record<string, ProjectNotesHostBucket>> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([hostId, rawBucket]) => {
      if (!isRecord(rawBucket) || hostId.length === 0) return [];
      const notes = parsePersistedNotes(rawBucket.notes);
      if (notes.length === 0) return [];
      return [[hostId, { notes }]];
    }),
  );
}

function parsePersistedNotes(value: unknown): ReadonlyArray<ProjectNote> {
  if (!Array.isArray(value)) return [];
  const notes: ProjectNote[] = [];
  const seenIds = new Set<string>();
  for (const raw of value) {
    const note = parsePersistedNote(raw);
    if (note === null) continue;
    if (seenIds.has(note.id)) continue;
    seenIds.add(note.id);
    notes.push(note);
    if (notes.length >= MAX_NOTES_PER_HOST) break;
  }
  return notes;
}

function parsePersistedNote(value: unknown): ProjectNote | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || value.id.length === 0) return null;
  if (typeof value.title !== "string") return null;
  if (typeof value.body !== "string") return null;
  const scope = parsePersistedScope(value.scope);
  if (scope === null) return null;
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) {
    return null;
  }
  if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) {
    return null;
  }
  return {
    id: value.id,
    title: value.title,
    body: value.body,
    scope,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function parsePersistedScope(value: unknown): NoteScope | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "general") return { kind: "general" };
  if (value.kind !== "project") return null;
  if (typeof value.profileId !== "string" || value.profileId.trim().length === 0) {
    return null;
  }
  return { kind: "project", profileId: value.profileId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
