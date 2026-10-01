import { describe, expect, it } from "vitest";
import {
  lexicalWorktreePathKey,
  rowsByRequestedPath,
  worktreePathMatcher,
} from "@/lib/worktree/worktree-path-match";

describe("lexicalWorktreePathKey", () => {
  it("drops a trailing separator", () => {
    expect(lexicalWorktreePathKey("/wt/app/")).toBe("/wt/app");
  });

  it("collapses repeated separators", () => {
    expect(lexicalWorktreePathKey("/wt//app")).toBe("/wt/app");
  });

  it("drops `.` segments and resolves `..` segments", () => {
    expect(lexicalWorktreePathKey("/wt/./app")).toBe("/wt/app");
    expect(lexicalWorktreePathKey("/wt/../app")).toBe("/app");
  });

  it("resolves a leading `..` past the root to the root itself", () => {
    expect(lexicalWorktreePathKey("/..")).toBe("/");
  });

  it("keys the root path as itself", () => {
    expect(lexicalWorktreePathKey("/")).toBe("/");
  });

  it("normalizes a drive-letter path's mixed separators to backslash", () => {
    expect(lexicalWorktreePathKey("C:/a\\b/")).toBe("C:\\a\\b");
  });

  it("keys a bare drive root", () => {
    expect(lexicalWorktreePathKey("C:\\")).toBe("C:\\");
  });

  it("returns null for a relative path - it resolves against the host's own cwd", () => {
    expect(lexicalWorktreePathKey("wt/app")).toBeNull();
  });

  it("returns null for a UNC path - it has its own root rules", () => {
    expect(lexicalWorktreePathKey("\\\\server\\share")).toBeNull();
  });
});

describe("worktreePathMatcher", () => {
  it("matches a byte-exact candidate", () => {
    const isMatch = worktreePathMatcher(new Set(["/wt/app"]));
    expect(isMatch("/wt/app")).toBe(true);
  });

  it("matches a candidate that is lexically equal but not byte-equal", () => {
    const isMatch = worktreePathMatcher(new Set(["/wt/app/"]));
    expect(isMatch("/wt/app")).toBe(true);
  });

  it("does not match an unrelated path", () => {
    const isMatch = worktreePathMatcher(new Set(["/wt/app"]));
    expect(isMatch("/wt/other")).toBe(false);
  });

  it("matches a relative candidate only exactly - it has no lexical key to fall back on", () => {
    const isMatch = worktreePathMatcher(new Set(["wt/app"]));
    expect(isMatch("wt/app")).toBe(true);
    expect(isMatch("./wt/app")).toBe(false);
  });
});

interface Row {
  readonly worktreePath: string;
}

function row(worktreePath: string): Row {
  return { worktreePath };
}

describe("rowsByRequestedPath", () => {
  it("prefers the exact row over a lexically-equal one when both exist", () => {
    const exactRow = row("/wt/app");
    const lexicalOnlyRow = row(
      "/wt/app/other-spelling-that-never-really-happens",
    );
    const byRequested = rowsByRequestedPath(
      ["/wt/app"],
      [exactRow, lexicalOnlyRow],
    );
    expect(byRequested.get("/wt/app")).toEqual([exactRow]);
  });

  it("falls back to the lexical match when no exact row exists", () => {
    const hostRow = row("/wt/app");
    const byRequested = rowsByRequestedPath(["/wt/app/"], [hostRow]);
    expect(byRequested.get("/wt/app/")).toEqual([hostRow]);
  });

  it("resolves an absent path to an empty listing", () => {
    const byRequested = rowsByRequestedPath(["/wt/missing"], [row("/wt/app")]);
    expect(byRequested.get("/wt/missing")).toEqual([]);
  });

  it("resolves two requested spellings of the same worktree to its one row", () => {
    const hostRow = row("/wt/app");
    const byRequested = rowsByRequestedPath(["/wt/app", "/wt/app/"], [hostRow]);
    expect(byRequested.get("/wt/app")).toEqual([hostRow]);
    expect(byRequested.get("/wt/app/")).toEqual([hostRow]);
  });

  it("resolves a relative request with no exact row to an empty listing - it has no lexical key to fall back on", () => {
    const byRequested = rowsByRequestedPath(["wt/app"], [row("/wt/app")]);
    expect(byRequested.get("wt/app")).toEqual([]);
  });
});
