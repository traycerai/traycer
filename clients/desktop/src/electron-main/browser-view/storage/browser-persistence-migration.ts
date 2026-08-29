import type { BrowserStorageState } from "@traycer/protocol/host/browser/contracts";
import { describeLogError, log } from "../../app/logger";
import {
  browserStorageStateFromCookies,
  type BrowserStorageSeedWebContents,
  type BrowserStorageSession,
} from "./browser-storage-state";

/**
 * Late enable: the user browsed (and possibly signed in) on the in-memory jar,
 * then said yes to the keychain. Spec §6.4 is the whole contract - copy the
 * jar, recreate the tiles on the durable partition, then wipe what stayed
 * behind. Every step is injected so the order can be asserted without Electron.
 */

/** The ephemeral jar plus the one destructive call this module makes on it. */
export interface BrowserEphemeralStorageSession extends BrowserStorageSession {
  clearStorageData(): Promise<void>;
}

export interface BrowserPersistenceMigrationDependencies {
  /** The in-memory jar every pre-enable tile has been writing to. */
  readonly readEphemeralSession: () => BrowserEphemeralStorageSession;
  /** The `persist:` jar, created by the caller once the probe succeeded. */
  readonly readPersistentSession: () => BrowserStorageSession;
  /** The validated seed path (`seedBrowserViewCookies`), never a raw loop. */
  readonly seedCookies: (
    storageState: BrowserStorageState | null,
    target: BrowserStorageSeedWebContents,
  ) => Promise<void>;
  /**
   * Destroys and recreates every live tile at its current URL, returning the
   * guest keys it moved (`BrowserViewManager.migrateNativeTabsForPersistence`).
   */
  readonly recreateTabs: () => Promise<readonly string[]>;
}

export interface BrowserPersistenceMigrationResult {
  readonly cookiesCopied: number;
  readonly tabsRecreated: number;
  readonly ephemeralCleared: boolean;
}

export async function migrateBrowserPersistenceToPersistentPartition(
  dependencies: BrowserPersistenceMigrationDependencies,
): Promise<BrowserPersistenceMigrationResult> {
  const ephemeral = dependencies.readEphemeralSession();
  const persistent = dependencies.readPersistentSession();
  const cookiesCopied = await copyCookieJar(
    ephemeral,
    persistent,
    dependencies,
  );
  // Order matters: the tiles must come back on a jar that already holds the
  // logins, and nothing may be cleared until they no longer read from it.
  const migratedGuestKeys = await dependencies.recreateTabs();
  const ephemeralCleared = await clearEphemeralJar(ephemeral);
  const result: BrowserPersistenceMigrationResult = {
    cookiesCopied,
    tabsRecreated: migratedGuestKeys.length,
    ephemeralCleared,
  };
  log.info("[browser-view] browser persistence migration finished", result);
  return result;
}

async function copyCookieJar(
  ephemeral: BrowserStorageSession,
  persistent: BrowserStorageSession,
  dependencies: BrowserPersistenceMigrationDependencies,
): Promise<number> {
  try {
    await ephemeral.cookies.flushStore();
    const storageState = browserStorageStateFromCookies(
      await ephemeral.cookies.get({}),
    );
    await dependencies.seedCookies(storageState, { session: persistent });
    return storageState.cookies.length;
  } catch (error) {
    // A jar that would not copy is a lost login, not a lost browser: the
    // tiles still have to reach the durable partition, so the migration
    // continues and the user re-signs in.
    log.warn("[browser-view] persistence migration cookie copy failed", {
      error: describeLogError(error),
    });
    return 0;
  }
}

async function clearEphemeralJar(
  ephemeral: BrowserEphemeralStorageSession,
): Promise<boolean> {
  try {
    await ephemeral.clearStorageData();
    return true;
  } catch (error) {
    log.warn("[browser-view] ephemeral session clear failed", {
      error: describeLogError(error),
    });
    return false;
  }
}
