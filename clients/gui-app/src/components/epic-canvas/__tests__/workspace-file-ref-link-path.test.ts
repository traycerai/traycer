/**
 * Resolution of chat markdown file-link paths into `WorkspaceFileRef`s.
 *
 * The markdown anchor hands `workspaceFileRefFromLinkPath` whatever the model
 * emitted; it must resolve that against the chat's working directories so the
 * link opens the right in-app workspace file tab, and decline (return null)
 * when it can't tell which workspace a path belongs to.
 */
import { describe, expect, it } from "vitest";
import {
  workspaceFileRefFromLinkPath,
  workspaceFileRefFromWorkspaceMarkdownLink,
} from "@/components/epic-canvas/workspace-file/workspace-file-link-ref";
import { workspaceFileTabId } from "@/components/epic-canvas/workspace-file/workspace-file-ref";
import { WORKSPACE_FILE_TAB_KIND } from "@/stores/epics/canvas/types";

const HOST = "host-1";

describe("workspaceFileRefFromLinkPath", () => {
  it("resolves a relative path against the primary root", () => {
    const ref = workspaceFileRefFromLinkPath(
      HOST,
      ["/repo", "/other"],
      "src/app.ts",
    );
    expect(ref).toMatchObject({
      id: workspaceFileTabId(HOST, "/repo", "src/app.ts"),
      type: WORKSPACE_FILE_TAB_KIND,
      name: "app.ts",
      hostId: HOST,
      workspacePath: "/repo",
      filePath: "src/app.ts",
    });
    expect(ref?.instanceId).toEqual(expect.any(String));
  });

  it("resolves an absolute path under a root to a path relative to that root", () => {
    const ref = workspaceFileRefFromLinkPath(
      HOST,
      ["/repo", "/srv/site"],
      "/srv/site/pkg/index.ts",
    );
    expect(ref?.workspacePath).toBe("/srv/site");
    expect(ref?.filePath).toBe("pkg/index.ts");
    expect(ref?.name).toBe("index.ts");
  });

  it("handles Windows drive paths under a root", () => {
    const ref = workspaceFileRefFromLinkPath(
      HOST,
      ["C:\\work\\repo"],
      "C:\\work\\repo\\src\\main.ts",
    );
    expect(ref?.workspacePath).toBe("C:\\work\\repo");
    expect(ref?.filePath).toBe("src/main.ts");
    expect(ref?.name).toBe("main.ts");
  });

  it("matches Windows roots when the link uses forward slashes", () => {
    const ref = workspaceFileRefFromLinkPath(
      HOST,
      ["C:\\work\\repo"],
      "C:/work/repo/src/main.ts",
    );
    expect(ref?.workspacePath).toBe("C:\\work\\repo");
    expect(ref?.filePath).toBe("src/main.ts");
    expect(ref?.name).toBe("main.ts");
  });

  it("matches Windows roots case-insensitively", () => {
    const ref = workspaceFileRefFromLinkPath(
      HOST,
      ["C:\\Work\\Repo"],
      "c:/work/repo/src/main.ts",
    );
    expect(ref?.workspacePath).toBe("C:\\Work\\Repo");
    expect(ref?.filePath).toBe("src/main.ts");
    expect(ref?.name).toBe("main.ts");
  });

  it("does not fold POSIX root casing", () => {
    // POSIX paths are case-sensitive, so a link differing only in case from the
    // root is NOT under it; with no out-of-root synthesis (CL-1) it declines.
    // (If casing were folded it would resolve under "/Users/me/Repo" instead.)
    const ref = workspaceFileRefFromLinkPath(
      HOST,
      ["/Users/me/Repo"],
      "/users/me/repo/src/main.ts",
    );
    expect(ref).toBeNull();
  });

  it("returns null for an absolute path outside every root", () => {
    // CL-1: an absolute path no bound root contains is declined, not modelled
    // as a synthesized { dirname, basename } workspace (which would let the
    // renderer read arbitrary out-of-root files).
    expect(
      workspaceFileRefFromLinkPath(HOST, ["/repo"], "/etc/hosts"),
    ).toBeNull();
  });

  it("returns null for an absolute path when no roots are bound", () => {
    expect(
      workspaceFileRefFromLinkPath(HOST, [], "/Users/me/proj/src/app.ts"),
    ).toBeNull();
  });

  it("returns null for a relative path when there are no roots", () => {
    expect(workspaceFileRefFromLinkPath(HOST, [], "src/app.ts")).toBeNull();
  });

  it("returns null for an empty path", () => {
    expect(workspaceFileRefFromLinkPath(HOST, ["/repo"], "  ")).toBeNull();
  });

  it("returns null when an absolute path equals a root (no file part)", () => {
    expect(workspaceFileRefFromLinkPath(HOST, ["/repo"], "/repo")).toBeNull();
  });
});

describe("workspaceFileRefFromWorkspaceMarkdownLink", () => {
  it("resolves relative links beside the current markdown file", () => {
    const ref = workspaceFileRefFromWorkspaceMarkdownLink(
      HOST,
      "/repo",
      "docs/guides/setup.md",
      "../src/app.ts",
    );

    expect(ref?.workspacePath).toBe("/repo");
    expect(ref?.filePath).toBe("docs/src/app.ts");
    expect(ref?.name).toBe("app.ts");
  });

  it("rejects relative links that escape the workspace root", () => {
    expect(
      workspaceFileRefFromWorkspaceMarkdownLink(
        HOST,
        "/repo",
        "README.md",
        "../outside.md",
      ),
    ).toBeNull();
  });
});
