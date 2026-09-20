/// <reference types="node" />

import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `clients/gui-app/src/lib/drafts/draft-ids.ts` once joined two ids with a
 * LITERAL NUL byte inside a template literal (fixed to a Unicode
 * escape). One raw NUL makes grep and ripgrep classify the whole file as
 * binary, so a directory walk skips it - every text-based search of the
 * codebase silently missed that module. Nothing else notices: the compiler,
 * the linter and the formatter all accept the byte, and the runtime string is
 * the same under either spelling, so no behavioural test can fail on it. This
 * scan reads every candidate file as a raw BUFFER, so it judges the bytes on
 * disk, which is what grep and ripgrep judge. It must never shell out to
 * either tool: they are the tools the byte blinds.
 *
 * How the byte gets in: an editor or agent tool that unescapes the six typed
 * characters of the escape into the byte itself on write. It happened three
 * times while this very test was being written, so the dirty fixture below
 * builds its byte at runtime with `String.fromCharCode(0)`.
 */

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".cjs",
  ".mjs",
  ".json",
  ".css",
  ".md",
  ".html",
  ".svg",
]);

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".tanstack",
  "coverage",
]);

type Offender = { file: string; line: number };

function collectTextFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      found.push(...collectTextFiles(full));
      continue;
    }
    if (TEXT_EXTENSIONS.has(path.extname(entry))) found.push(full);
  }
  return found;
}

/** 1-based line of the first NUL byte in `buffer`. */
function nulByteLine(buffer: Buffer): number {
  const index = buffer.indexOf(0);
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (buffer[i] === 0x0a) line++;
  }
  return line;
}

/** The scanner: every text file under `root` containing a raw NUL byte. */
function findRawNulBytes(root: string): Offender[] {
  const offenders: Offender[] = [];
  for (const file of collectTextFiles(root)) {
    const buffer = readFileSync(file);
    if (!buffer.includes(0)) continue;
    offenders.push({ file, line: nulByteLine(buffer) });
  }
  return offenders;
}

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("no raw NUL byte in source", () => {
  // POPULATION GUARD, first because the scan below is vacuous without it. A
  // scanner that picks its own file list has to prove that list is non-empty
  // (and roughly the right size) before an empty offender list means
  // anything - otherwise a wrong `root` reads as a clean tree forever.
  it("walks a real population of source files", () => {
    const files = collectTextFiles(SRC_DIR);

    expect(files.length).toBeGreaterThan(1000);
  });

  it("finds no raw NUL byte under the real source tree", () => {
    const offenders = findRawNulBytes(SRC_DIR);
    const message = offenders
      .map(
        (offender) =>
          `${path.relative(SRC_DIR, offender.file)}:${offender.line} - write it as the escape \\u0000`,
      )
      .join("\n");

    expect(offenders, message).toEqual([]);
  });

  // The scan is only worth having if it can actually SEE a raw NUL byte -
  // otherwise an empty result above is indistinguishable from a scanner that
  // silently stopped reading. This proves it on a throwaway fixture: one
  // clean file the scan must pass over, and one dirty file it must report at
  // the exact line the byte lands on.
  it("proves it can see a raw NUL byte, using a temp fixture", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "no-raw-nul-byte-"));
    try {
      const cleanFile = path.join(dir, "clean.ts");
      const dirtyFile = path.join(dir, "dirty.ts");
      writeFileSync(cleanFile, "export const clean = 1;\n");
      writeFileSync(
        dirtyFile,
        Buffer.from(
          "line one\nline two\nbad" + String.fromCharCode(0) + "line\n",
          "utf8",
        ),
      );

      const offenders = findRawNulBytes(dir);

      expect(offenders).toEqual([{ file: dirtyFile, line: 3 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
