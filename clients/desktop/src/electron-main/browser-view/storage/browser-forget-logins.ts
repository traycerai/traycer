import { describeLogError, log } from "../../app/logger";

/**
 * "Forget all browser logins" (spec §6.5, ticket 08), the desktop half. The
 * host has already crypto-shredded its slice for this user by the time
 * `primaryProfileForgotten` arrives; what is left is this machine's own copy.
 *
 * Every step is injected, so the order - which is the whole correctness
 * argument - can be asserted without Electron.
 *
 * 1. Everything runs inside `suppressDeltas`. Clearing the jar fires a removal
 *    event for every cookie in it; those deltas would arrive at a host that has
 *    already forgotten the user and re-create an entry for the identity just
 *    destroyed.
 * 2. The localStorage coordinator is reset before the tiles come back, so a
 *    recreated tile cannot be re-seeded from an origin remembered pre-forget.
 * 3. Tiles are recreated last, at their current URLs, through the same handoff
 *    path the saved-logins toggle uses - which skips `isolated` guests, whose
 *    private jar has nothing to do with the identity being forgotten.
 */
export interface BrowserForgetLoginsDependencies {
  /** Mutes every domain's deltas for the whole routine. */
  readonly suppressDeltas: <T>(action: () => Promise<T>) => Promise<T>;
  /**
   * The durable `primary` jar. The caller must have opened it *before* entering
   * `suppressDeltas`: the jar on disk outlives the pref, so forget-all has to
   * clear it even on a machine where saved logins are off or no tile was opened
   * this run - and opening it is also what installs the cookie observer that
   * `suppressDeltas` mutes. Open it later and the clear's removal deltas escape
   * unmuted to a host that has already shredded the slice.
   */
  readonly persistentSession: BrowserForgettableStorageSession;
  /** Drops the remembered localStorage origins (the snapshot coordinator). */
  readonly resetLocalStorageSnapshots: () => void;
  /** `BrowserViewManager.recreateNativeTabsOnCurrentPartition`. */
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
  try {
    await dependencies.persistentSession.clearStorageData();
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
