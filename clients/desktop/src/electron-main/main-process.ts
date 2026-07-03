import { app } from "electron";
import { DESKTOP_APP_NAME } from "../config";
import { initLogger, log } from "./app/logger";
import { runDesktopStartup } from "./startup/desktop-startup";
import { RESOLUTION_TEST_USER_DATA_DIR_ENV } from "./windows/resolution-test-env";

// Electron keys both the single-instance lock and the entire userData directory
// off the app name. Set the per-environment name BEFORE requesting the lock (and
// before any userData access) so each build gets its own lock + state and can
// coexist with a sibling install instead of stealing its lock and silently
// `app.quit()`ing on launch. dev → "Traycer Dev", production → "Traycer" (the
// internal build adds "Traycer Staging"). The name is read from `config` so the
// per-slot value is stamped at build time by the deploy script, never hardcoded
// here.
app.setName(DESKTOP_APP_NAME);
const resolutionTestUserDataDir =
  process.env[RESOLUTION_TEST_USER_DATA_DIR_ENV] ?? null;
if (
  resolutionTestUserDataDir !== null &&
  resolutionTestUserDataDir.length > 0
) {
  app.setPath("userData", resolutionTestUserDataDir);
}

// Single-instance lock applies uniformly so deep links and dock relaunches
// target the primary process. With the dev userData split above, a
// `make dev-desktop` shell and a packaged Traycer.app hold separate locks.
//
// All boot logic lives in the phased orchestrator (`startup/desktop-startup`):
// pre-ready → on-ready → window (auth-first) → deferred. The desktop performs
// no host/service registration at boot - the CLI owns the host lifecycle
// and the renderer provisions it post-sign-in via the `host ensure` IPC.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  initLogger();
  log.info("[desktop] single-instance lock unavailable - quitting");
  app.quit();
} else {
  void runDesktopStartup().catch((err) => {
    log.error("[desktop] fatal startup error", err);
  });
}
