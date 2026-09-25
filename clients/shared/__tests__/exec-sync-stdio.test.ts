import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  checkExecSyncStdio,
  formatExecSyncStdioViolation,
  scanRepoForExecSyncStdio,
  type ExecSyncStdioRepoScanResult,
} from "./exec-sync-stdio-checker";

// `execFileSync`/`execSync` copy a failing child's stderr straight into THIS
// process's stderr unless the caller passes an `stdio` option - on Windows
// that meant raw PowerShell "InvokeMethodOnNull" text landing in the CLI's
// own stderr. The 12 runtime call sites across `clients/shared/host-lock/
// process-identity.ts`, `clients/traycer-cli/src/doctor/engine.ts`,
// `clients/traycer-cli/src/service/platforms/windows.ts`,
// `clients/desktop/src/electron-main/app/updater.ts` and
// `protocol/src/config/credentials-lock.ts` were fixed by adding
// `stdio: ["ignore", "pipe", "pipe"]`. This suite is the class gate: every
// production `execFileSync`/`execSync` call in this batch's scope must carry
// an `stdio` option, forever, not just at these 5 sites today.
//
// Resolved from the test file's OWN location (never `process.cwd()`), so the
// gate scans the same tree whichever directory `vitest` happens to be
// invoked from.
const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(THIS_DIR, "..", "..", "..");

describe("execFileSync/execSync must always pass an `stdio` option", () => {
  // One scan for both tests: it parses every file in scope, about 5 s on a
  // dev machine, so it gets a hook timeout of its own.
  let scan: ExecSyncStdioRepoScanResult | null = null;
  beforeAll(() => {
    scan = scanRepoForExecSyncStdio(REPO_ROOT);
  }, 60_000);

  function scanned(): ExecSyncStdioRepoScanResult {
    if (scan === null) throw new Error("the repository scan did not run");
    return scan;
  }

  it("finds no production call site missing `stdio`, across the whole scanned scope", () => {
    const result = scanned();
    const offenders = result.violations.map(
      (violation) =>
        `${formatExecSyncStdioViolation(violation)} - ${violation.detail}`,
    );
    expect(
      offenders,
      offenders.length === 0
        ? undefined
        : `found ${String(offenders.length)} execFileSync/execSync site(s) without \`stdio\`:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  // Non-vacuity: a gate that silently walked zero files (a wrong repo-root
  // resolution, an exclusion swallowing every directory, a glob that never
  // matched) would report zero violations for the same reason a genuinely
  // clean tree does - passing for a reason that proves nothing. Assert the
  // scan actually SAW production call sites, and that it saw the exact count
  // this batch hardened: 6 in `process-identity.ts`, 2 in `engine.ts`, 1 in
  // `windows.ts`, 1 in `updater.ts`, 2 in `credentials-lock.ts` = 12. This is
  // a census, in the same spirit as `protocol/scripts/compat/__tests__/
  // eager-schema-census.test.ts`: a future PR that adds a 13th guarded call
  // site elsewhere in scope must bump this number deliberately, so the
  // review sees the new call site rather than the count silently drifting.
  it("is not vacuous: it sees more than zero call sites, and exactly the 12 known ones carry `stdio`", () => {
    const result = scanned();
    expect(result.filesScanned).toBeGreaterThan(0);
    expect(result.totalCallSites).toBeGreaterThan(0);
    expect(result.callSitesWithStdio).toBe(12);
    // With zero violations (asserted above) every call site found IS one
    // with `stdio`, so this also pins the total to 12 - stated separately so
    // a future violation reads as "N missing `stdio`" rather than just
    // moving this number.
    expect(result.totalCallSites).toBe(result.callSitesWithStdio);
  });

  describe("the checker function itself, against synthetic sources", () => {
    it("flags a call with no `stdio` option", () => {
      const result = checkExecSyncStdio(
        "synthetic-missing-stdio.ts",
        [
          'import { execFileSync } from "node:child_process";',
          "export function run(): string {",
          '  return execFileSync("ps", ["-p", "1"], { encoding: "utf8" });',
          "}",
        ].join("\n"),
      );
      expect(result.totalCallSites).toBe(1);
      expect(result.callSitesWithStdio).toBe(0);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toMatchObject({
        kind: "missing-stdio",
        line: 3,
      });
    });

    it("flags a renamed named import of execFileSync/execSync, even though its calls are structurally invisible", () => {
      const result = checkExecSyncStdio(
        "synthetic-renamed-import.ts",
        [
          'import { execFileSync as runIt } from "node:child_process";',
          "export function run(): string {",
          '  return runIt("ps", ["-p", "1"], { encoding: "utf8" });',
          "}",
        ].join("\n"),
      );
      const renameViolations = result.violations.filter(
        (violation) => violation.kind === "renamed-import",
      );
      expect(renameViolations).toHaveLength(1);
      expect(renameViolations[0]).toMatchObject({
        line: 1,
        detail: expect.stringContaining("execFileSync") as string,
      });
      // The call through the renamed local is genuinely invisible to the
      // structural call-site match - that is exactly why the import itself
      // must be flagged unconditionally, per the module doc comment.
      expect(result.totalCallSites).toBe(0);
    });

    it("flags a destructured rename (`const { execFileSync: run } = require(...)`)", () => {
      const result = checkExecSyncStdio(
        "synthetic-destructured-rename.ts",
        [
          'const { execFileSync: runIt } = require("node:child_process");',
          'export const out = runIt("ps", ["-p", "1"], { encoding: "utf8" });',
        ].join("\n"),
      );
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toMatchObject({
        kind: "renamed-import",
        line: 1,
      });
    });

    it("scans a CommonJS module the same way", () => {
      const result = checkExecSyncStdio(
        "synthetic-runtime.cjs",
        [
          'const cp = require("node:child_process");',
          'module.exports = () => cp.execSync("ver", { encoding: "utf8" });',
        ].join("\n"),
      );
      expect(result.totalCallSites).toBe(1);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toMatchObject({
        kind: "missing-stdio",
        line: 2,
      });
    });

    it("passes a call that carries an `stdio` option, with no violation", () => {
      const result = checkExecSyncStdio(
        "synthetic-has-stdio.ts",
        [
          'import { execFileSync } from "node:child_process";',
          "export function run(): string {",
          '  return execFileSync("ps", ["-p", "1"], {',
          '    encoding: "utf8",',
          '    stdio: ["ignore", "pipe", "pipe"],',
          "  });",
          "}",
        ].join("\n"),
      );
      expect(result.totalCallSites).toBe(1);
      expect(result.callSitesWithStdio).toBe(1);
      expect(result.violations).toEqual([]);
    });

    it("also flags the property-access form (`cp.execFileSync(...)`) missing `stdio`", () => {
      // A namespace/default import of child_process needs no separate
      // import-level rule: its calls are property accesses, already covered
      // structurally.
      const result = checkExecSyncStdio(
        "synthetic-property-access.ts",
        [
          'import * as cp from "child_process";',
          "export function run(): string {",
          '  return cp.execFileSync("ps", ["-p", "1"], { encoding: "utf8" });',
          "}",
        ].join("\n"),
      );
      expect(result.totalCallSites).toBe(1);
      expect(result.callSitesWithStdio).toBe(0);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]?.kind).toBe("missing-stdio");
    });
  });
});
