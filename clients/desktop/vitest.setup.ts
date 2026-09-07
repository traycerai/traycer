import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Per-worker temp HOME so suites that never touch HOME are sandboxed too.

const baselineHome = mkdtempSync(
  join(os.tmpdir(), "traycer-desktop-tests-home-"),
);
process.env.HOME = baselineHome;
process.env.USERPROFILE = baselineHome;
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
// One call suffices: the installed function is a closure over the env, so its identity never changes again.
syncBuiltinESMExports();

afterAll(() => {
  rmSync(baselineHome, { recursive: true, force: true });
});
