import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Sandbox the suite's notion of "home" at the `os` boundary, not the env var.
//
// `os.homedir()` under the Bun runtime resolves the REAL home even after
// `process.env.HOME` is reassigned mid-process (Bun caches the home at
// startup; Node re-reads the env on every call). Every suite here that
// sandboxes itself with `process.env.HOME = <tempdir>` in a `beforeEach`
// therefore escapes silently when vitest is executed on the Bun runtime
// (`bunx --bun vitest`, `bun node_modules/.bin/vitest`) - the production
// code under test writes its fixtures into the real `~`. That is not
// hypothetical: one escaped run overwrote the real
// `~/.traycer/cli/bin/traycer` with the `cli-bytes-v2` fixture (a dead CLI
// in the field on v1.1.9-rc.3, because launch-time reconcile then trusted
// the poisoned manifest) and another planted "Studio Mac" as the user's
// real host display name.
//
// Re-pointing `homedir` on the module object covers every consumer in the
// worker: `node:os` and `os` resolve to the same builtin instance, so
// first-party `import { homedir } from "node:os"` call sites and
// electron-log's internal `require("os")` (which is how its file transport
// finds `~/Library/Logs` - previously appending test noise to the REAL
// user log) all follow the env from here on, on every runtime.
//
// The baseline below points at a per-worker temp dir so suites that never
// touch HOME are sandboxed too. Suites that redirect HOME per test keep
// doing so through `sandboxHome()` (src/electron-main/__tests__/
// sandbox-home.ts), whose tripwire refuses to run the test when this file
// was never loaded to make the redirect effective - `bun test` (Bun's own
// runner) ignores vitest setup files entirely, so the tripwire is the
// backstop there.

const baselineHome = mkdtempSync(
  join(os.tmpdir(), "traycer-desktop-tests-home-"),
);
process.env.HOME = baselineHome;
process.env.USERPROFILE = baselineHome;

(os as { homedir: () => string }).homedir = () =>
  (process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME) ??
  baselineHome;

afterAll(() => {
  rmSync(baselineHome, { recursive: true, force: true });
});
