import { describe, expect, it } from "vitest";
import {
  candidateWorkspaceFileRefsForRelativeLinkPath,
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

describe("candidateWorkspaceFileRefsForRelativeLinkPath", () => {
  it("builds the direct-file candidate then its index.md fallback per bound root, root-major order", () => {
    const refs = candidateWorkspaceFileRefsForRelativeLinkPath(
      HOST_ID,
      ["/repo-a", "/repo-b"],
      "src/app.ts",
    );

    expect(refs).toHaveLength(4);
    expect(refs?.[0]).toMatchObject({
      workspacePath: "/repo-a",
      filePath: "src/app.ts",
    });
    expect(refs?.[1]).toMatchObject({
      workspacePath: "/repo-a",
      filePath: "src/app.ts/index.md",
    });
    expect(refs?.[2]).toMatchObject({
      workspacePath: "/repo-b",
      filePath: "src/app.ts",
    });
    expect(refs?.[3]).toMatchObject({
      workspacePath: "/repo-b",
      filePath: "src/app.ts/index.md",
    });
  });

  it("resolves a directory-shaped relative path (trailing separator) to its own index.md candidate, not the bare directory", () => {
    const refs = candidateWorkspaceFileRefsForRelativeLinkPath(
      HOST_ID,
      ROOTS,
      "sub-dir/",
    );

    expect(refs).toHaveLength(1);
    expect(refs?.[0]).toMatchObject({
      workspacePath: "/repo",
      filePath: "sub-dir/index.md",
    });
  });

  it("resolves a bare '.' -less trailing directory root href to index.md at the root itself", () => {
    // A bare trailing-slash "current directory" href names the root's own
    // index.md, mirroring how a bare file href resolves against root[0].
    const refs = candidateWorkspaceFileRefsForRelativeLinkPath(
      HOST_ID,
      ROOTS,
      "./",
    );

    expect(refs).toHaveLength(1);
    expect(refs?.[0]).toMatchObject({
      workspacePath: "/repo",
      filePath: "index.md",
    });
  });

  it("resolves a parent-escaping relative path to an absolute, single-file synthesized candidate per root (the host enforces containment per workspacePath)", () => {
    const refs = candidateWorkspaceFileRefsForRelativeLinkPath(
      HOST_ID,
      ROOTS,
      "../sibling/app.ts",
    );

    // The direct file, then its own index.md fallback, both resolved
    // client-side into an absolute path whose OWN directory becomes the
    // synthesized workspacePath - never `{ workspacePath: "/repo", filePath:
    // "../sibling/app.ts" }`, which `workspace.readFile`'s containment guard
    // would always reject.
    expect(refs).toHaveLength(2);
    expect(refs?.[0]).toMatchObject({
      workspacePath: "/sibling",
      filePath: "app.ts",
    });
    expect(refs?.[1]).toMatchObject({
      workspacePath: "/sibling/app.ts",
      filePath: "index.md",
    });
  });

  it("resolves a directory-shaped parent-escaping href to a single absolute index.md candidate", () => {
    const refs = candidateWorkspaceFileRefsForRelativeLinkPath(
      HOST_ID,
      ["/repo/sub"],
      "../sibling/",
    );

    expect(refs).toHaveLength(1);
    expect(refs?.[0]).toMatchObject({
      workspacePath: "/repo/sibling",
      filePath: "index.md",
    });
  });

  it("preserves root order for an escaping href resolved against multiple roots", () => {
    const refs = candidateWorkspaceFileRefsForRelativeLinkPath(
      HOST_ID,
      ["/repo-a", "/repo-a/nested"],
      "../app.ts/",
    );

    // Each root resolves the SAME escaping href to a different absolute
    // target, in ROOT order - root 0's candidate always precedes root 1's,
    // regardless of where either one lands.
    expect(refs).toHaveLength(2);
    expect(refs?.[0]?.workspacePath).toBe("/app.ts");
    expect(refs?.[1]?.workspacePath).toBe("/repo-a/app.ts");
  });

  it("returns null for an absolute path", () => {
    expect(
      candidateWorkspaceFileRefsForRelativeLinkPath(
        HOST_ID,
        ROOTS,
        "/repo/src/app.ts",
      ),
    ).toBeNull();
  });

  it("returns null when no roots are bound", () => {
    expect(
      candidateWorkspaceFileRefsForRelativeLinkPath(HOST_ID, [], "src/app.ts"),
    ).toBeNull();
  });

  it("returns null for a blank path", () => {
    expect(
      candidateWorkspaceFileRefsForRelativeLinkPath(HOST_ID, ROOTS, "   "),
    ).toBeNull();
  });

  it("returns null for a bare '.'", () => {
    expect(
      candidateWorkspaceFileRefsForRelativeLinkPath(HOST_ID, ROOTS, "."),
    ).toBeNull();
  });
});
