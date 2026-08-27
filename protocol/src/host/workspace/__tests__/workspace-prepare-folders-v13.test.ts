import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "../../registry";
import {
  workspacePrepareFoldersRequestSchemaV13,
  workspacePrepareFoldersRequestSchemaV14,
} from "../unary-schemas";

describe("workspace.prepareFolders v1.3", () => {
  it("registers and accepts the create-and-prepare operation", () => {
    const entry = hostRpcRegistry["workspace.prepareFolders"][1];
    expect(entry.latestMinor).toBe(4);
    expect(
      workspacePrepareFoldersRequestSchemaV13.parse({
        operation: "createAndPrepare",
        folderPaths: null,
        path: "/srv/new-workspace",
        bumpRecency: null,
      }),
    ).toEqual({
      operation: "createAndPrepare",
      folderPaths: null,
      path: "/srv/new-workspace",
      bumpRecency: null,
    });
  });

  it("v1.4 opts prepare into one host-side recents write", () => {
    expect(
      workspacePrepareFoldersRequestSchemaV14.parse({
        operation: "prepare",
        folderPaths: ["/srv/one", "/srv/two"],
        path: null,
        bumpRecency: true,
      }),
    ).toEqual({
      operation: "prepare",
      folderPaths: ["/srv/one", "/srv/two"],
      path: null,
      bumpRecency: true,
    });
  });

  it("rejects create-and-prepare without a path", () => {
    expect(
      workspacePrepareFoldersRequestSchemaV13.safeParse({
        operation: "createAndPrepare",
        folderPaths: null,
        path: null,
        bumpRecency: null,
      }).success,
    ).toBe(false);
  });

  it.each(["projects/new-workspace", "~/new-workspace"])(
    "rejects a relative create-and-prepare path %j",
    (path) => {
      expect(
        workspacePrepareFoldersRequestSchemaV13.safeParse({
          operation: "createAndPrepare",
          folderPaths: null,
          path,
          bumpRecency: null,
        }).success,
      ).toBe(false);
    },
  );

  it("keeps nullable paths for non-creation operations", () => {
    expect(
      workspacePrepareFoldersRequestSchemaV13.parse({
        operation: "prepare",
        folderPaths: ["relative/path"],
        path: null,
        bumpRecency: null,
      }).path,
    ).toBeNull();
  });
});
