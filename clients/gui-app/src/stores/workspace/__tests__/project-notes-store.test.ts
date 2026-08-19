import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_PROJECT_NOTES_BUCKET,
  selectProjectNotesBucket,
  useProjectNotesStore,
} from "../project-notes-store";

const HOST_A = "host-a";
const HOST_B = "host-b";

function bucket(hostId: string | null) {
  return selectProjectNotesBucket(useProjectNotesStore.getState(), hostId);
}

beforeEach(() => {
  window.localStorage.clear();
  useProjectNotesStore.setState({ byHost: {} });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-19T13:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
});

describe("useProjectNotesStore", () => {
  it("starts empty and ignores a null host", () => {
    expect(bucket(HOST_A)).toBe(EMPTY_PROJECT_NOTES_BUCKET);
    expect(bucket(null)).toBe(EMPTY_PROJECT_NOTES_BUCKET);
    expect(
      useProjectNotesStore.getState().createNote(null, {
        title: "Nope",
        body: "",
        scope: { kind: "general" },
      }),
    ).toBeNull();
  });

  it("creates a host-scoped note and leaves other hosts untouched", () => {
    const id = useProjectNotesStore.getState().createNote(HOST_A, {
      title: "Ads budget",
      body: "cut spend",
      scope: { kind: "project", profileId: "p-titanos" },
    });
    expect(id).toEqual(expect.any(String));
    const created = bucket(HOST_A).notes[0];
    expect(created).toMatchObject({
      id,
      title: "Ads budget",
      body: "cut spend",
      scope: { kind: "project", profileId: "p-titanos" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(bucket(HOST_B).notes).toEqual([]);
  });

  it("refreshes updatedAt on updateNote", () => {
    const id = useProjectNotesStore.getState().createNote(HOST_A, {
      title: "Old",
      body: "v1",
      scope: { kind: "general" },
    });
    vi.setSystemTime(new Date("2026-08-19T13:05:00.000Z"));
    useProjectNotesStore.getState().updateNote(HOST_A, id ?? "", {
      title: "New",
      body: "v2",
      scope: undefined,
    });
    const updated = bucket(HOST_A).notes[0];
    expect(updated.title).toBe("New");
    expect(updated.body).toBe("v2");
    expect(updated.updatedAt).toBe(Date.now());
    expect(updated.createdAt).toBe(Date.parse("2026-08-19T13:00:00.000Z"));
  });

  it("deletes a note on its own host only", () => {
    const id = useProjectNotesStore.getState().createNote(HOST_A, {
      title: "Gone",
      body: "",
      scope: { kind: "general" },
    });
    useProjectNotesStore.getState().deleteNote(HOST_B, id ?? "");
    expect(bucket(HOST_A).notes).toHaveLength(1);
    useProjectNotesStore.getState().deleteNote(HOST_A, id ?? "");
    expect(bucket(HOST_A).notes).toEqual([]);
  });

  it("reassigns a project's notes to General", () => {
    useProjectNotesStore.getState().createNote(HOST_A, {
      title: "Keep",
      body: "",
      scope: { kind: "project", profileId: "p-crm" },
    });
    const id = useProjectNotesStore.getState().createNote(HOST_A, {
      title: "Move",
      body: "",
      scope: { kind: "project", profileId: "p-titanos" },
    });
    useProjectNotesStore
      .getState()
      .reassignProjectNotesToGeneral(HOST_A, "p-titanos");
    const moved = bucket(HOST_A).notes.find((note) => note.id === id);
    expect(moved?.scope).toEqual({ kind: "general" });
    expect(
      bucket(HOST_A).notes.find((note) => note.title === "Keep")?.scope,
    ).toEqual({ kind: "project", profileId: "p-crm" });
  });

  it("rejects a 201st note on the same host", () => {
    for (let i = 0; i < 200; i += 1) {
      const created = useProjectNotesStore.getState().createNote(HOST_A, {
        title: `n${String(i)}`,
        body: "",
        scope: { kind: "general" },
      });
      expect(created).toEqual(expect.any(String));
    }
    expect(
      useProjectNotesStore.getState().createNote(HOST_A, {
        title: "overflow",
        body: "",
        scope: { kind: "general" },
      }),
    ).toBeNull();
    expect(bucket(HOST_A).notes).toHaveLength(200);
  });

  it("rehydration drops malformed notes and empty host keys", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:project-notes",
      JSON.stringify({
        state: {
          byHost: {
            "": {
              notes: [
                {
                  id: "ghost",
                  title: "Ghost",
                  body: "",
                  scope: { kind: "general" },
                  createdAt: 1,
                  updatedAt: 1,
                },
              ],
            },
            [HOST_A]: {
              notes: [
                {
                  id: "ok",
                  title: "Keep",
                  body: "yes",
                  scope: { kind: "general" },
                  createdAt: 1,
                  updatedAt: 2,
                },
                {
                  id: "bad-scope",
                  title: "Nope",
                  body: "",
                  scope: { kind: "project" },
                  createdAt: 1,
                  updatedAt: 1,
                },
                {
                  id: "",
                  title: "empty-id",
                  body: "",
                  scope: { kind: "general" },
                  createdAt: 1,
                  updatedAt: 1,
                },
              ],
            },
          },
        },
        version: 1,
      }),
    );
    await useProjectNotesStore.persist.rehydrate();
    expect(bucket("").notes).toEqual([]);
    expect(bucket(HOST_A).notes.map((note) => note.id)).toEqual(["ok"]);
  });
});
