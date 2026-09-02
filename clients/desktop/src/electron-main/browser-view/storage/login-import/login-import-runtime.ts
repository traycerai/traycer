import { app } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  BROWSER_VIEW_PARTITION,
  ensureBrowserViewSessionForPartition,
  forgetBrowserPrimaryProfileAppliedKeys,
  suppressAllBrowserPrimaryProfileDeltas,
} from "../../browser-session";
import { BROWSER_COOKIE_DELTA_WINDOW_MS } from "../browser-cookie-change-observer";
import { releaseHeadlessOriginCookieKeys } from "../browser-forget-ledger";
import { isBrowserSavedLoginsEnabled } from "../browser-saved-logins";
import { LoginImportService } from "./import-logins";
import { unprotectChromiumWindowsKey } from "./secret-providers/dpapi-windows";
import { readMacosKeychainPassphrase } from "./secret-providers/keychain-macos";
import { runCommand } from "./secret-providers/run-command";
import { readLinuxSecretServicePassphrase } from "./secret-providers/secret-service-linux";

/** Snapshot copies of source jars live here, `0700`, swept on every use. */
const SNAPSHOT_DIRECTORY_NAME = "login-import-snapshots";

/**
 * The jar coordination the IPC layer owns and the import borrows: the one
 * `BrowserJarSerializer` every jar mutation goes through.
 */
export interface LoginImportJarCoordination {
  /** `BrowserJarSerializer.runOnEveryDomain` - the whole-jar barrier. */
  readonly serializeJarWrite: <T>(action: () => Promise<T>) => Promise<T>;
}

/** The service wired to Electron, the OS keystores, and the durable jar. */
export function createLoginImportService(
  jar: LoginImportJarCoordination,
): LoginImportService {
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
    serializeJarWrite: jar.serializeJarWrite,
    suppressDeltas: suppressAllBrowserPrimaryProfileDeltas,
    // What the change observer does for an ordinary local write, done by
    // hand because the observer is muted for this one: the applier's
    // pending marks for these keys first (no insert is coming to spend
    // them), then the durable ownership release.
    releaseHostOwnedKeys: async (keys) => {
      forgetBrowserPrimaryProfileAppliedKeys(keys);
      await releaseHeadlessOriginCookieKeys(keys);
    },
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
