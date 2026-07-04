import { describe, expect, it } from "vitest";

import { mentionPathTree } from "../path";

describe("mentionPathTree", () => {
  it("collapses a deep path to a 4-row tree: root prefix + 2 mid dirs + leaf", () => {
    expect(
      mentionPathTree(
        "trayer/clients/gui-app/src/components/home/toolbar/composer-toolbar.tsx",
        true,
      ),
    ).toEqual({
      rootLabel: "trayer/clients/gui-app/src/components",
      midDirs: ["home", "toolbar"],
      leaf: "composer-toolbar.tsx",
      leafIsFile: true,
    });
  });

  it("renders a shallow path as root + 1 mid dir + leaf", () => {
    expect(mentionPathTree("authn-v3/src/sentry.ts", true)).toEqual({
      rootLabel: "authn-v3",
      midDirs: ["src"],
      leaf: "sentry.ts",
      leafIsFile: true,
    });
  });

  it("renders a root-level file with no dir rows", () => {
    expect(mentionPathTree(".gitattributes", true)).toEqual({
      rootLabel: "",
      midDirs: [],
      leaf: ".gitattributes",
      leafIsFile: true,
    });
  });

  it("marks a folder leaf as leafIsFile: false", () => {
    // Folder relPaths carry a trailing slash from the host.
    expect(mentionPathTree("src/auth/", false)).toEqual({
      rootLabel: "src",
      midDirs: [],
      leaf: "auth",
      leafIsFile: false,
    });
  });

  it("never exceeds 2 mid dirs regardless of path depth", () => {
    const tree = mentionPathTree("a/b/c/d/e/f/g/h/deep-file.ts", true);
    expect(tree.midDirs.length).toBeLessThanOrEqual(2);
    expect(tree).toEqual({
      rootLabel: "a/b/c/d/e/f",
      midDirs: ["g", "h"],
      leaf: "deep-file.ts",
      leafIsFile: true,
    });
  });

  it("preserves the leading slash on an absolute worktree path", () => {
    expect(
      mentionPathTree("/home/u/.traycer/worktrees/o/r/feature", false),
    ).toEqual({
      rootLabel: "/home/u/.traycer/worktrees",
      midDirs: ["o", "r"],
      leaf: "feature",
      leafIsFile: false,
    });
  });

  it("handles a shallow absolute path with no mid dirs", () => {
    expect(mentionPathTree("/repo/feature-branch", false)).toEqual({
      rootLabel: "/repo",
      midDirs: [],
      leaf: "feature-branch",
      leafIsFile: false,
    });
  });

  it("preserves the absolute marker on the leaf for a single-segment absolute path", () => {
    // Regression: with no directory rows, rootLabel is "" and previously
    // nothing carried the leading "/" - a worktree mounted at "/repo" would
    // render identically to a relative dir named "repo". The leaf now
    // carries the marker instead.
    expect(mentionPathTree("/repo", false)).toEqual({
      rootLabel: "",
      midDirs: [],
      leaf: "/repo",
      leafIsFile: false,
    });
  });
});
