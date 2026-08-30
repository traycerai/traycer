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

/**
 * "Forget all browser logins" (spec §6.5, ticket 08), the desktop half. The
 * host has already crypto-shredded its slice for this user by the time
 * `primaryProfileForgotten` arrives; what is left is this machine's own copy.
 *
 * Same shape as the migration above, and for the same reason: every step is
 * injected, so the order - which is the whole correctness argument - can be
 * asserted without Electron.
 *
 * 1. Everything runs inside `suppressDeltas`. Clearing the jar fires a removal
 *    event for every cookie in it; those deltas would arrive at a host that has
 *    already forgotten the user and re-create an entry for the identity just
 *    destroyed.
 * 2. The localStorage coordinator is reset before the tiles come back, so a
 *    recreated tile cannot be re-seeded from an origin remembered pre-forget.
 * 3. Tiles are recreated last, at their current URLs, through the same handoff
 *    path the enable-time migration uses - which skips `isolated` guests, whose
 *    private jar has nothing to do with the identity being forgotten.
 */
export interface BrowserForgetLoginsDependencies {
  /** Mutes every domain's deltas for the whole routine. */
  readonly suppressDeltas: <T>(action: () => Promise<T>) => Promise<T>;
  /**
   * The durable `primary` jar, or `null` where this process never opened one.
   * Null is the ordinary answer on a machine with saved logins turned off, and
   * it must stay a no-op: opening that partition here would be the first thing
   * to touch the OS keystore.
   */
  readonly readPersistentSession: () => BrowserForgettableStorageSession | null;
  /** Drops the remembered localStorage origins (the snapshot coordinator). */
  readonly resetLocalStorageSnapshots: () => void;
  /** `BrowserViewManager.migrateNativeTabsForPersistence`, reused verbatim. */
  readonly recreateTabs: () => Promise<readonly string[]>;
}

/** The one destructive call forget-all makes on the durable jar. */
export interface BrowserForgettableStorageSession {
  clearStorageData(): Promise<void>;
}

export interface BrowserForgetLoginsResult {
  readonly partitionCleared: boolean;
  readonly tabsRecreated: number;
}

export async function forgetBrowserPersistentLogins(
  dependencies: BrowserForgetLoginsDependencies,
): Promise<BrowserForgetLoginsResult> {
  const result = await dependencies.suppressDeltas(async () => {
    const partitionCleared = await clearPersistentJar(dependencies);
    dependencies.resetLocalStorageSnapshots();
    const recreatedGuestKeys = await dependencies.recreateTabs();
    return { partitionCleared, tabsRecreated: recreatedGuestKeys.length };
  });
  log.info("[browser-view] forgot the saved browser logins", result);
  return result;
}

async function clearPersistentJar(
  dependencies: BrowserForgetLoginsDependencies,
): Promise<boolean> {
  const persistent = dependencies.readPersistentSession();
  if (persistent === null) return false;
  try {
    await persistent.clearStorageData();
    return true;
  } catch (error) {
    // The tiles still have to be recreated: they are sitting on a jar the host
    // no longer holds a key for, and leaving them there is the worse failure.
    log.warn("[browser-view] persistent session clear failed", {
      error: describeLogError(error),
    });
    return false;
  }
}
