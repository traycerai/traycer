// Destructive "wipe all gui-app persisted state" utility.
//
// Bridge-agnostic by design: it takes the host `clear` RPC as a parameter so it
// is unit-testable without React context. The caller (the settings panel / a
// later ticket) resolves the desktop bridge, capability-probes the host `clear`
// RPC, and passes it in. The util only orchestrates the destructive sequence:
//
//   1. Drain + clear           — first drain any pending debounced projection
//      push (so the unload-time flush can't resurrect the snapshot we're about
//      to clear), then run the authoritative host `clear` RPC. On a shell
//      without the RPC the drain IS the degraded fallback; in web mode the
//      caller passes `null` and the flush no-ops.
//   2. Blanket-prefix sweep    — remove every `traycer-gui-app:`-prefixed key
//      from BOTH localStorage and sessionStorage. Auth (`traycer.`) and any
//      non-`traycer-gui-app:` key survive.
//   3. Drop composer blob dbs  — delete every per-window landing-image
//      partition and the app-global prompt-stash database so pasted/stashed
//      image bytes don't outlive the wipe. Enumeration is Chromium-only;
//      absent → no-op.
//   4. Reload last             — re-hydrate from the now-cleared storage / host
//      state without racing a pending write.

import { PERSIST_PREFIX } from "@/lib/persist/keys";
import { flushActiveDesktopPerWindowProjection } from "@/lib/windows/per-window-projection-debounce";
import { drainDesktopTabsPersistence } from "@/stores/tabs/desktop-tabs-persistence";
import { appLogger, describeLogError } from "@/lib/logger";
import { PROMPT_STASH_DB_NAME } from "@/lib/composer/prompt-stash-repository";
import { publishPromptStashReset } from "@/lib/composer/prompt-stash-channel";

// The `:` boundary is load-bearing: a bare `startsWith(PERSIST_PREFIX)` would
// also sweep a hypothetical `traycer-gui-appX:foo` key. Anchoring on the colon
// keeps the sweep to exactly the `traycer-gui-app:` namespace.
const PERSIST_KEY_BOUNDARY = `${PERSIST_PREFIX}:`;

// Landing-image IndexedDB databases are named
// `traycer-gui-app:<partition>:landing-images` (one per runtime partition —
// `landingImagePartition()` in `lib/composer/landing-image-store.ts`). The
// suffix below pins the db namespace so the wipe only drops image partitions,
// never any other future `traycer-gui-app:`-prefixed db.
const LANDING_IMAGE_DB_SUFFIX = ":landing-images";
const PROMPT_STASH_DB_SUFFIX = ":prompt-stash";

function sweepStorage(storage: Storage): number {
  // Collect keys first, then remove: mutating during index iteration shifts the
  // remaining indices and would skip keys.
  const keysToRemove: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null && key.startsWith(PERSIST_KEY_BOUNDARY)) {
      keysToRemove.push(key);
    }
  }
  for (const key of keysToRemove) {
    storage.removeItem(key);
  }
  return keysToRemove.length;
}

// Wrap `indexedDB.deleteDatabase` (an async `IDBOpenDBRequest`) in a promise
// that settles on `onsuccess`/`onerror`/`onblocked`. `onblocked` fires when an
// open connection still holds the db; we resolve (not reject) so one stuck
// partition can't abort the rest of the wipe or the reload — the reload below
// tears down every connection anyway. `onerror` rejects to surface a genuine
// deletion failure; the sole caller treats deletion as best-effort (catches per
// db) so an erroring partition still can't abort the reload.
function deleteDatabaseAwaitable(
  factory: IDBFactory,
  name: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onblocked = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error(`deleteDatabase failed: ${name}`));
  });
}

// Read `indexedDB` through `globalThis` so a runtime where it is undeclared
// (e.g. a node test env) yields `undefined` instead of a `ReferenceError`. The
// annotated return type is load-bearing: the DOM lib declares `indexedDB`
// non-nullable, so without it TS would narrow the value and flag the guard's
// optional chain as unnecessary — but a non-Chromium / node runtime really can
// lack it.
function indexedDBFactory(): IDBFactory | undefined {
  return globalThis.indexedDB;
}

// Landing-image partition names are per-window/runtime and only discoverable
// through enumeration; `indexedDB.databases()` is Chromium-only, so on an
// engine without it those names simply can't be found - an accepted leak
// (the bytes are re-pasteable), not a wipe failure.
async function enumeratedComposerBlobDatabaseNames(
  factory: IDBFactory,
): Promise<readonly string[]> {
  if (typeof factory.databases !== "function") {
    appLogger.info(
      "[persist] composer blob database enumeration unavailable",
      {},
    );
    return [];
  }
  let databases: readonly IDBDatabaseInfo[];
  try {
    databases = await factory.databases();
  } catch (error: unknown) {
    appLogger.warn("[persist] composer blob database enumeration failed", {
      error: describeLogError(error),
    });
    return [];
  }
  return databases
    .map((db) => db.name)
    .filter(
      (name): name is string =>
        name !== undefined &&
        name.startsWith(PERSIST_KEY_BOUNDARY) &&
        (name.endsWith(LANDING_IMAGE_DB_SUFFIX) ||
          name.endsWith(PROMPT_STASH_DB_SUFFIX)),
    );
}

// Drop every landing-image partition this run can enumerate, plus the
// prompt-stash database unconditionally by its exact, fixed name - unlike
// the per-window landing partitions, the stash has exactly one name known
// ahead of time, so its deletion never depends on `databases()` support.
// `indexedDB` itself absent (e.g. a non-browser runtime) still no-ops the
// whole thing so the wipe reaches the reload.
async function deleteComposerBlobDatabases(): Promise<boolean> {
  const factory = indexedDBFactory();
  if (factory === undefined) {
    appLogger.info("[persist] composer blob database delete unavailable", {
      reason: "no IndexedDB in this runtime",
    });
    return false;
  }
  const enumerated = await enumeratedComposerBlobDatabaseNames(factory);
  const names = new Set(enumerated);
  names.add(PROMPT_STASH_DB_NAME);
  // Best-effort per partition: a single db whose delete errors must not abort
  // the rest of the wipe or - critically - the reload (step 4), which is the
  // real recovery and tears down every connection anyway. The bytes are
  // re-pasteable (landing) or already gone from the user's perspective
  // (stash, whose entries the localStorage sweep never touched but whose
  // db this same step is the only thing that reclaims).
  let failedCount = 0;
  let promptStashDeleted = true;
  await Promise.all(
    Array.from(names).map((name) =>
      deleteDatabaseAwaitable(factory, name).catch((error: unknown) => {
        failedCount += 1;
        if (name === PROMPT_STASH_DB_NAME) promptStashDeleted = false;
        appLogger.warn("[persist] composer blob database delete failed", {
          error: describeLogError(error),
        });
      }),
    ),
  );
  appLogger.info("[persist] composer blob database delete complete", {
    databaseCount: names.size,
    failedCount,
  });
  return promptStashDeleted;
}

export async function clearAllPersistedStores(args: {
  hostClear: (() => Promise<void>) | null;
}): Promise<void> {
  appLogger.info("[persist] clearing local GUI state", {
    hasHostClear: args.hostClear !== null,
  });
  // 1. Drain any pending debounced projection push FIRST. This flushes it to
  //    the host and clears `pendingPatch`, so the beforeunload/pagehide flush
  //    fired during the reload below can't re-push pre-wipe state and re-create
  //    the snapshot we're about to clear.
  await flushActiveDesktopPerWindowProjection();
  await drainDesktopTabsPersistence().catch((error: unknown) => {
    // The wipe continues either way, but this is the only signal that the
    // pre-wipe drain failed - every other failure path here logs too.
    appLogger.warn("[persist] tabs persistence drain failed", {
      error: describeLogError(error),
    });
  });
  // Then the authoritative host clear when the RPC exists. On a shell without
  // it (older preload) the drain above is the degraded fallback; in web mode
  // `hostClear` is null and there is nothing host-side to clear.
  if (args.hostClear !== null) {
    try {
      await args.hostClear();
    } catch (error) {
      appLogger.warn("[persist] host-side state clear failed", {
        error: describeLogError(error),
      });
      throw error;
    }
  } else {
    appLogger.info("[persist] host-side state clear unavailable", {});
  }

  // 2. Blanket-prefix sweep across BOTH storages.
  const localStorageCount = sweepStorage(window.localStorage);
  const sessionStorageCount = sweepStorage(window.sessionStorage);
  appLogger.info("[persist] browser storage sweep complete", {
    localStorageCount,
    sessionStorageCount,
  });

  // 3. Drop every composer-owned IndexedDB blob database.
  //    The localStorage sweep above already removed the draft keys that point
  //    at these bytes; this reclaims the bytes themselves so nothing leaks past
  //    the wipe.
  const promptStashDeleted = await deleteComposerBlobDatabases();
  if (promptStashDeleted) publishPromptStashReset();

  // 4. Reload last.
  appLogger.info("[persist] local GUI state clear complete - reloading", {});
  window.location.reload();
}
