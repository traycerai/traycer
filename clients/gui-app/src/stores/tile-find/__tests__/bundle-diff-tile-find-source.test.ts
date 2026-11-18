import { describe, expect, it } from "vitest";
import {
  createBundleDiffFindSource,
  createDiffTileFindAdapter,
  type BundleDiffFindFileInput,
  type BundleDiffFindLoadedPatchInput,
} from "@/stores/tile-find";

const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1 +1 @@",
  "-const label = 'OldName';",
  "+const label = 'NewName';",
  "",
].join("\n");

function fileInput(args: {
  readonly id: string;
  readonly filePath: string;
  readonly text: string;
  readonly coverageState: BundleDiffFindFileInput["coverageState"];
}): BundleDiffFindFileInput {
  return {
    id: args.id,
    filePath: args.filePath,
    coverageState: args.coverageState,
    metadataUnits: [
      {
        id: `metadata:${args.id}`,
        filePath: args.filePath,
        scopeId: args.id,
        text: args.text,
      },
    ],
  };
}

function loadedPatch(args: {
  readonly fileId: string;
  readonly isTruncated: boolean;
}): BundleDiffFindLoadedPatchInput {
  return {
    fileId: args.fileId,
    patch: PATCH,
    cacheKey: `patch:${args.fileId}`,
    isTruncated: args.isTruncated,
  };
}

describe("createBundleDiffFindSource", () => {
  it("searches metadata for every file while reporting partial coverage", () => {
    const result = createBundleDiffFindSource({
      files: [
        fileInput({
          id: "unloaded",
          filePath: "src/unloaded.ts",
          text: "unloaded metadata",
          coverageState: "unloaded",
        }),
        fileInput({
          id: "collapsed",
          filePath: "src/collapsed.ts",
          text: "collapsed metadata",
          coverageState: "collapsed",
        }),
        fileInput({
          id: "large",
          filePath: "src/large.ts",
          text: "large metadata",
          coverageState: "large",
        }),
        fileInput({
          id: "binary",
          filePath: "src/logo.png",
          text: "binary logo metadata",
          coverageState: "binary",
        }),
        fileInput({
          id: "failed",
          filePath: "src/failed.ts",
          text: "failed metadata",
          coverageState: "failed",
        }),
      ],
      loadedPatches: new Map(),
    });
    const adapter = createDiffTileFindAdapter({
      tileInstanceId: "bundle",
      tileKind: "git-diff",
      source: result.source,
      renderer: null,
    });

    void adapter.search({ requestId: 1, query: "metadata", matchCase: false });

    expect(adapter.getSnapshot()).toMatchObject({
      status: "partial",
      current: 1,
      total: 5,
    });
    expect(adapter.getSnapshot().coverageMessage).toContain(
      "1 unloaded file was",
    );
    expect(adapter.getSnapshot().coverageMessage).toContain(
      "1 collapsed file was",
    );
    expect(adapter.getSnapshot().coverageMessage).toContain("1 large file was");
    expect(adapter.getSnapshot().coverageMessage).toContain(
      "1 binary file was",
    );
    expect(adapter.getSnapshot().coverageMessage).toContain(
      "1 failed file was",
    );
  });

  it("searches registered loaded patch entries and reports complete coverage", () => {
    const result = createBundleDiffFindSource({
      files: [
        fileInput({
          id: "app",
          filePath: "src/app.ts",
          text: "app metadata",
          coverageState: "unloaded",
        }),
      ],
      loadedPatches: new Map([
        ["app", loadedPatch({ fileId: "app", isTruncated: false })],
      ]),
    });
    const adapter = createDiffTileFindAdapter({
      tileInstanceId: "bundle",
      tileKind: "git-diff",
      source: result.source,
      renderer: null,
    });

    void adapter.search({ requestId: 1, query: "NewName", matchCase: true });

    expect(adapter.getSnapshot()).toMatchObject({
      status: "ready",
      current: 1,
      total: 1,
      coverageMessage: null,
    });
    expect(adapter.getSnapshot().activeUnitId).toContain("row:");
  });

  it("reports truncated loaded patch entries as partial", () => {
    const result = createBundleDiffFindSource({
      files: [
        fileInput({
          id: "app",
          filePath: "src/app.ts",
          text: "app metadata",
          coverageState: "unloaded",
        }),
      ],
      loadedPatches: new Map([
        ["app", loadedPatch({ fileId: "app", isTruncated: true })],
      ]),
    });

    expect(result.coverageCounts.truncated).toBe(1);
    expect(result.source.kind).toBe("metadata-partial");
    expect(result.source.coverageMessage).toContain("1 truncated file was");
  });
});
