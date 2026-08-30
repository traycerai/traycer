import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Ticket 07, attempt-core's ruling on the Finding-2 dispatch gate.
//
// `dispatchAttemptExecutor` is **admission-only new-attempt transport**. Its
// unconditional cohort gate is correct: "stop admitting new attempts" applies
// at dispatch, before any spawn or reconciliation. Continuations never arrive
// through it - they route `host update-verify` ->
// `runLocalAttemptExecutorSegment`, whose gate is the one scoped to skip for an
// already-adopted continuation.
//
// That makes the routing a real invariant rather than a convention, and an
// invariant nothing checks is a comment. This file checks it two ways:
//
//  1. the exact production importer set of `dispatchAttemptExecutor`, and
//  2. the SHAPE of `DispatchAttemptExecutorOptions`, which must never gain a
//     field that implies a continuation.
//
// (2) is the fail-closed half the ruling asked for verbatim: the type and this
// architecture boundary ARE the mechanism. There is deliberately no runtime
// arm rejecting a continuation-implying field, because a runtime check would
// imply such a field is expected to occur. A future one must break THIS gate
// and force a design review.

const CLI_SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

/** The module that DEFINES dispatch is not an importer of it. */
const DEFINING_MODULE = "host/update-executor.ts";

/**
 * Production files permitted to reach `dispatchAttemptExecutor`.
 *
 * **Empty today, and that is the assertion, not a placeholder.** Nothing in
 * production admits a new schema-v2 attempt before Ticket 07's cutover. When
 * the cutover adds the new-attempt dispatcher, exactly that one admission
 * owner joins this list - and a second entry should be a conversation, not a
 * diff.
 */
const ALLOWED_DISPATCH_IMPORTERS: readonly string[] = [];

/**
 * Files that own a CONTINUATION or RECOVERY flow. Each must reach the segment
 * and must never reference dispatch.
 */
const CONTINUATION_OWNERS: readonly string[] = ["host/update-verify.ts"];

const DISPATCH_IDENTIFIER = /\bdispatchAttemptExecutor\b/;
const SEGMENT_IDENTIFIER = /\brunLocalAttemptExecutorSegment\b/;

/**
 * Fields that would mean dispatch is being handed a continuation.
 *
 * `hostHomeDir` is on the list for a reason worth stating: it is not itself a
 * continuation, but it is the canonical-record path, and the only reason
 * dispatch would want one is to answer a question about an existing attempt.
 */
const FORBIDDEN_OPTION_FIELDS: readonly string[] = [
  "request",
  "expected",
  "attemptId",
  "continuation",
  "hostHomeDir",
];

/** A caller-built verdict would let a caller opt around the fence entirely. */
const FORBIDDEN_OPTION_TYPES: readonly string[] = [
  "UpdateExecutorCohortVerdict",
];

// This file's own prose names every forbidden identifier. Only real code
// tokens may count, so comments are stripped before matching.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

// Dependencies and gitignored build outputs (`**/dist/` etc. — no tracked
// source lives under these names) are pruned: scanning them would make the
// gate's verdict depend on whether a local build has run, and CI never sees
// them.
const PRUNED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "out",
  "dist",
  "dist-sea",
  "dist-npm",
  "build",
]);

async function walkSourceFiles(
  root: string,
  visited: Set<string>,
): Promise<string[]> {
  const canonicalRoot = await realpath(root).catch(() => null);
  if (canonicalRoot === null || visited.has(canonicalRoot)) return [];
  const ancestry = new Set(visited);
  ancestry.add(canonicalRoot);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (PRUNED_DIRECTORY_NAMES.has(entry.name)) return [];
      const path = join(root, entry.name);
      const info = await stat(path).catch(() => null);
      if (info === null) return [];
      if (info.isDirectory()) return walkSourceFiles(path, ancestry);
      if (!info.isFile()) return [];
      const extension = entry.name.slice(entry.name.lastIndexOf("."));
      return SOURCE_EXTENSIONS.has(extension) && !entry.name.endsWith(".d.ts")
        ? [path]
        : [];
    }),
  );
  return nested.flat();
}

async function productionFilesReferencing(
  pattern: RegExp,
): Promise<readonly string[]> {
  const files = await walkSourceFiles(CLI_SRC_ROOT, new Set());
  const hits: string[] = [];
  for (const path of files) {
    const relativePath = relative(CLI_SRC_ROOT, path).split(sep).join("/");
    if (relativePath.split("/").includes("__tests__")) continue;
    if (relativePath === DEFINING_MODULE) continue;
    const source = stripComments(await readFile(path, "utf8"));
    if (pattern.test(source)) hits.push(relativePath);
  }
  return hits.sort();
}

describe("dispatchAttemptExecutor is admission-only new-attempt transport", () => {
  it("its production importer set is EXACTLY the allowed admission owners", async () => {
    const importers = await productionFilesReferencing(DISPATCH_IDENTIFIER);
    // Exact equality in both directions on purpose. An unexpected importer is
    // a continuation leaking into the admission path; an allowlist entry with
    // no importer is a stale permission nobody removed, which is how an
    // allowlist quietly stops describing the code it governs.
    expect(importers).toEqual([...ALLOWED_DISPATCH_IMPORTERS].sort());
  });

  it("every continuation/recovery owner reaches the SEGMENT and never dispatch", async () => {
    for (const owner of CONTINUATION_OWNERS) {
      const source = stripComments(
        await readFile(join(CLI_SRC_ROOT, owner), "utf8"),
      );
      // Both halves matter. The negative alone would pass for a file that
      // reaches neither - including one that stopped doing its job entirely.
      expect({
        owner,
        reachesSegment: SEGMENT_IDENTIFIER.test(source),
        referencesDispatch: DISPATCH_IDENTIFIER.test(source),
      }).toEqual({ owner, reachesSegment: true, referencesDispatch: false });
    }
  });

  it("DispatchAttemptExecutorOptions carries no continuation-implying field", async () => {
    const source = await readFile(join(CLI_SRC_ROOT, DEFINING_MODULE), "utf8");
    const match =
      /export interface DispatchAttemptExecutorOptions \{([\s\S]*?)\n\}/.exec(
        source,
      );
    // If the interface cannot be found the gate is inert, so its absence is a
    // failure rather than a skip - the shape of a check that silently stops
    // checking is exactly what this epic keeps finding.
    expect(match).not.toBeNull();
    if (match === null) return;
    const body = stripComments(match[1] ?? "");
    const present = [...FORBIDDEN_OPTION_FIELDS, ...FORBIDDEN_OPTION_TYPES]
      .filter((name) => new RegExp(`\\b${name}\\b`).test(body))
      .sort();
    expect(present).toEqual([]);
  });
});
