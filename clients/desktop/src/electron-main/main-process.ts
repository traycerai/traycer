import { app } from "electron";
import { join } from "node:path";
import { config, DESKTOP_APP_NAME } from "../config";
import { initLogger, log } from "./app/logger";
import { resolveDesktopRuntimeIdentity } from "./dev-desktop-runtime";
import { runDesktopStartup } from "./startup/desktop-startup";
import { RESOLUTION_TEST_USER_DATA_DIR_ENV } from "./windows/resolution-test-env";

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
