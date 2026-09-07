// Destructive "wipe all gui-app persisted state" utility.

import { PERSIST_PREFIX } from "@/lib/persist/keys";
import { flushActiveDesktopPerWindowProjection } from "@/lib/windows/per-window-projection-debounce";
import { drainDesktopTabsPersistence } from "@/stores/tabs/desktop-tabs-persistence";
import { appLogger, describeLogError } from "@/lib/logger";
import { FILE_EDIT_RECOVERY_DB_SUFFIX } from "@/lib/workspace/file-edit-recovery-store";
import { fileEditRuntimeRegistry } from "@/lib/workspace/file-edit-runtime-registry";
import { PROMPT_STASH_DB_NAME } from "@/lib/composer/prompt-stash-repository";
import { publishPromptStashReset } from "@/lib/composer/prompt-stash-channel";

// The `:` boundary is load-bearing: a bare `startsWith(PERSIST_PREFIX)` would also sweep a hypothetical `traycer-gui-appX:foo` key.
// Anchoring on the colon keeps the sweep to exactly the `traycer-gui-app:` namespace.
const PERSIST_KEY_BOUNDARY = `${PERSIST_PREFIX}:`;

// Landing-image IndexedDB databases are named `traycer-gui-app:<partition>:landing-images` (one per runtime partition - `landingImagePartition()` in `lib/composer/landing-image-store.ts`).
const LANDING_IMAGE_DB_SUFFIX = ":landing-images";
const PROMPT_STASH_DB_SUFFIX = ":prompt-stash";
const RENDERER_DB_SUFFIXES = [
  LANDING_IMAGE_DB_SUFFIX,
  FILE_EDIT_RECOVERY_DB_SUFFIX,
  PROMPT_STASH_DB_SUFFIX,
] as const;

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

// Wrap `indexedDB.deleteDatabase` (an async `IDBOpenDBRequest`) in a promise that settles on `onsuccess`/`onerror`/`onblocked`.
// `onblocked` fires when an open connection still holds the db; we resolve (not reject) so one stuck partition can't abort the rest of the wipe or the reload - the reload below tears down every connection anyway.
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

// Read `indexedDB` through `globalThis` so a runtime where it is undeclared (e.g. a node test env) yields `undefined` instead of a `ReferenceError`.
// The annotated return type is load-bearing: the DOM lib declares `indexedDB` non-nullable, so without it TS would narrow the value and flag the guard's optional chain as unnecessary - but a non-Chromium / node runtime really can lack it.
function indexedDBFactory(): IDBFactory | undefined {
  return globalThis.indexedDB;
}

// Renderer db partition names (landing-image, file-edit-recovery) are per-window/runtime and only discoverable through enumeration; `indexedDB.databases()` is Chromium-only, so on an engine without it those names simply can't be found - an accepted leak (the.
async function enumeratedRendererDatabaseNames(
  factory: IDBFactory,
): Promise<readonly string[]> {
  if (typeof factory.databases !== "function") {
    appLogger.info("[persist] renderer database enumeration unavailable", {});
    return [];
  }
  let databases: readonly IDBDatabaseInfo[];
  try {
    databases = await factory.databases();
  } catch (error: unknown) {
    appLogger.warn("[persist] renderer database enumeration failed", {
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
        RENDERER_DB_SUFFIXES.some((suffix) => name.endsWith(suffix)),
    );
}

// Drop every landing-image and file-edit-recovery partition this run can enumerate, plus the prompt-stash database unconditionally by its exact, fixed name - unlike the per-window partitions, the stash has exactly one name known ahead of time, so its.
async function deleteRendererDatabases(): Promise<boolean> {
  const factory = indexedDBFactory();
  if (factory === undefined) {
    appLogger.info("[persist] renderer database delete unavailable", {
      reason: "no IndexedDB in this runtime",
    });
    return false;
  }
  const enumerated = await enumeratedRendererDatabaseNames(factory);
  const names = new Set(enumerated);
  names.add(PROMPT_STASH_DB_NAME);
  // Best-effort per partition: a single db whose delete errors must not abort the rest of the wipe or - critically - the reload (step 4), which is the real recovery and tears down every connection anyway.
  let failedCount = 0;
  let promptStashDeleted = true;
  await Promise.all(
    Array.from(names).map((name) =>
      deleteDatabaseAwaitable(factory, name).catch((error: unknown) => {
        failedCount += 1;
        if (name === PROMPT_STASH_DB_NAME) promptStashDeleted = false;
        appLogger.warn("[persist] renderer database delete failed", {
          error: describeLogError(error),
        });
      }),
    ),
  );
  appLogger.info("[persist] renderer database delete complete", {
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
  await flushActiveDesktopPerWindowProjection();
  await drainDesktopTabsPersistence().catch((error: unknown) => {
    // The wipe continues either way, but this is the only signal that the
    // pre-wipe drain failed - every other failure path here logs too.
    appLogger.warn("[persist] tabs persistence drain failed", {
      error: describeLogError(error),
    });
  });
  // Then the authoritative host clear when the RPC exists.
  // On a shell without it (older preload) the drain above is the degraded fallback; in web mode `hostClear` is null and there is nothing host-side to clear.
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

  // Stop edit timers before deleting their journal (step 3 below).
  // Deferred until after the failure-prone host clear above: if `hostClear` rejects, this function aborts before ever reaching here, so the still-mounted file-editor hooks keep pointing at live (not disposed) runtimes and in-place editing keeps working without.
  await fileEditRuntimeRegistry.teardown();

  // 2. Blanket-prefix sweep across BOTH storages.
  const localStorageCount = sweepStorage(window.localStorage);
  const sessionStorageCount = sweepStorage(window.sessionStorage);
  appLogger.info("[persist] browser storage sweep complete", {
    localStorageCount,
    sessionStorageCount,
  });

  const promptStashDeleted = await deleteRendererDatabases();
  if (promptStashDeleted) publishPromptStashReset();

  // 4. Reload last.
  appLogger.info("[persist] local GUI state clear complete - reloading", {});
  window.location.reload();
}
