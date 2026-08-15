import { describe, it, expect } from "vitest";
import type { PrLocalDiffSummaryFileV11 } from "@traycer/protocol/host/pr-schemas";
import {
  isPrLocalDiffFileCollapsed,
  prLocalDiffFileKey,
  prLocalDiffPathKey,
  prLocalDiffPreviousSideKey,
} from "../pr-local-diff-file-key";

function viewFile(
  overrides: Partial<PrLocalDiffSummaryFileV11>,
): PrLocalDiffSummaryFileV11 {
  return {
    path: "src/a.ts",
    previousPath: null,
    status: "modified",
    insertions: 1,
    deletions: 1,
    isBinary: false,
    pathBytes: null,
    previousPathBytes: null,
    ...overrides,
  };
}

describe("prLocalDiffFileKey / prLocalDiffPathKey", () => {
  it("tags a clean path with p: and a byte token with b:", () => {
    expect(prLocalDiffPathKey("src/a.ts", null)).toBe("p:src/a.ts");
    expect(prLocalDiffPathKey("src/a.ts", "dG9rZW4=")).toBe("b:dG9rZW4=");
  });

  // The whole point of the tag: without it, a clean file literally NAMED
  // like some other file's token would collide with that file's key in the
  // same string space. `YmFkLf8udHh0` is real base64 (the byte token of
  // `bad-\xff.txt`) and also a syntactically valid file name.
  it("keeps a clean file named like a token distinct from the byte file that token belongs to", () => {
    const cleanFileNamedLikeAToken = viewFile({
      path: "YmFkLf8udHh0",
      pathBytes: null,
    });
    const byteFile = viewFile({
      path: "bad-�.txt",
      pathBytes: "YmFkLf8udHh0",
    });

    const cleanKey = prLocalDiffFileKey(cleanFileNamedLikeAToken);
    const byteKey = prLocalDiffFileKey(byteFile);

    expect(cleanKey).toBe("p:YmFkLf8udHh0");
    expect(byteKey).toBe("b:YmFkLf8udHh0");
    expect(cleanKey).not.toBe(byteKey);
  });

  it("keys a byte-addressed file on its token, not its lossy display path", () => {
    const fileA = viewFile({ path: "bad-�.txt", pathBytes: "AAAA" });
    const fileB = viewFile({ path: "bad-�.txt", pathBytes: "BBBB" });
    expect(prLocalDiffFileKey(fileA)).not.toBe(prLocalDiffFileKey(fileB));
  });
});

describe("prLocalDiffPreviousSideKey", () => {
  it("is empty for a non-rename (previousPath null)", () => {
    expect(prLocalDiffPreviousSideKey(viewFile({ previousPath: null }))).toBe(
      "",
    );
  });

  it("tags a clean rename source with p:", () => {
    const file = viewFile({
      previousPath: "old/path.ts",
      previousPathBytes: null,
    });
    expect(prLocalDiffPreviousSideKey(file)).toBe("p:old/path.ts");
  });

  it("tags a byte-addressed rename source with b:", () => {
    const file = viewFile({
      previousPath: "old-�.ts",
      previousPathBytes: "dG9rZW4=",
    });
    expect(prLocalDiffPreviousSideKey(file)).toBe("b:dG9rZW4=");
  });

  // Each side is derived independently of the other - a byte destination can
  // legitimately sit beside a clean source, and vice versa (the common
  // rename-away-from-a-bad-name case).
  it("derives the source side independently of the destination side: byte destination, clean source", () => {
    const file = viewFile({
      path: "renamed-�.ts",
      pathBytes: "ZGVzdA==",
      previousPath: "old/clean.ts",
      previousPathBytes: null,
    });
    expect(prLocalDiffFileKey(file)).toBe("b:ZGVzdA==");
    expect(prLocalDiffPreviousSideKey(file)).toBe("p:old/clean.ts");
  });

  it("derives the source side independently of the destination side: clean destination, byte source", () => {
    const file = viewFile({
      path: "new/clean.ts",
      pathBytes: null,
      previousPath: "old-�.ts",
      previousPathBytes: "c3JjLXRva2Vu",
    });
    expect(prLocalDiffFileKey(file)).toBe("p:new/clean.ts");
    expect(prLocalDiffPreviousSideKey(file)).toBe("b:c3JjLXRva2Vu");
  });
});

describe("isPrLocalDiffFileCollapsed", () => {
  it("does not match a bare-path entry equal to file.path", () => {
    // `collapsedFileKeys` holds TAGGED keys and nothing else; a legacy or
    // hand-built bare-path entry must not alias the tagged form.
    const file = viewFile({ path: "src/a.ts", pathBytes: null });
    expect(isPrLocalDiffFileCollapsed(["src/a.ts"], file)).toBe(false);
  });

  it("matches the tagged p: entry for a clean file", () => {
    const file = viewFile({ path: "src/a.ts", pathBytes: null });
    expect(isPrLocalDiffFileCollapsed(["p:src/a.ts"], file)).toBe(true);
  });

  it("matches the tagged b: entry for a byte-addressed file, and only that", () => {
    const file = viewFile({
      path: "bad-�.txt",
      pathBytes: "YmFkLf8udHh0",
    });
    expect(isPrLocalDiffFileCollapsed(["b:YmFkLf8udHh0"], file)).toBe(true);
    expect(isPrLocalDiffFileCollapsed(["p:bad-�.txt"], file)).toBe(false);
    expect(isPrLocalDiffFileCollapsed(["bad-�.txt"], file)).toBe(false);
  });
});
