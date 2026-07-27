import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Lives outside host-lifecycle/** so this harness may import child_process
// to *invoke* eslint.

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const SHARED_ROOT = join(THIS_DIR, "..");
const ESLINT_CONFIG_PATH = join(SHARED_ROOT, "eslint.config.mjs");
// Resolve the repo's own eslint rather than `bunx eslint`: the sandbox below
// has no node_modules, so `bunx` would resolve eslint from the network on
// every case — slow, offline-hostile, and it writes a lockfile into the temp
// dir.
const ESLINT_BIN = join(
  SHARED_ROOT,
  "..",
  "..",
  "node_modules",
  ".bin",
  "eslint",
);

/**
 * Violators are materialized in an **OS temp directory, outside the linted
 * tree** — never under `clients/shared/`.
 *
 * They used to be written to `host-lifecycle/.boundary-tmp/`, which is inside
 * the tree `eslint .` walks and is not in the config's `ignores`. So for the
 * duration of every case in this file the package did **not** lint clean *by
 * design*, and any concurrent `eslint .` — precisely what a CI job running
 * lint and test in parallel does — exited 1 on a file whose entire purpose is
 * to be a violation. Whoever opened that job would read it as a real boundary
 * breach and go hunting for an import that does not exist.
 *
 * That is the verification standard's own failure mode from the other side: a
 * gate that cannot distinguish "the code violates the boundary" from "the
 * boundary test is mid-flight" is not a gate. `eslint .` in this package is
 * now clean as a *property*, not as a sampling result.
 *
 * The sandbox still exercises the real config against the real rule. ESLint
 * flat-config `files` globs resolve relative to the **working directory**, not
 * to the config file, so running with `cwd` set to the sandbox and the
 * violator at `<sandbox>/host-lifecycle/…` matches `host-lifecycle/**\/*.ts`
 * exactly as an in-tree file would. Measured, not assumed: with `cwd` at the
 * package root and an absolute path outside it, eslint answers "File ignored
 * because outside of base path" and the rule never runs.
 */
let sandbox = "";

type EslintOutcome = {
  readonly status: number | null;
  readonly stdout: string;
  readonly messages: readonly string[];
};

/**
 * Materialize a file at `relativePath` inside the sandbox and run the package
 * eslint config against it. Returns the real exit status and the real rule
 * messages — never a read of the config's own source text.
 */
function lintViolator(relativePath: string, lines: string[]): EslintOutcome {
  const violatorPath = join(sandbox, relativePath);
  mkdirSync(dirname(violatorPath), { recursive: true });
  writeFileSync(violatorPath, `${lines.join("\n")}\n`, "utf8");

  const result = spawnSync(
    ESLINT_BIN,
    [
      relativePath,
      "--config",
      ESLINT_CONFIG_PATH,
      "--max-warnings",
      "0",
      "--format",
      "json",
    ],
    { cwd: sandbox, encoding: "utf8", env: process.env },
  );

  const stdout = result.stdout ?? "";
  let messages: string[] = [];
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (Array.isArray(parsed)) {
      messages = parsed.flatMap((file: unknown) => {
        const entry = file as {
          messages?: readonly { message?: unknown }[];
        };
        return (entry.messages ?? []).map((m) => String(m.message ?? ""));
      });
    }
  } catch {
    messages = [];
  }

  return { status: result.status, stdout, messages };
}

function expectBoundaryError(outcome: EslintOutcome): void {
  expect(outcome.status).not.toBe(0);
  expect(outcome.messages.join("\n")).toMatch(
    /read-only|ProbeCommandRunner|keep the probe read-only/i,
  );
}

/**
 * Boundary must *fire*, not merely exist as config text. Each case writes a
 * real violator and asserts eslint reports it.
 *
 * The four dynamic/sibling rows below were measured as **0 errors** before
 * this config change: `await import(...)`, `require(...)`, a `clients/shared`
 * sibling that itself spawns, and anything under `desktop/`. They are the
 * evasions, so they are the cases.
 */
describe("host-lifecycle read-only import boundary", () => {
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "traycer-boundary-"));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  // The sandbox must be a faithful stand-in for an in-tree file, or every
  // assertion below is vacuous. This proves the config block actually applies
  // there: the negative control lints clean, and the same path with a
  // violating import does not.
  it("applies the host-lifecycle config block inside the sandbox", () => {
    const clean = lintViolator("host-lifecycle/sanity-clean.ts", [
      "export function clean(value: string): string {",
      "  return value;",
      "}",
    ]);
    expect(clean.status).toBe(0);

    const dirty = lintViolator("host-lifecycle/sanity-dirty.ts", [
      'import { execFile } from "node:child_process";',
      "export function boom(): void {",
      "  void execFile;",
      "}",
    ]);
    expect(dirty.status).not.toBe(0);

    // A file at the same depth but OUTSIDE host-lifecycle/ must not be
    // governed by the block — otherwise the glob is not what is being tested.
    const outside = lintViolator("elsewhere/not-governed.ts", [
      'import { execFile } from "node:child_process";',
      "export function boom(): void {",
      "  void execFile;",
      "}",
    ]);
    expect(outside.status).toBe(0);
  });

  it("reports an error when a host-lifecycle file imports node:child_process", () => {
    expectBoundaryError(
      lintViolator("host-lifecycle/static-import.ts", [
        'import { execFile } from "node:child_process";',
        "export function boom(): void {",
        "  void execFile;",
        "}",
      ]),
    );
  });

  it("reports an error for the bare, aliased child_process specifier", () => {
    expectBoundaryError(
      lintViolator("host-lifecycle/bare-import.ts", [
        'import * as cp from "child_process";',
        "export function boom(): void {",
        "  void cp;",
        "}",
      ]),
    );
  });

  it("reports an error for a re-export of child_process", () => {
    expectBoundaryError(
      lintViolator("host-lifecycle/re-export.ts", [
        'export { execFile } from "node:child_process";',
      ]),
    );
  });

  it("reports an error for a dynamic import() of child_process", () => {
    expectBoundaryError(
      lintViolator("host-lifecycle/dynamic-import.ts", [
        "export async function boom(): Promise<void> {",
        '  const cp = await import("node:child_process");',
        "  void cp;",
        "}",
      ]),
    );
  });

  it("reports an error for a require() of child_process", () => {
    expectBoundaryError(
      lintViolator("host-lifecycle/require-call.ts", [
        "declare function require(id: string): unknown;",
        "export function boom(): void {",
        '  void require("node:child_process");',
        "}",
      ]),
    );
  });

  it("reports an error for importing a CLI service platform controller", () => {
    expectBoundaryError(
      lintViolator("host-lifecycle/cli-platform.ts", [
        'import * as macos from "../../../traycer-cli/src/service/platforms/macos";',
        "export function boom(): void {",
        "  void macos;",
        "}",
      ]),
    );
  });

  it("reports an error for importing desktop electron-main", () => {
    // Deliberately NOT `host-login-item`: that path is already covered by the
    // pre-existing `**/host-login-item*` glob, so using it here would have
    // made this case pass without the `**/desktop/**` group existing at all —
    // the same fixture-level vacuity this changeset is fixing elsewhere.
    // `host-removal-state` is desktop-only and matches no other pattern.
    expectBoundaryError(
      lintViolator("host-lifecycle/desktop-import.ts", [
        'import * as removal from "../../../desktop/src/electron-main/host/host-removal-state";',
        "export function boom(): void {",
        "  void removal;",
        "}",
      ]),
    );
  });

  it("reports an error for importing a clients/shared sibling that itself spawns", () => {
    // host-lock/process-identity.ts imports node:child_process at line 1, and
    // is the module a start-time comparator is most tempted to reach for.
    expectBoundaryError(
      lintViolator("host-lifecycle/sibling-wrapper.ts", [
        'import { isProcessAlive } from "../../host-lock/process-identity";',
        "export function boom(): void {",
        "  void isProcessAlive;",
        "}",
      ]),
    );
  });

  it("reports an error for a dynamic import() of a forbidden sibling", () => {
    expectBoundaryError(
      lintViolator("host-lifecycle/dynamic-sibling.ts", [
        "export async function boom(): Promise<void> {",
        '  const m = await import("../../host-lock/process-identity");',
        "  void m;",
        "}",
      ]),
    );
  });

  it("still enforces the package type-safety selectors inside host-lifecycle", () => {
    // The host-lifecycle block re-states `no-restricted-syntax`, and flat
    // config replaces rule options rather than merging them. Without the
    // re-state, `as any` and friends would be silently unenforced in exactly
    // the module that most needs them.
    const outcome = lintViolator("host-lifecycle/type-safety.ts", [
      "export function boom(value: unknown): number {",
      "  return value as any;",
      "}",
    ]);
    expect(outcome.status).not.toBe(0);
    expect(outcome.messages.join("\n")).toMatch(/as any/i);
  });

  it("permits an injected ProbeCommandRunner-shaped module with no spawn", () => {
    // The negative control: the rule must not simply fail everything.
    const outcome = lintViolator("host-lifecycle/clean.ts", [
      "export function clean(value: string): string {",
      "  return value;",
      "}",
    ]);
    expect(outcome.status).toBe(0);
  });

  it("exempts the real-supervisor suites, which exist to spawn real supervisors", () => {
    const outcome = lintViolator(
      "host-lifecycle/__tests__/real-supervisor-boundary-probe.ts",
      [
        'import { execFileSync } from "node:child_process";',
        "export function spawnReal(): void {",
        "  void execFileSync;",
        "}",
      ],
    );
    expect(outcome.status).toBe(0);
  });

  it("does NOT exempt an ordinary unit test under __tests__", () => {
    // The exemption is by filename, not by directory. A probe unit test
    // reaching for child_process is a real violation.
    expectBoundaryError(
      lintViolator("host-lifecycle/__tests__/boundary-probe-unit.test.ts", [
        'import { execFileSync } from "node:child_process";',
        "export function boom(): void {",
        "  void execFileSync;",
        "}",
      ]),
    );
  });

  // The property this file must not break: while it runs, the package it
  // belongs to still lints clean. Asserted directly rather than left to a
  // concurrent CI job to discover.
  it("never leaves a violator inside the linted tree", () => {
    lintViolator("host-lifecycle/static-import.ts", [
      'import { execFile } from "node:child_process";',
      "export function boom(): void {",
      "  void execFile;",
      "}",
    ]);
    expect(sandbox.startsWith(SHARED_ROOT)).toBe(false);

    const stray = spawnSync(
      "git",
      ["status", "--porcelain", "-uall", "host-lifecycle"],
      { cwd: SHARED_ROOT, encoding: "utf8" },
    );
    expect(stray.stdout ?? "").not.toMatch(
      /boundary-tmp|violator|static-import/,
    );
  });
});
