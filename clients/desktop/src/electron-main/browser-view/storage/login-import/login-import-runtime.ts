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

/**
 * The jar coordination the IPC layer owns and the import borrows: the one
 * `BrowserJarSerializer` every jar mutation goes through.
 */
export interface LoginImportJarCoordination {
  /**
   * `BrowserJarSerializer.runOnEveryDomain` with the import's own budget -
   * the whole-jar barrier, whose abort signal the write loop reads between
   * rows so an import the barrier gave up on stops before queued work runs.
   */
  readonly serializeJarWrite: <T>(
    action: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
  /**
   * The localStorage half of a site clear on the durable jar, plus the
   * capture coordinator's prune for the site - what the IPC layer's own
   * site clear does after its cookie half, borrowed so a site the import
   * writes does not keep the previous account's localStorage. Reads the
   * barrier's signal between origins.
   */
  readonly clearSiteLocalStorage: (
    site: string,
    signal: AbortSignal,
  ) => Promise<void>;
  /**
   * `BrowserSessionsRegistry.capturePrimaryProfileOnEveryHost`: the jar
   * pushed to every host, made by the import inside its barrier. Answers the
   * hosts that acked; never rejects.
   */
  readonly pushJarToHosts: () => Promise<number>;
}

/**
 * How long the import may hold the whole-jar barrier. Far above what a large
 * profile needs (the source read, then thousands of `cookies.set` calls take
 * seconds, plus the settle window) AND the keystore prompt, which is taken
 * inside the barrier like the read - the barrier is held from the user's
 * confirmation on - and can hold the user for a couple of minutes - because
 * expiry is not a
 * soft limit here: the serializer aborts the write and admits the queued jar
 * work, and the import answers `incomplete` for a jar it only partly wrote
 * (the serializer lets the import settle within its grace and hands that
 * answer up, rather than rejecting the caller the moment the timer fires).
 */
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
