import { describe, expect, it } from "vitest";
import {
  CHAT_ARTIFACT_DND_TYPE,
  readEpicCanvasDragSourceData,
} from "@/components/epic-canvas/dnd/dnd";

const WELL_FORMED = {
  kind: CHAT_ARTIFACT_DND_TYPE,
  epicId: "epic-1",
  viewTabId: "tab-1",
  artifact: {
    id: "artifact-1",
    type: "review",
    name: "Consolidated Code Review",
    hostId: "host-1",
  },
} as const;

describe("readChatArtifactSource (via readEpicCanvasDragSourceData)", () => {
  it("round-trips a well-formed payload to the typed source", () => {
    expect(readEpicCanvasDragSourceData(WELL_FORMED)).toEqual({
      kind: CHAT_ARTIFACT_DND_TYPE,
      epicId: "epic-1",
      viewTabId: "tab-1",
      artifact: {
        id: "artifact-1",
        type: "review",
        name: "Consolidated Code Review",
        hostId: "host-1",
      },
    });
  });

  it("accepts every record-backed artifact kind", () => {
    for (const type of ["spec", "ticket", "story", "review"] as const) {
      const source = readEpicCanvasDragSourceData({
        ...WELL_FORMED,
        artifact: { ...WELL_FORMED.artifact, type },
      });
      expect(source).not.toBeNull();
      expect(source?.kind).toBe(CHAT_ARTIFACT_DND_TYPE);
    }
  });

  it("returns null when epicId is missing or empty", () => {
    expect(
      readEpicCanvasDragSourceData({ ...WELL_FORMED, epicId: "" }),
    ).toBeNull();
    const { epicId: _omitted, ...withoutEpicId } = WELL_FORMED;
    expect(readEpicCanvasDragSourceData(withoutEpicId)).toBeNull();
  });

  it("returns null when viewTabId is missing or empty", () => {
    expect(
      readEpicCanvasDragSourceData({ ...WELL_FORMED, viewTabId: "" }),
    ).toBeNull();
    const { viewTabId: _omitted, ...withoutViewTabId } = WELL_FORMED;
    expect(readEpicCanvasDragSourceData(withoutViewTabId)).toBeNull();
  });

  it("returns null when artifact.id is empty", () => {
    expect(
      readEpicCanvasDragSourceData({
        ...WELL_FORMED,
        artifact: { ...WELL_FORMED.artifact, id: "" },
      }),
    ).toBeNull();
  });

  it("returns null when artifact.name is empty", () => {
    expect(
      readEpicCanvasDragSourceData({
        ...WELL_FORMED,
        artifact: { ...WELL_FORMED.artifact, name: "" },
      }),
    ).toBeNull();
  });

  it("returns null when artifact.hostId is empty", () => {
    expect(
      readEpicCanvasDragSourceData({
        ...WELL_FORMED,
        artifact: { ...WELL_FORMED.artifact, hostId: "" },
      }),
    ).toBeNull();
  });

  it("returns null for an unknown artifact.type", () => {
    expect(
      readEpicCanvasDragSourceData({
        ...WELL_FORMED,
        artifact: { ...WELL_FORMED.artifact, type: "workspace" },
      }),
    ).toBeNull();
  });

  it("rejects non-artifact openable kinds (chat, terminal-agent)", () => {
    for (const type of ["chat", "terminal-agent"] as const) {
      expect(
        readEpicCanvasDragSourceData({
          ...WELL_FORMED,
          artifact: { ...WELL_FORMED.artifact, type },
        }),
      ).toBeNull();
    }
  });

  it("returns null when artifact is missing", () => {
    const { artifact: _omitted, ...withoutArtifact } = WELL_FORMED;
    expect(readEpicCanvasDragSourceData(withoutArtifact)).toBeNull();
  });
});
