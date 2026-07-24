import { describe, expect, it } from "vitest";
import type { WorkspaceSearchPathResult } from "@traycer/protocol/host/workspace/unary-schemas";
import {
  fileSuggestionFromSearchResult,
  folderSuggestionFromSearchResult,
  joinWithinRoot,
} from "../search-path-suggestions";

function fileResult(relPath: string, name: string): WorkspaceSearchPathResult {
  return { kind: "file", relPath, name };
}
function folderResult(
  relPath: string,
  name: string,
): WorkspaceSearchPathResult {
  return { kind: "folder", relPath, name };
}

describe("search-path suggestion reconstruction", () => {
  it("rebuilds a file suggestion matching the legacy shape", () => {
    const suggestion = fileSuggestionFromSearchResult(
      "/repo",
      fileResult("src/app.ts", "app.ts"),
    );
    expect(suggestion).toEqual({
      kind: "file",
      id: "file:/repo:src/app.ts",
      label: "app.ts",
      relPath: "src/app.ts",
      absolutePath: "/repo/src/app.ts",
      workspacePath: "/repo",
      description: "src",
    });
  });

  it("gives a root-level file an empty description", () => {
    const suggestion = fileSuggestionFromSearchResult(
      "/repo",
      fileResult("README.md", "README.md"),
    );
    expect(suggestion.description).toBe("");
    expect(suggestion.absolutePath).toBe("/repo/README.md");
  });

  it("rebuilds a folder suggestion with a trailing-slash relPath", () => {
    const suggestion = folderSuggestionFromSearchResult(
      "/repo",
      folderResult("src/lib", "lib"),
    );
    expect(suggestion).toEqual({
      kind: "folder",
      id: "folder:/repo:src/lib/",
      label: "lib",
      relPath: "src/lib/",
      absolutePath: "/repo/src/lib",
      workspacePath: "/repo",
      description: "src",
    });
  });

  it("joins onto a Windows root using the root's separator", () => {
    expect(joinWithinRoot("C:\\Users\\me\\repo", "src/app.ts")).toBe(
      "C:\\Users\\me\\repo\\src\\app.ts",
    );
    const suggestion = fileSuggestionFromSearchResult(
      "C:\\Users\\me\\repo",
      fileResult("src/app.ts", "app.ts"),
    );
    expect(suggestion.absolutePath).toBe("C:\\Users\\me\\repo\\src\\app.ts");
    // relPath stays host-canonical POSIX for the mention token.
    expect(suggestion.relPath).toBe("src/app.ts");
  });

  it("stays within the root when a malformed relPath contains traversal", () => {
    // The host jails relPath; this only proves the client never escapes even on
    // a malformed payload.
    expect(joinWithinRoot("/repo", "../../etc/passwd")).toBe("/repo/etc/passwd");
    expect(joinWithinRoot("/repo", "/leading/slash")).toBe(
      "/repo/leading/slash",
    );
  });
});
