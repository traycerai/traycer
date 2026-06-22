import { describe, expect, it } from "vitest";
import {
  workspaceFileRefFromAbsoluteFilePath,
  workspaceFileRefFromLinkPath,
} from "@/components/epic-canvas/workspace-file/workspace-file-link-ref";
import { workspaceFileTabId } from "@/components/epic-canvas/workspace-file/workspace-file-ref";

const HOST_ID = "host-1";
const ROOTS = ["/repo"] as const;

describe("workspaceFileRefFromLinkPath", () => {
  it("resolves an absolute path inside a bound root to that root plus relative path", () => {
    const ref = workspaceFileRefFromLinkPath(
      HOST_ID,
      ROOTS,
      "/repo/src/app.ts",
    );

    expect(ref).not.toBeNull();
    expect(ref?.id).toBe(workspaceFileTabId(HOST_ID, "/repo", "src/app.ts"));
    expect(ref?.workspacePath).toBe("/repo");
    expect(ref?.filePath).toBe("src/app.ts");
  });

  it("returns null for an absolute path outside every bound root (no synthesized workspace)", () => {
    expect(
      workspaceFileRefFromLinkPath(HOST_ID, ROOTS, "/etc/passwd"),
    ).toBeNull();
  });

  it("binds an absolute path to the most specific (longest) matching root when roots overlap", () => {
    // Parent root listed first: first-match would bind to `/repo` with relative
    // `sub/app.ts`; the longest-prefix rule binds to `/repo/sub` + `app.ts`.
    const ref = workspaceFileRefFromLinkPath(
      HOST_ID,
      ["/repo", "/repo/sub"],
      "/repo/sub/app.ts",
    );

    expect(ref?.workspacePath).toBe("/repo/sub");
    expect(ref?.filePath).toBe("app.ts");
    expect(ref?.id).toBe(workspaceFileTabId(HOST_ID, "/repo/sub", "app.ts"));
  });

  it("picks the longest matching root regardless of root order", () => {
    const ref = workspaceFileRefFromLinkPath(
      HOST_ID,
      ["/repo/sub", "/repo"],
      "/repo/sub/app.ts",
    );

    expect(ref?.workspacePath).toBe("/repo/sub");
    expect(ref?.filePath).toBe("app.ts");
  });

  it("returns null when an absolute path is itself a bound root (a directory, not a file)", () => {
    expect(
      workspaceFileRefFromLinkPath(
        HOST_ID,
        ["/repo", "/repo/sub"],
        "/repo/sub",
      ),
    ).toBeNull();
  });

  it("resolves a relative path against the primary root", () => {
    const ref = workspaceFileRefFromLinkPath(HOST_ID, ROOTS, "src/app.ts");

    expect(ref?.id).toBe(workspaceFileTabId(HOST_ID, "/repo", "src/app.ts"));
    expect(ref?.workspacePath).toBe("/repo");
    expect(ref?.filePath).toBe("src/app.ts");
  });

  it("normalizes a non-canonical relative path so it keys the canonical tab", () => {
    const ref = workspaceFileRefFromLinkPath(
      HOST_ID,
      ROOTS,
      "./src/../src/app.ts",
    );

    expect(ref?.filePath).toBe("src/app.ts");
    expect(ref?.id).toBe(workspaceFileTabId(HOST_ID, "/repo", "src/app.ts"));
  });

  it("returns null for a parent-escaping relative path", () => {
    expect(
      workspaceFileRefFromLinkPath(HOST_ID, ROOTS, "../outside.ts"),
    ).toBeNull();
  });

  it("returns null for a relative directory ref (trailing separator)", () => {
    expect(workspaceFileRefFromLinkPath(HOST_ID, ROOTS, "src/")).toBeNull();
  });

  it("returns null for a relative path when no roots are bound", () => {
    expect(workspaceFileRefFromLinkPath(HOST_ID, [], "src/app.ts")).toBeNull();
  });
});

describe("workspaceFileRefFromAbsoluteFilePath", () => {
  it("synthesizes a root from an out-of-root absolute file's own directory", () => {
    const path = "/Users/me/.traycer/.codex/skills/traycer-review/SKILL.md";
    const dir = "/Users/me/.traycer/.codex/skills/traycer-review";
    const ref = workspaceFileRefFromAbsoluteFilePath(HOST_ID, path);

    expect(ref).not.toBeNull();
    expect(ref?.id).toBe(workspaceFileTabId(HOST_ID, dir, "SKILL.md"));
    expect(ref?.workspacePath).toBe(dir);
    expect(ref?.filePath).toBe("SKILL.md");
    expect(ref?.name).toBe("SKILL.md");
  });

  it("returns null for a relative path", () => {
    expect(
      workspaceFileRefFromAbsoluteFilePath(HOST_ID, "src/app.ts"),
    ).toBeNull();
  });

  it("returns null for a blank path", () => {
    expect(workspaceFileRefFromAbsoluteFilePath(HOST_ID, "   ")).toBeNull();
  });
});
