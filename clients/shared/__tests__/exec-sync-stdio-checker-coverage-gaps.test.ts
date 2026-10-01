import { describe, expect, it } from "vitest";
import { checkExecSyncStdio } from "./exec-sync-stdio-checker";

/**
 * `exec-sync-stdio-checker.ts:59-101`
 * (`objectLiteralHasStdioProperty` / `guardedCalleeName`) asks only whether
 * an `stdio` KEY exists on an object-literal argument, and only recognizes
 * a bare identifier or direct `.execFileSync`/`.execSync` property access as
 * the guarded callee. Neither check goes far enough:
 *
 *  - `stdio: "inherit"` and `stdio: undefined` both carry the key, so both
 *    pass, even though both still forward the child's stderr into this
 *    process's own.
 *  - An `stdio` ARRAY whose stderr slot (index 2) is `"inherit"` also just
 *    has the key present - the VALUE is never inspected.
 *  - `execFileSync.call(...)`, `cp["execFileSync"](...)` (computed member
 *    access), and `const run = execFileSync; run(...)` (a local alias) each
 *    reach the real function through a shape `guardedCalleeName` does not
 *    structurally recognize, so the call site is invisible to this gate
 *    entirely - `totalCallSites` does not even count it.
 *  - `spawnSync(...)` copies a failing child's stderr the same way and is
 *    not a guarded name at all.
 *
 * This gate shares its class with the host's twin checker
 * (`traycer-host/src/__tests__/exec-sync-stdio-checker.ts`, which has the
 * identical structural gap for `stdio: "inherit"`).
 */
describe("checkExecSyncStdio flags every stderr-forwarding shape it currently misses", () => {
  it('flags stdio: "inherit"', () => {
    const result = checkExecSyncStdio(
      "fixture.ts",
      'import { execFileSync } from "node:child_process";\n' +
        'execFileSync("git", ["status"], { stdio: "inherit" });\n',
    );
    expect(result.totalCallSites).toBe(1);
    expect(result.violations).toHaveLength(1);
  });

  it("flags stdio: undefined", () => {
    const result = checkExecSyncStdio(
      "fixture.ts",
      'import { execFileSync } from "node:child_process";\n' +
        'execFileSync("git", ["status"], { stdio: undefined });\n',
    );
    expect(result.totalCallSites).toBe(1);
    expect(result.violations).toHaveLength(1);
  });

  it('flags an stdio array whose stderr slot (index 2) is "inherit"', () => {
    const result = checkExecSyncStdio(
      "fixture.ts",
      'import { execFileSync } from "node:child_process";\n' +
        'execFileSync("git", ["status"], { stdio: ["ignore", "pipe", "inherit"] });\n',
    );
    expect(result.totalCallSites).toBe(1);
    expect(result.violations).toHaveLength(1);
  });

  it("flags execFileSync.call(...)", () => {
    const result = checkExecSyncStdio(
      "fixture.ts",
      'import { execFileSync } from "node:child_process";\n' +
        'execFileSync.call(null, "git", ["status"]);\n',
    );
    expect(result.totalCallSites).toBeGreaterThan(0);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it('flags cp["execFileSync"](...) (computed member access)', () => {
    const result = checkExecSyncStdio(
      "fixture.ts",
      'import * as cp from "node:child_process";\n' +
        'cp["execFileSync"]("git", ["status"]);\n',
    );
    expect(result.totalCallSites).toBeGreaterThan(0);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("flags a local alias: const run = execFileSync; run(...)", () => {
    const result = checkExecSyncStdio(
      "fixture.ts",
      'import { execFileSync } from "node:child_process";\n' +
        "const run = execFileSync;\n" +
        'run("git", ["status"]);\n',
    );
    expect(result.totalCallSites).toBeGreaterThan(0);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("flags spawnSync(...)", () => {
    const result = checkExecSyncStdio(
      "fixture.ts",
      'import { spawnSync } from "node:child_process";\n' +
        'spawnSync("git", ["status"]);\n',
    );
    expect(result.totalCallSites).toBeGreaterThan(0);
    expect(result.violations.length).toBeGreaterThan(0);
  });
});
