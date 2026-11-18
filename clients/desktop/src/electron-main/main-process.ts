// Must stay the first import, ahead of anything that can open a connection:
// without it a reset loopback connection throws out of Node's HTTP client as
// an uncaught exception (traycerai/traycer#2093), and the main process probes
// the local host over exactly that kind of connection.
import "@traycer-clients/shared/platform/install-socket-tos-guard";
import { app, dialog } from "electron";
import { join } from "node:path";
import {
  currentDataRootResolution,
  DataRootError,
} from "@traycer/protocol/config/data-root";
import { config, DESKTOP_APP_NAME } from "../config";
import { initLogger, log } from "./app/logger";
import { resolveDesktopRuntimeIdentity } from "./dev-desktop-runtime";
import { runDesktopStartup } from "./startup/desktop-startup";
import { RESOLUTION_TEST_USER_DATA_DIR_ENV } from "./windows/resolution-test-env";

// Electron keys both the single-instance lock and the entire userData directory
// off the app name/userData path. Set identity BEFORE requesting the lock (and
// before any userData access) so each build/run gets its own lock + Electron
// runtime state. Production/staging/no-slot dev keep their stamped app name;
// multi-run dev adds a slot suffix without changing `config.environment`.
const runtimeIdentity = resolveDesktopRuntimeIdentity(
  DESKTOP_APP_NAME,
  config.environment,
  process.env,
);
app.setName(runtimeIdentity.appName);
if (runtimeIdentity.userDataDirName !== null) {
  app.setPath(
    "userData",
    join(app.getPath("appData"), runtimeIdentity.userDataDirName),
  );
}
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
const dataRootFailure = gotLock ? unavailableDataRoot() : null;
if (!gotLock) {
  initLogger();
  log.info("[desktop] single-instance lock unavailable - quitting");
  app.quit();
} else if (dataRootFailure !== null) {
  // A selected data folder that cannot be used stops the app before anything
  // derives a Traycer path: no fallback to the default folder, which would
  // start a second, empty installation beside the user's data.
  initLogger();
  log.error("[desktop] data root unavailable - quitting", {
    code: dataRootFailure.code,
  });
  dialog.showErrorBox(
    "Traycer cannot open its data folder",
    `${dataRootFailure.message}\n\nRun \`traycer data status\` in a terminal for details.`,
  );
  app.exit(1);
} else {
  void runDesktopStartup().catch((err) => {
    log.error("[desktop] fatal startup error", err);
  });
}

/**
 * Resolves the Traycer data root once, up front, and returns the failure
 * when the persisted location record cannot be used. Any other error is a
 * defect and propagates.
 */
function unavailableDataRoot(): DataRootError | null {
  try {
    currentDataRootResolution();
    return null;
  } catch (error) {
    if (error instanceof DataRootError) return error;
    throw error;
  }
}
