import { describe, expect, it } from "vitest";
import {
  orderFoldersPrimaryFirst,
  resolvePrimaryPath,
  trimFoldersPreservingPrimary,
} from "../resolve-primary-path";

describe("resolvePrimaryPath", () => {
  it("returns the stored primary when it is still a member of folders", () => {
    expect(resolvePrimaryPath(["/a", "/b", "/c"], "/b")).toBe("/b");
  });

  it("falls back to the first folder when the stored primary is absent", () => {
    expect(resolvePrimaryPath(["/a", "/b"], "/removed")).toBe("/a");
  });

  it("falls back to the first folder when no primary is stored", () => {
    expect(resolvePrimaryPath(["/a", "/b"], null)).toBe("/a");
  });

  it("resolves a non-git / unresolved folder just like any other member", () => {
    // The resolver operates over the full folder set, not just git
    // summaries - a non-git folder at any position can be primary.
    expect(resolvePrimaryPath(["/non-git", "/git-repo"], "/non-git")).toBe(
      "/non-git",
    );
  });

  it("returns null for an empty folder set", () => {
    expect(resolvePrimaryPath([], "/anything")).toBeNull();
    expect(resolvePrimaryPath([], null)).toBeNull();
  });
});

describe("orderFoldersPrimaryFirst", () => {
  it("moves the resolved primary to the front, preserving the rest's relative order", () => {
    expect(orderFoldersPrimaryFirst(["/a", "/b", "/c"], "/b")).toEqual([
      "/b",
      "/a",
      "/c",
    ]);
  });

  it("is a no-op when the primary is already first", () => {
    expect(orderFoldersPrimaryFirst(["/a", "/b"], "/a")).toEqual(["/a", "/b"]);
  });

  it("returns the folders unchanged when there is no resolvable primary", () => {
    expect(orderFoldersPrimaryFirst([], null)).toEqual([]);
  });
});

describe("trimFoldersPreservingPrimary", () => {
  it("returns the folders unchanged when at or under the cap", () => {
    expect(trimFoldersPreservingPrimary(["/a", "/b"], "/a", 2)).toEqual([
      "/a",
      "/b",
    ]);
  });

  it("evicts the oldest SECONDARY folders first, never the resolved primary", () => {
    const folders = ["/a", "/b", "/c", "/d", "/e"];
    // "/a" is the oldest folder AND the resolved primary - naive front
    // trimming would evict it first; the cap must skip its slot instead.
    expect(trimFoldersPreservingPrimary(folders, "/a", 3)).toEqual([
      "/a",
      "/d",
      "/e",
    ]);
  });

  it("preserves an explicit primary that isn't the oldest folder", () => {
    const folders = ["/a", "/b", "/c", "/d", "/e"];
    expect(trimFoldersPreservingPrimary(folders, "/c", 3)).toEqual([
      "/c",
      "/d",
      "/e",
    ]);
  });

  it("with no stored primary, still preserves the implicit folders[0] primary over a newer secondary", () => {
    // A null `primaryPath` resolves to `folders[0]` - the SAME fallback used
    // everywhere else - so eviction must still spare that slot rather than
    // reverting to naive front-trimming.
    expect(trimFoldersPreservingPrimary(["/a", "/b", "/c"], null, 2)).toEqual([
      "/a",
      "/c",
    ]);
  });
});
