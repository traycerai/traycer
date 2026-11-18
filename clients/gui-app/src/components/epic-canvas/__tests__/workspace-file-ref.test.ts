import { describe, expect, it } from "vitest";
import {
  workspaceFileRefFromTreePath,
  workspaceFileTabId,
} from "@/components/epic-canvas/workspace-file/workspace-file-ref";

describe("workspace-file-ref", () => {
  it("builds a host-scoped tab id", () => {
    expect(workspaceFileTabId("host-A", "/work/repo", "src/index.ts")).toBe(
      "workspace-file:host-A:%2Fwork%2Frepo:src%2Findex.ts",
    );
  });

  it("builds a WorkspaceFileRef using the tree path verbatim", () => {
    // Fresh per-tab instanceId is minted on construction; objectContaining
    // ignores it while asserting the stable constructed fields.
    expect(
      workspaceFileRefFromTreePath(
        "host-A",
        "/work/repo",
        "src/components/App.tsx",
        "App.tsx",
      ),
    ).toEqual(
      expect.objectContaining({
        id: workspaceFileTabId(
          "host-A",
          "/work/repo",
          "src/components/App.tsx",
        ),
        type: "workspace-file",
        name: "App.tsx",
        hostId: "host-A",
        workspacePath: "/work/repo",
        filePath: "src/components/App.tsx",
      }),
    );
  });

  it("does not normalize or re-canonicalize the host path", () => {
    // Whitespace / casing in the host-canonical path is preserved as-is;
    // the renderer never re-parses paths.
    const ref = workspaceFileRefFromTreePath(
      "d",
      "/ws",
      "src/ odd name .ts",
      " odd name .ts",
    );
    expect(ref?.filePath).toBe("src/ odd name .ts");
  });

  it("returns null for an empty tree path", () => {
    expect(workspaceFileRefFromTreePath("d", "/ws", "", "")).toBeNull();
  });
});
