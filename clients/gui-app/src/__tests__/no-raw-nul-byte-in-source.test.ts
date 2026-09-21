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

/**
 * The scan's scope, which is asserted below rather than described here.
 *
 * A scanner that quietly narrows its own population is the defect it is meant
 * to catch, wearing the other hat: an empty offender list from a walk that
 * skipped the file reads exactly like a clean tree. So both halves of the
 * scope - which directories it descends into, and which files it opens - are
 * checked by their own tests, and neither can drift without one of them
 * failing.
 *
 * Every file under `src` is either TEXT (read and judged) or BINARY (a real
 * asset, where NUL bytes are the format and not a defect). There is no third
 * outcome: an extension in neither set fails `covers every extension present`,
 * so a new `.yaml`, `.txt` or `.graphql` arriving under `src` has to be
 * classified by a person rather than silently falling out of the scan. Both
 * halves classify by the lowercased extension, through `classifiedExtension`
 * alone, so the scan and the coverage guard can never disagree about case.
 * The text set deliberately lists spellings that have no files today (`.js`,
 * `.mjs`, `.svg`) - a scan that is ready for a file type costs nothing, and
 * the coverage test only fails on a type that is PRESENT and unclassified.
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

/** Real binary assets: a NUL here is the file format, not a mistake. */
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".mp4",
  ".webm",
  ".pdf",
]);

/**
 * Directory names that must NOT appear under `src`, asserted by its own test.
 *
 * The walk used to SKIP these instead. That was build output defended against
 * in the one place build output never lands, and it bought a blind spot in
 * exchange: a perfectly ordinary source directory called `build`, `dist` or
 * `coverage` - `src/lib/build/`, say - would have been skipped in silence, and
 * a raw NUL inside it would have gone on hiding from grep with the scan
 * reporting green. Removing the skips makes the walk total; this list keeps
 * the other half of the bargain by failing if a directory that genuinely
 * should not be scanned ever appears, so the decision is made by a person at
 * that moment rather than by a constant written years earlier.
 */
const UNSCANNABLE_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  ".tanstack",
  "coverage",
]);

type Offender = { file: string; line: number };

/** Every directory under `root`, `root` itself included. */
function collectDirectories(root: string): string[] {
  const found = [root];
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    if (statSync(full).isDirectory()) found.push(...collectDirectories(full));
  }
  return found;
}

/** Every file under `root`, of any extension. The walk skips nothing. */
function collectAllFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...collectAllFiles(full));
      continue;
    }
    found.push(full);
  }
  return found;
}

/** The extension as both halves of the scope classify it: lowercased. */
function classifiedExtension(file: string): string {
  return path.extname(file).toLowerCase();
}

function collectTextFiles(dir: string): string[] {
  return collectAllFiles(dir).filter((file) =>
    TEXT_EXTENSIONS.has(classifiedExtension(file)),
  );
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

  // SCOPE GUARD 1: the walk descends into everything, so nothing under `src`
  // can hide behind a directory name. This is the assertion that replaced a
  // skip list. The failure it exists for is not hypothetical: `src/lib/build/`
  // is an ordinary thing to write, and under the old walk a raw NUL inside it
  // would have gone on hiding from grep while this file reported green.
  it("has no directory under src that the scan would have to skip", () => {
    const unscannable = collectDirectories(SRC_DIR)
      .filter((dir) => UNSCANNABLE_DIR_NAMES.has(path.basename(dir)))
      .map((dir) => path.relative(SRC_DIR, dir));

    expect(
      unscannable,
      `The walk reads every directory under src. These names mean the tree now ` +
        `holds something it should not scan, so decide deliberately: move it out ` +
        `of src, or teach the walk to skip it AND add a fixture proving the skip ` +
        `is what you meant.\n${unscannable.join("\n")}`,
    ).toEqual([]);
  });

  // SCOPE GUARD 2: every extension present is classified. A file type in
  // neither set is not "probably fine" - it is a file the scan never opens,
  // and the whole defect this suite exists for is a file nothing opens.
  it("covers every extension present under src", () => {
    const unclassified = [
      ...new Set(
        collectAllFiles(SRC_DIR)
          .map(classifiedExtension)
          .filter(
            (ext) => !TEXT_EXTENSIONS.has(ext) && !BINARY_EXTENSIONS.has(ext),
          ),
      ),
    ].sort();

    expect(
      unclassified,
      `Unclassified file extensions under src. Add each to TEXT_EXTENSIONS (the ` +
        `scan will read it) or to BINARY_EXTENSIONS (a NUL there is the format). ` +
        `Leaving it out means the scan silently never opens those files.\n` +
        unclassified.join(" "),
    ).toEqual([]);
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
  // silently stopped reading. This proves it on a throwaway fixture: clean
  // lower- and mixed-case text files the scan must pass over, plus dirty
  // lower-, upper- and mixed-case text files it must report at the exact lines
  // where their bytes land. The case variants are here because the coverage
  // guard has always classified `.TS` as text, so a scanner that skipped it
  // could report a clean tree for a file it never opened.
  it("proves it can see a raw NUL byte, using a temp fixture", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "no-raw-nul-byte-"));
    try {
      const cleanFile = path.join(dir, "clean.ts");
      const dirtyFile = path.join(dir, "dirty.ts");
      const cleanMixedCaseFile = path.join(dir, "clean.CsS");
      const dirtyUpperCaseFile = path.join(dir, "uppercase.TS");
      const dirtyMixedCaseFile = path.join(dir, "mixed.JsOn");
      writeFileSync(cleanFile, "export const clean = 1;\n");
      writeFileSync(cleanMixedCaseFile, "body { color: black; }\n");
      writeFileSync(
        dirtyFile,
        Buffer.from(
          "line one\nline two\nbad" + String.fromCharCode(0) + "line\n",
          "utf8",
        ),
      );
      writeFileSync(
        dirtyUpperCaseFile,
        Buffer.from(
          "line one\nbad" + String.fromCharCode(0) + "line\n",
          "utf8",
        ),
      );
      writeFileSync(
        dirtyMixedCaseFile,
        Buffer.from(
          "line one\nline two\nline three\nbad" +
            String.fromCharCode(0) +
            "line\n",
          "utf8",
        ),
      );

      const offenders = findRawNulBytes(dir).sort((a, b) =>
        a.file.localeCompare(b.file),
      );

      expect(offenders).toEqual(
        [
          { file: dirtyFile, line: 3 },
          { file: dirtyMixedCaseFile, line: 4 },
          { file: dirtyUpperCaseFile, line: 2 },
        ].sort((a, b) => a.file.localeCompare(b.file)),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
