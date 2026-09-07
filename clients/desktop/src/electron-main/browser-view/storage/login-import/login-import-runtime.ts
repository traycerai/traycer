import { app } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import { LOGIN_IMPORT_BROWSER_LABELS } from "@traycer-clients/shared/platform/browser-view";
import { confirmDestructiveInMain } from "../../../app/confirm-destructive";
import {
  BROWSER_VIEW_PARTITION,
  ensureBrowserViewSessionForPartition,
  forgetBrowserPrimaryProfileAppliedKeys,
  suppressAllBrowserPrimaryProfileDeltas,
} from "../../browser-session";
import { BROWSER_COOKIE_DELTA_WINDOW_MS } from "../browser-cookie-change-observer";
import {
  deferBrowserForgetLedgerNotifications,
  markBrowserForgetLedgerClearedMany,
  recordForgottenBrowserSites,
  releaseHeadlessOriginCookieKeys,
} from "../browser-forget-ledger";
import { isBrowserSavedLoginsEnabled } from "../browser-saved-logins";
import { LoginImportService } from "./import-logins";
import { unprotectChromiumWindowsKey } from "./secret-providers/dpapi-windows";
import { readMacosKeychainPassphrase } from "./secret-providers/keychain-macos";
import { runCommand } from "./secret-providers/run-command";
import { readLinuxSecretServicePassphrase } from "./secret-providers/secret-service-linux";

/** Snapshot copies of source jars live here, `0700`, swept on every use. */
const SNAPSHOT_DIRECTORY_NAME = "login-import-snapshots";

export interface LoginImportJarCoordination {
  readonly serializeJarWrite: <T>(
    action: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
  readonly clearSiteLocalStorage: (
    site: string,
    signal: AbortSignal,
  ) => Promise<void>;
  /** Answers the hosts that acked; never rejects. */
  readonly pushJarToHosts: () => Promise<number>;
}

export const LOGIN_IMPORT_JAR_BARRIER_TIMEOUT_MS = 10 * 60_000;

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
    clearSiteLocalStorage: jar.clearSiteLocalStorage,
    // The site clear's own ledger entry, per site as the import reaches its
    // removals, the streams told once when the write ends, and the same
    // "cleared" mark for every revision once the writes have ended.
    recordReplacedSite: (site) => recordForgottenBrowserSites([site]),
    markReplacementCleared: markBrowserForgetLedgerClearedMany,
    deferLedgerDigests: deferBrowserForgetLedgerNotifications,
    pushJarToHosts: jar.pushJarToHosts,
    // The same native dialog forget-all and a site clear go through: the
    // copy names the registered source and the validated count, and Cancel
    // is the default, so a raced or dismissed dialog refuses.
    confirmImport: (summary) => {
      const browser = LOGIN_IMPORT_BROWSER_LABELS[summary.browser];
      const sites =
        summary.siteCount === 1 ? "1 site" : `${summary.siteCount} sites`;
      return confirmDestructiveInMain({
        title: "Import logins?",
        message: `Import the logins for ${sites} from ${browser} (${summary.profileLabel})?`,
        detail:
          "Any login Traycer already saved for those sites is replaced by the one from that profile, on this machine and on every host that syncs your browser logins.",
        confirmLabel: "Import",
      });
    },
    suppressDeltas: suppressAllBrowserPrimaryProfileDeltas,
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
