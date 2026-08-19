import { describe, expect, it } from "vitest";
import {
  defaultNoteScope,
  displayNoteTitle,
  groupVisibleNotes,
  visibleNotes,
  type ProjectNote,
} from "../project-notes-visibility";

const general: ProjectNote = {
  id: "g1",
  title: "Buy milk",
  body: "2 liters",
  scope: { kind: "general" },
  createdAt: 1,
  updatedAt: 10,
};
const titanos: ProjectNote = {
  id: "t1",
  title: "Ads budget",
  body: "cut spend",
  scope: { kind: "project", profileId: "p-titanos" },
  createdAt: 2,
  updatedAt: 20,
};
const crm: ProjectNote = {
  id: "c1",
  title: "Inbox SLA",
  body: "reply in 1h",
  scope: { kind: "project", profileId: "p-crm" },
  createdAt: 3,
  updatedAt: 30,
};
const orphan: ProjectNote = {
  id: "o1",
  title: "Old project",
  body: "left behind",
  scope: { kind: "project", profileId: "p-gone" },
  createdAt: 4,
  updatedAt: 40,
};

describe("visibleNotes", () => {
  it("shows every note on All projects", () => {
    expect(
      visibleNotes({
        notes: [general, titanos, crm],
        activeProfileId: null,
        query: "",
      }).map((note) => note.id),
    ).toEqual(["g1", "t1", "c1"]);
  });

  it("hides another project's note while Titanos is active", () => {
    expect(
      visibleNotes({
        notes: [general, titanos, crm],
        activeProfileId: "p-titanos",
        query: "",
      }).map((note) => note.id),
    ).toEqual(["g1", "t1"]);
  });

  it("does not leak a hidden project note through search", () => {
    expect(
      visibleNotes({
        notes: [general, titanos, crm],
        activeProfileId: "p-titanos",
        query: "Inbox",
      }),
    ).toEqual([]);
  });

  it("finds a visible note by body text", () => {
    expect(
      visibleNotes({
        notes: [general, titanos, crm],
        activeProfileId: "p-titanos",
        query: "spend",
      }).map((note) => note.id),
    ).toEqual(["t1"]);
  });
});

describe("groupVisibleNotes", () => {
  it("keeps General separate and follows profile order", () => {
    const grouped = groupVisibleNotes({
      notes: [crm, general, titanos],
      activeProfileId: null,
      query: "",
      profileIds: ["p-titanos", "p-crm"],
    });
    expect(grouped.general.map((note) => note.id)).toEqual(["g1"]);
    expect(grouped.projectSections.map((section) => section.profileId)).toEqual([
      "p-titanos",
      "p-crm",
    ]);
    expect(grouped.orphan).toEqual([]);
  });

  it("puts notes whose project is gone in the orphan bucket", () => {
    const grouped = groupVisibleNotes({
      notes: [general, orphan],
      activeProfileId: null,
      query: "",
      profileIds: ["p-titanos"],
    });
    expect(grouped.orphan.map((note) => note.id)).toEqual(["o1"]);
    expect(grouped.projectSections).toEqual([]);
  });
});

describe("displayNoteTitle", () => {
  it("falls back to Untitled note", () => {
    expect(displayNoteTitle("   ")).toBe("Untitled note");
  });
});

describe("defaultNoteScope", () => {
  it("uses the active project, else General", () => {
    expect(defaultNoteScope("p-titanos")).toEqual({
      kind: "project",
      profileId: "p-titanos",
    });
    expect(defaultNoteScope(null)).toEqual({ kind: "general" });
  });
});
