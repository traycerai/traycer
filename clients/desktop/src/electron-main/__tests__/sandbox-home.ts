import os from "node:os";

/**
 * Under the Bun runtime the mid-process env mutation is IGNORED (Bun caches the home at process start), and when `vitest.setup.ts` has not been loaded to re-point `homedir`.
 * Every desktop test that points home-relative production code at a temp dir must go through this helper instead of assigning `process.env.HOME` directly.
 */
export function sandboxHome(sandboxDir: string): void {
  process.env.HOME = sandboxDir;
  process.env.USERPROFILE = sandboxDir;
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
