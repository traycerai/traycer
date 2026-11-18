import { describe, expect, it } from "vitest";
import { projectWorkspaceFolderForHost } from "@/hooks/workspace/use-resolved-workspace-folders-query";
import type { WorkspaceFolderInfo } from "@/stores/workspace/workspace-folders-store";

const EMPTY = new Map<string, ReadonlySet<string>>();

function localFolder(path: string, hostId: string | null): WorkspaceFolderInfo {
  return {
    path,
    name: path.split("/").pop() ?? path,
    repoIdentifier: null,
    hostId,
  };
}

describe("projectWorkspaceFolderForHost (B6 local-only)", () => {
  it("keeps a non-git folder only on the host that stamped it", () => {
    const folder = localFolder("/Users/a/scratch", "host-A");
    expect(projectWorkspaceFolderForHost(folder, EMPTY, "host-A").kind).toBe(
      "local-only",
    );
    expect(projectWorkspaceFolderForHost(folder, EMPTY, "host-B").kind).toBe(
      "unresolved",
    );
  });

  it("treats legacy unstamped local folders as unresolved on multi-host", () => {
    const legacy = localFolder("/Users/a/scratch", null);
    expect(projectWorkspaceFolderForHost(legacy, EMPTY, "host-A").kind).toBe(
      "unresolved",
    );
  });
});
