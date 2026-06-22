import { describe, expect, it } from "vitest";
import { parsePatchFiles } from "@pierre/diffs";
import {
  buildSnapshotUnifiedPatch,
  buildSnapshotUnifiedPatchBundle,
} from "@/lib/diff/snapshot-diff-patch";

describe("buildSnapshotUnifiedPatch", () => {
  it("emits a/ b/ headers and a parseable hunk for an edit", () => {
    const patch = buildSnapshotUnifiedPatch({
      filePath: "src/app.ts",
      beforeContent: "const a = 1;\n",
      afterContent: "const a = 2;\n",
      ignoreWhitespace: false,
    });
    expect(patch).toContain("--- a/src/app.ts");
    expect(patch).toContain("+++ b/src/app.ts");
    expect(patch).toContain("@@");
    // @pierre/diffs must be able to parse the synthesized patch into a file.
    const parsed = parsePatchFiles(patch, "test-key");
    const files = parsed.flatMap((group) => group.files);
    expect(files.length).toBe(1);
  });

  it("treats a null before side as a pure addition (create)", () => {
    const patch = buildSnapshotUnifiedPatch({
      filePath: "src/new.ts",
      beforeContent: null,
      afterContent: "export const value = 1;\n",
      ignoreWhitespace: false,
    });
    expect(patch).toContain("+export const value = 1;");
    expect(patch).not.toContain("-export const value = 1;");
  });

  it("collapses trailing-whitespace-only changes when ignoreWhitespace is set", () => {
    const args = {
      filePath: "src/app.ts",
      beforeContent: "const a = 1;\n",
      afterContent: "const a = 1;   \n",
    } as const;
    expect(
      buildSnapshotUnifiedPatch({ ...args, ignoreWhitespace: true }),
    ).not.toContain("@@");
    // Without the flag the trailing-whitespace edit still shows as a hunk.
    expect(
      buildSnapshotUnifiedPatch({ ...args, ignoreWhitespace: false }),
    ).toContain("@@");
  });

  it("emits one parseable patch containing multiple files", () => {
    const patch = buildSnapshotUnifiedPatchBundle({
      entries: [
        {
          filePath: "src/a.ts",
          beforeContent: "a1\n",
          afterContent: "a2\n",
        },
        {
          filePath: "src/b.ts",
          beforeContent: null,
          afterContent: "b1\n",
        },
      ],
      ignoreWhitespace: false,
    });

    const parsed = parsePatchFiles(patch, "bundle-key");
    const files = parsed.flatMap((group) => group.files);
    expect(files.map((file) => file.name)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
