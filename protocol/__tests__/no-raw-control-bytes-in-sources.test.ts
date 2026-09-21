/**
 * Fails on a raw control byte below 0x20 other than TAB, LF and CR in
 * tracked text sources of the OSS repo.
 *
 * ripgrep treats a file that holds a NUL as binary and stops searching it,
 * which is how this class hid. This scan reads bytes with `readFileSync`
 * and enumerates with `git ls-files -z`. It never calls rg.
 *
 * Generated `clients/gui-app/src/lib/cn-tables.ts` holds a DEL (0x7F).
 * DEL is not below 0x20, so this scan does not catch it and that file
 * needs no exception.
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

const TEXT_SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".yaml",
  ".yml",
  ".sh",
  ".sql",
  ".prisma",
  ".toml",
  ".html",
  ".css",
]);

const ALLOWED_CONTROLS = new Set([0x09, 0x0a, 0x0d]);

export type RawControlByteHit = {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  readonly code: number;
};

/**
 * Every raw control byte below 0x20 other than TAB, LF and CR.
 *
 * Line is 1 + the number of LF bytes before the offset. Column is 1-based
 * within that line.
 */
export function findRawControlBytes(
  bytes: Uint8Array,
): readonly RawControlByteHit[] {
  const hits: RawControlByteHit[] = [];
  let line = 1;
  let column = 1;
  for (let i = 0; i < bytes.length; i += 1) {
    const code = bytes[i];
    if (code === undefined) continue;
    if (code < 0x20 && !ALLOWED_CONTROLS.has(code)) {
      hits.push({ offset: i, line, column, code });
    }
    if (code === 0x0a) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return hits;
}

export function formatRawControlByteHit(
  relativePath: string,
  hit: RawControlByteHit,
): string {
  const hex = hit.code.toString(16).padStart(2, "0");
  return `${relativePath}:${String(hit.line)}:${String(hit.column)} 0x${hex}`;
}

function splitGitNulListing(listing: Buffer): readonly string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < listing.length; i += 1) {
    if (listing[i] === 0) {
      if (i > start) {
        parts.push(listing.subarray(start, i).toString("utf8"));
      }
      start = i + 1;
    }
  }
  if (start < listing.length) {
    parts.push(listing.subarray(start).toString("utf8"));
  }
  return parts;
}

function isRegularFile(absolutePath: string): boolean {
  try {
    return statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

/** Tracked text sources of the OSS repo, relative to the repo root. */
export function trackedTextSources(repoRoot: string): readonly string[] {
  const listing = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot });
  const files: string[] = [];
  for (const relative of splitGitNulListing(listing)) {
    if (!TEXT_SOURCE_EXTENSIONS.has(path.extname(relative))) continue;
    const absolute = path.join(repoRoot, relative);
    if (!isRegularFile(absolute)) continue;
    files.push(relative);
  }
  return files;
}

function scanRepo(repoRoot: string): readonly string[] {
  const findings: string[] = [];
  for (const relative of trackedTextSources(repoRoot)) {
    const bytes = readFileSync(path.join(repoRoot, relative));
    for (const hit of findRawControlBytes(bytes)) {
      findings.push(formatRawControlByteHit(relative, hit));
    }
  }
  return findings;
}

describe("no raw control bytes in tracked text sources", () => {
  it("finds none in the OSS repo", () => {
    expect(scanRepo(REPO_ROOT)).toEqual([]);
  });

  it("enumerates a real git listing of text sources", () => {
    const files = trackedTextSources(REPO_ROOT);
    expect(files.length).toBeGreaterThan(1000);
    expect(files).toContain("clients/gui-app/src/lib/drafts/draft-ids.ts");
    expect(files).toContain(
      "protocol/__tests__/internal-import-boundary.test.ts",
    );
  });

  it("reports a planted raw NUL at the right line and column, and ignores backslash-zero", () => {
    const planted = Buffer.concat([
      Buffer.from("const x = `", "utf8"),
      Buffer.from([0x00]),
      Buffer.from("`;\n", "utf8"),
    ]);
    const escaped = Buffer.concat([
      Buffer.from('const x = "', "utf8"),
      Buffer.from([0x5c, 0x30]),
      Buffer.from('";\n', "utf8"),
    ]);

    const directory = mkdtempSync(path.join(os.tmpdir(), "raw-control-scan-"));
    const plantedPath = path.join(directory, "planted.ts");
    const escapedPath = path.join(directory, "escaped.ts");
    try {
      writeFileSync(plantedPath, planted);
      writeFileSync(escapedPath, escaped);

      const plantedHits = findRawControlBytes(readFileSync(plantedPath));
      expect(plantedHits).toEqual([
        {
          offset: Buffer.from("const x = `", "utf8").byteLength,
          line: 1,
          column: 12,
          code: 0,
        },
      ]);
      expect(
        plantedHits.map((hit) => formatRawControlByteHit("planted.ts", hit)),
      ).toEqual(["planted.ts:1:12 0x00"]);

      expect(findRawControlBytes(readFileSync(escapedPath))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("catches STX and 0x1F, ignores TAB, LF and CR, and does not treat DEL as a control", () => {
    expect(findRawControlBytes(Buffer.from([0x02]))).toEqual([
      { offset: 0, line: 1, column: 1, code: 0x02 },
    ]);
    expect(findRawControlBytes(Buffer.from([0x1f]))).toEqual([
      { offset: 0, line: 1, column: 1, code: 0x1f },
    ]);
    expect(findRawControlBytes(Buffer.from([0x09, 0x0a, 0x0d]))).toEqual([]);
    expect(findRawControlBytes(Buffer.from([0x7f]))).toEqual([]);
  });
});
