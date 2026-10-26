import { Children, isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { SandboxVerbGesture } from "@traycer/protocol/host/sandbox-control";
import { renderTile } from "@/components/epic-canvas/renderers/tile-render";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

const BASE_NODE = {
  id: "node-1",
  instanceId: "instance-1",
  name: "Node",
  hostId: "host-sbx",
};

/** The gesture the tile's open wake is mounted with. */
function wakeGestureOf(node: EpicCanvasTileRef): SandboxVerbGesture | null {
  const tree: ReactNode = renderTile({
    node,
    viewTabId: "tab-1",
    tileId: "tile-1",
    epicId: "epic-1",
    isActive: true,
  });
  if (!isValidElement<{ children: ReactNode }>(tree)) {
    throw new Error("renderTile did not return an element");
  }
  for (const child of Children.toArray(tree.props.children)) {
    if (
      isValidElement<{ gesture: SandboxVerbGesture | null; hostId: string }>(
        child,
      ) &&
      "gesture" in child.props
    ) {
      expect(child.props.hostId).toBe("host-sbx");
      return child.props.gesture;
    }
  }
  throw new Error("no wake element under the tile's host provider");
}

describe("the tile-open wake's gesture", () => {
  it("is Open terminal for a terminal tile", () => {
    expect(
      wakeGestureOf({
        ...BASE_NODE,
        type: "terminal",
        titleSource: "default",
        cwd: "/tmp",
      }),
    ).toBe("open-terminal");
  });

  it("is Open files for a workspace file tile", () => {
    expect(
      wakeGestureOf({
        ...BASE_NODE,
        type: "workspace-file",
        workspacePath: "/repo",
        filePath: "src/a.ts",
      }),
    ).toBe("open-files");
  });

  it("is none for a chat tile", () => {
    expect(wakeGestureOf({ ...BASE_NODE, type: "chat" })).toBeNull();
  });
});
