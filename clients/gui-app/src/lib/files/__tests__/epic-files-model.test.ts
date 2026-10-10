import { describe, expect, it } from "vitest";
import type { EpicFileLocalState } from "@traycer/protocol/host/epic/files";
import {
  buildEpicFilesGroups,
  epicFileDownloadsOnOpen,
  epicFileVersionChain,
} from "@/lib/files/epic-files-model";
import { fileRecord } from "./epic-file-record-fixture";

const PAGE_V1 = "files/pages/report.html";
const PAGE_V2 = "files/pages/report-2.html";
const PAGE_V3 = "files/pages/report-3.html";

describe("buildEpicFilesGroups", () => {
  it("orders the groups Pages, MCP apps, folders alphabetically, then the root", () => {
    const groups = buildEpicFilesGroups([
      fileRecord({ path: "files/notes.txt" }),
      fileRecord({ path: "files/zeta/a.png" }),
      fileRecord({ path: "files/mcp-apps/chart.html" }),
      fileRecord({ path: "files/alpha/b.png" }),
      fileRecord({ path: PAGE_V1 }),
    ]);

    expect(groups.map((group) => [group.kind, group.label])).toEqual([
      ["pages", "Pages"],
      ["mcp-apps", "MCP apps"],
      ["folder", "alpha"],
      ["folder", "zeta"],
      ["root", "Other files"],
    ]);
  });

  it("lists a group's files newest first", () => {
    const [group] = buildEpicFilesGroups([
      fileRecord({ path: "files/old.txt", createdAt: 1000 }),
      fileRecord({ path: "files/new.txt", createdAt: 3000 }),
      fileRecord({ path: "files/mid.txt", createdAt: 2000 }),
    ]);

    expect(group.items.map((item) => item.name)).toEqual([
      "new.txt",
      "mid.txt",
      "old.txt",
    ]);
  });

  it("hides a tombstoned file, and a group left empty by it", () => {
    const groups = buildEpicFilesGroups([
      fileRecord({ path: PAGE_V1, deletedAt: 5000 }),
      fileRecord({ path: "files/kept.txt" }),
    ]);

    expect(groups.map((group) => group.kind)).toEqual(["root"]);
  });

  it("folds a replaced page under the page that replaced it, oldest last", () => {
    const [pages] = buildEpicFilesGroups([
      fileRecord({ path: PAGE_V1, createdAt: 1000 }),
      fileRecord({ path: PAGE_V2, createdAt: 2000, replaces: PAGE_V1 }),
      fileRecord({ path: PAGE_V3, createdAt: 3000, replaces: PAGE_V2 }),
    ]);

    expect(pages.items.map((item) => item.path)).toEqual([PAGE_V3]);
    expect(pages.items[0].earlier.map((item) => item.path)).toEqual([
      PAGE_V2,
      PAGE_V1,
    ]);
    // Numbered as the version nav counts them; the row itself has none.
    expect(pages.items[0].earlier.map((item) => item.version)).toEqual([2, 1]);
    expect(pages.items[0].version).toBeNull();
  });

  it("shows a page as its own row when the file that replaced it is deleted", () => {
    const [pages] = buildEpicFilesGroups([
      fileRecord({ path: PAGE_V1, createdAt: 1000 }),
      fileRecord({
        path: PAGE_V2,
        createdAt: 2000,
        replaces: PAGE_V1,
        deletedAt: 5000,
      }),
    ]);

    expect(pages.items.map((item) => item.path)).toEqual([PAGE_V1]);
    expect(pages.items[0].earlier).toEqual([]);
  });

  it("leaves a deleted earlier version out of the chain", () => {
    const [pages] = buildEpicFilesGroups([
      fileRecord({ path: PAGE_V1, createdAt: 1000, deletedAt: 5000 }),
      fileRecord({ path: PAGE_V2, createdAt: 2000, replaces: PAGE_V1 }),
    ]);

    expect(pages.items[0].path).toBe(PAGE_V2);
    expect(pages.items[0].earlier).toEqual([]);
  });

  it("terminates on records that replace each other", () => {
    const groups = buildEpicFilesGroups([
      fileRecord({ path: PAGE_V1, replaces: PAGE_V2 }),
      fileRecord({ path: PAGE_V2, replaces: PAGE_V1 }),
      fileRecord({ path: "files/kept.txt" }),
    ]);

    expect(groups.map((group) => group.kind)).toEqual(["root"]);
  });
});

describe("epicFileVersionChain", () => {
  const records = [
    fileRecord({ path: PAGE_V1, createdAt: 1000 }),
    fileRecord({ path: PAGE_V2, createdAt: 2000, replaces: PAGE_V1 }),
    fileRecord({ path: PAGE_V3, createdAt: 3000, replaces: PAGE_V2 }),
    fileRecord({ path: "files/other.txt" }),
  ];

  function paths(path: string): readonly string[] {
    return epicFileVersionChain(records, path).map((record) => record.path);
  }

  it("is the same oldest-first chain from any version in it", () => {
    const whole = [PAGE_V1, PAGE_V2, PAGE_V3];
    expect(paths(PAGE_V1)).toEqual(whole);
    expect(paths(PAGE_V2)).toEqual(whole);
    expect(paths(PAGE_V3)).toEqual(whole);
  });

  it("is just the file when nothing replaced it and it replaced nothing", () => {
    expect(paths("files/other.txt")).toEqual(["files/other.txt"]);
  });

  it("is empty for a path no record has", () => {
    expect(paths("files/pages/missing.html")).toEqual([]);
  });

  it("follows the newest when two files replaced the same parent", () => {
    const branched = [
      fileRecord({ path: PAGE_V1, createdAt: 1000 }),
      fileRecord({ path: PAGE_V2, createdAt: 2000, replaces: PAGE_V1 }),
      fileRecord({ path: PAGE_V3, createdAt: 3000, replaces: PAGE_V1 }),
    ];

    expect(
      epicFileVersionChain(branched, PAGE_V1).map((record) => record.path),
    ).toEqual([PAGE_V1, PAGE_V3]);
  });

  it("keeps a deleted version in the chain", () => {
    const withDeleted = [
      fileRecord({ path: PAGE_V1, createdAt: 1000 }),
      fileRecord({
        path: PAGE_V2,
        createdAt: 2000,
        replaces: PAGE_V1,
        deletedAt: 5000,
      }),
      fileRecord({ path: PAGE_V3, createdAt: 3000, replaces: PAGE_V2 }),
    ];

    expect(
      epicFileVersionChain(withDeleted, PAGE_V3).map((record) => record.path),
    ).toEqual([PAGE_V1, PAGE_V2, PAGE_V3]);
  });

  it("visits each record once when records replace each other", () => {
    const cyclic = [
      fileRecord({ path: PAGE_V1, createdAt: 1000, replaces: PAGE_V2 }),
      fileRecord({ path: PAGE_V2, createdAt: 2000, replaces: PAGE_V1 }),
    ];

    expect(
      epicFileVersionChain(cyclic, PAGE_V1).map((record) => record.path),
    ).toEqual([PAGE_V2, PAGE_V1]);
  });
});

describe("epicFileDownloadsOnOpen", () => {
  it("is true only for a file this host does not hold and is not fetching", () => {
    const stateOf = (localState: EpicFileLocalState): boolean =>
      epicFileDownloadsOnOpen(
        fileRecord({ path: "files/big.mov", localState }),
      );

    expect(stateOf({ kind: "absent" })).toBe(true);
    expect(stateOf({ kind: "present" })).toBe(false);
    expect(stateOf({ kind: "downloading", received: 1, total: 10 })).toBe(
      false,
    );
  });
});
