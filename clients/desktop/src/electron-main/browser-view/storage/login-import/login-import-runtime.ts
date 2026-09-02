import { app } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  BROWSER_VIEW_PARTITION,
  ensureBrowserViewSessionForPartition,
  suppressAllBrowserPrimaryProfileDeltas,
} from "../../browser-session";
import { BROWSER_COOKIE_DELTA_WINDOW_MS } from "../browser-cookie-change-observer";
import { isBrowserSavedLoginsEnabled } from "../browser-saved-logins";
import { LoginImportService } from "./import-logins";
import { unprotectChromiumWindowsKey } from "./secret-providers/dpapi-windows";
import { readMacosKeychainPassphrase } from "./secret-providers/keychain-macos";
import { runCommand } from "./secret-providers/run-command";
import { readLinuxSecretServicePassphrase } from "./secret-providers/secret-service-linux";

/** Snapshot copies of source jars live here, `0700`, swept on every use. */
const SNAPSHOT_DIRECTORY_NAME = "login-import-snapshots";

/** The service wired to Electron, the OS keystores, and the durable jar. */
export function createLoginImportService(): LoginImportService {
  return new LoginImportService({
    platform: process.platform,
    homeDir: homedir(),
    env: process.env,
    snapshotRoot: join(app.getPath("userData"), SNAPSHOT_DIRECTORY_NAME),
    readSaveLogins: isBrowserSavedLoginsEnabled,
    // The durable jar by name, bypassing the pref: the import refuses when
    // saving is off, and writing the ephemeral jar would never be right.
    getDurableSession: () =>
      ensureBrowserViewSessionForPartition(BROWSER_VIEW_PARTITION),
    suppressDeltas: suppressAllBrowserPrimaryProfileDeltas,
    settleWindowMs: BROWSER_COOKIE_DELTA_WINDOW_MS,
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
    secrets: {
      macosKeychain: (browser) =>
        readMacosKeychainPassphrase(browser, runCommand),
      linuxSecretService: (browser) =>
        readLinuxSecretServicePassphrase(browser, runCommand),
      windowsDpapi: (encryptedKey) =>
        unprotectChromiumWindowsKey(encryptedKey, runCommand),
    },
    now: () => Date.now(),
  });
}
