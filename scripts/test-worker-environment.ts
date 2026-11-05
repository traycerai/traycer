import process from "node:process";

// Run before any other setup or test import. Only these named OS/runner and
// explicit test inputs may be inherited; never carry deployment/provider keys.
// Setup runs again for each file, including files sharing an unisolated worker.
const allowed = new Set([
  "PATH", // locate Bun/Node/Git and the executable fixtures used by subprocess tests.
  "HOME", // seed existing private-home setup and POSIX path tests.
  "USERPROFILE", // Windows equivalent for home resolution and its sandbox setup.
  "TMPDIR", // POSIX test scratch and the host run's private temp root.
  "TMP", // Windows OS scratch directory fallback.
  "TEMP", // Windows primary OS scratch directory.
  "SYSTEMROOT", // Windows system executable/DLL resolution for real child processes.
  "WINDIR", // Windows system executable directory fallback.
  "COMSPEC", // Windows command interpreter used by shell/process tests.
  "PATHEXT", // Windows command extension resolution used by executable discovery.
  "CI", // suite concurrency/integration timeout behavior explicitly tested/read in source.
  "NODE_ENV", // Vitest/React test behavior; overwrite to literal `test`, never preserve production mode.
  "VITEST", // production's test-only gating and Vitest worker identity.
  "VITEST_MODE", // installed runner's run/watch behavior.
  "VITEST_POOL_ID", // installed runner's per-pool worker identity.
  "VITEST_WORKER_ID", // installed runner's per-task worker identity.
  "HOST_MEASUREMENT_FULL", // nightly measurement workflow's explicit full-scale switch.
  "TRAYCER_RUN_REAL_SUPERVISOR_MACOS", // real-supervisor workflow's explicit launchd integration switch.
  "TRAYCER_REQUIRE_LAYER0", // explicit internal runner's requirement for a packaged host fixture.
]);

// Vitest supplies SSR for the current node/jsdom environment before setup.
const serverRendering = process.env.SSR === "1";

for (const name of Object.keys(process.env)) {
  const canonical = process.platform === "win32" ? name.toUpperCase() : name;
  if (!allowed.has(canonical)) delete process.env[name];
}
// A developer's production mode must never enable deployed-only behavior.
process.env.NODE_ENV = "test";
// Both Vitest versions implement import.meta.env through process.env. Rebuild
// test mode from literals rather than retaining values from the login shell.
process.env.MODE = "test";
process.env.DEV = "1";
process.env.PROD = "";
process.env.BASE_URL = "/";
process.env.SSR = serverRendering ? "1" : "";
