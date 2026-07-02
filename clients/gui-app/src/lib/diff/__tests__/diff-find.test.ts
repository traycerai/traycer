import { describe, expect, it } from "vitest";
import {
  buildDiffFindIndexFromPatch,
  findDiffMatches,
  type DiffFindMatch,
} from "@/lib/diff/diff-find";

const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,4 +1,4 @@ function greet",
  " const keep = true;",
  "-const label = 'OldName';",
  "+const label = 'NewName';",
  " export const value = label;",
  "",
].join("\n");

function buildIndex() {
  return buildDiffFindIndexFromPatch({
    patch: PATCH,
    cacheKey: "diff-find-test",
    unitScopeId: null,
    metadataUnits: [
      {
        id: "header:src/app.ts",
        filePath: "src/app.ts",
        scopeId: null,
        text: "app.ts src staged header",
      },
    ],
  });
}

function onlyMatch(matches: ReadonlyArray<DiffFindMatch>): DiffFindMatch {
  expect(matches).toHaveLength(1);
  const match = matches.at(0);
  if (match === undefined) {
    throw new Error("expected one match");
  }
  return match;
}

describe("diff find index", () => {
  it("normalizes file metadata, hunk metadata, and row-level diff units", () => {
    const index = buildIndex();

    const fileMatch = onlyMatch(
      findDiffMatches({
        units: index.units,
        query: "staged header",
        matchCase: false,
      }),
    );
    expect(fileMatch.unit.kind).toBe("file");
    expect(fileMatch.unit.filePath).toBe("src/app.ts");

    const hunkMatches = findDiffMatches({
      units: index.units,
      query: "function greet",
      matchCase: false,
    });
    const hunkMatch = hunkMatches.find((match) => match.unit.kind === "hunk");
    expect(hunkMatch).toBeDefined();
    if (hunkMatch === undefined) {
      throw new Error("expected hunk match");
    }
    expect(hunkMatch.unit.kind).toBe("hunk");
    expect(hunkMatch.unit.hunkIndex).toBe(0);

    const deletionMatch = onlyMatch(
      findDiffMatches({
        units: index.units,
        query: "OldName",
        matchCase: false,
      }),
    );
    expect(deletionMatch.unit.kind).toBe("row");
    expect(deletionMatch.unit.side).toBe("deletions");
    expect(deletionMatch.unit.oldLineNumber).toBe(2);
    expect(deletionMatch.unit.newLineNumber).toBeNull();
    expect(deletionMatch.unit.unifiedLineIndex).toBe(1);
    expect(deletionMatch.unit.splitLineIndex).toBe(1);

    const additionMatch = onlyMatch(
      findDiffMatches({
        units: index.units,
        query: "NewName",
        matchCase: false,
      }),
    );
    expect(additionMatch.unit.kind).toBe("row");
    expect(additionMatch.unit.side).toBe("additions");
    expect(additionMatch.unit.oldLineNumber).toBeNull();
    expect(additionMatch.unit.newLineNumber).toBe(2);
    expect(additionMatch.unit.unifiedLineIndex).toBe(2);
    expect(additionMatch.unit.splitLineIndex).toBe(1);
  });

  it("honors matchCase and reports every normalized row match", () => {
    const index = buildIndex();

    expect(
      findDiffMatches({
        units: index.units,
        query: "newname",
        matchCase: false,
      }),
    ).toHaveLength(1);
    expect(
      findDiffMatches({
        units: index.units,
        query: "newname",
        matchCase: true,
      }),
    ).toHaveLength(0);
    expect(
      findDiffMatches({
        units: index.units,
        query: "const",
        matchCase: false,
      }),
    ).toHaveLength(4);
  });
});
