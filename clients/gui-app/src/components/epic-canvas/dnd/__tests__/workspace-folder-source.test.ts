import { describe, expect, it } from "vitest";
import {
  WORKSPACE_FOLDER_DND_TYPE,
  readEpicCanvasDragSourceData,
} from "@/components/epic-canvas/dnd/dnd";

const SOURCE = {
  kind: WORKSPACE_FOLDER_DND_TYPE,
  epicId: "epic-1",
  viewTabId: "view-1",
  hostId: "host-1",
  workspacePath: "/repo",
  folderPath: "src/components/",
  name: "components",
} as const;

describe("workspace-folder drag source", () => {
  it("round-trips a host-canonical directory identity", () => {
    expect(readEpicCanvasDragSourceData(SOURCE)).toEqual(SOURCE);
  });

  it("requires a trailing-slash folder path", () => {
    expect(
      readEpicCanvasDragSourceData({
        ...SOURCE,
        folderPath: "src/components",
      }),
    ).toBeNull();
  });

  it("requires the host that owns the workspace path", () => {
    expect(
      readEpicCanvasDragSourceData({
        ...SOURCE,
        hostId: "",
      }),
    ).toBeNull();
  });

  it.each([
    ["workspace path", { workspacePath: "" }],
    ["folder name", { name: "" }],
    ["canvas scope", { viewTabId: "" }],
  ])("rejects a missing %s", (_label, override) => {
    expect(
      readEpicCanvasDragSourceData({
        ...SOURCE,
        ...override,
      }),
    ).toBeNull();
  });
});
