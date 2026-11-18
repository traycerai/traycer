import os from "node:os";

/**
 * Redirect `HOME`/`USERPROFILE` to the given per-test sandbox and PROVE the
 * redirect took effect before returning.
 *
 * Under Node, `os.homedir()` re-reads the env on every call, so the check
 * passes trivially. Under the Bun runtime the mid-process env mutation is
 * IGNORED (Bun caches the home at process start), and when
 * `vitest.setup.ts` has not been loaded to re-point `homedir` - `bun test`
 * never loads vitest setup files - `homedir()` keeps resolving the REAL
 * home. That exact escape let desktop suites write their fixtures into the
 * real `~/.traycer/cli/bin/traycer` (the v1.1.9-rc.3 dead-CLI incident) and
 * the real `~/.traycer/host/host-name.json`. Throwing here kills the test
 * before its subject can write anything.
 *
 * Every desktop test that points home-relative production code at a temp
 * dir must go through this helper instead of assigning `process.env.HOME`
 * directly.
 */
export function sandboxHome(sandboxDir: string): void {
  process.env.HOME = sandboxDir;
  process.env.USERPROFILE = sandboxDir;
  // Read `homedir` off the module object at CALL time (a named import
  // captures the binding at import time and would keep seeing whatever was
  // installed when this module loaded, defeating both the check and its
  // contract test).
  const resolved = os.homedir();
  if (resolved !== sandboxDir) {
    throw new Error(
      `home sandbox did not take effect: os.homedir() resolved "${resolved}" instead of "${sandboxDir}". ` +
        "This runtime does not follow process.env.HOME (Bun caches the home at startup) and the vitest.setup.ts " +
        "homedir re-point is not active - refusing to run a suite that writes home-relative paths against the " +
        "real home. Run the suite with vitest on Node (`bun run test`), not `bun test` or `bunx --bun vitest`.",
    );
  }
}
