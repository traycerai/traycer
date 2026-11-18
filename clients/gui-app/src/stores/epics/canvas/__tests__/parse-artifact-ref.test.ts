import { describe, expect, it } from "vitest";
import { parseArtifactRef } from "@/stores/epics/canvas/store";

describe("parseArtifactRef", () => {
  it("parses a workspace-file ref", () => {
    expect(
      parseArtifactRef({
        id: "workspace-file:d:/ws:src/a.ts",
        instanceId: "inst-a",
        type: "workspace-file",
        name: "a.ts",
        hostId: "host-A",
        workspacePath: "/ws",
        filePath: "src/a.ts",
      }),
    ).toEqual({
      id: "workspace-file:d:/ws:src/a.ts",
      instanceId: "inst-a",
      type: "workspace-file",
      name: "a.ts",
      hostId: "host-A",
      workspacePath: "/ws",
      filePath: "src/a.ts",
    });
  });

  it("rejects a workspace-file ref with an empty workspacePath", () => {
    expect(
      parseArtifactRef({
        id: "x",
        type: "workspace-file",
        name: "a.ts",
        hostId: "host-A",
        workspacePath: "",
        filePath: "src/a.ts",
      }),
    ).toBeNull();
  });

  it("rejects a workspace-file ref with an empty filePath", () => {
    expect(
      parseArtifactRef({
        id: "x",
        type: "workspace-file",
        name: "a.ts",
        hostId: "host-A",
        workspacePath: "/ws",
        filePath: "",
      }),
    ).toBeNull();
  });

  it("rejects a ref missing hostId", () => {
    expect(parseArtifactRef({ id: "x", type: "chat", name: "c" })).toBeNull();
  });
});
