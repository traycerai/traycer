import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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
// The platform app-dir env family short-circuits homedir()-based
// resolution: electron-log's Linux logs path is `XDG_CONFIG_HOME ||
// ~/.config` and its Windows path is `APPDATA || ~\AppData\Roaming`, and
// GitHub's ubuntu runners EXPORT XDG_CONFIG_HOME - so without re-pointing
// these, the sandbox leaks back to the real home exactly where CI runs.
process.env.XDG_CONFIG_HOME = join(baselineHome, ".config");
process.env.XDG_DATA_HOME = join(baselineHome, ".local", "share");
process.env.XDG_STATE_HOME = join(baselineHome, ".local", "state");
process.env.XDG_CACHE_HOME = join(baselineHome, ".cache");
if (process.platform === "win32") {
  process.env.APPDATA = join(baselineHome, "AppData", "Roaming");
  process.env.LOCALAPPDATA = join(baselineHome, "AppData", "Local");
}

(os as { homedir: () => string }).homedir = () =>
  (process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME) ??
  baselineHome;
// vite-node-transformed modules (every first-party file and test) read the
// property off the module object at import time, so they see the patch
// without this. But an UNTRANSFORMED dependency running as real Node ESM
// holds static named bindings (`import { homedir } from "node:os"`) that
// only re-sync with the module object when this is called. One call
// suffices: the installed function is a closure over the env, so its
// identity never changes again.
syncBuiltinESMExports();

afterAll(() => {
  rmSync(baselineHome, { recursive: true, force: true });
});
