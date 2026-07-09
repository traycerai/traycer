/**
 * Wire constants shared between the main-process snapshot owner
 * (`dev-shared-local-storage.ts`) and the standalone dev-seed preload
 * (`electron-preload/dev/dev-shared-local-storage-seed-preload.ts`), which
 * builds as its own esbuild entry point and cannot import main-only modules.
 * Kept free of `electron`/`node:*` imports so both bundles can pull it in
 * without pulling in the other side's runtime surface.
 */

export const DEV_SHARED_LOCAL_STORAGE_SYNC_CHANNEL =
  "devSharedLocalStorage:sync:snapshot";

// Written into the renderer's own localStorage once a fresh slot profile has
// been seeded. Marks "seeded", not "storage non-empty" - `clearAllPersistedStores`
// (gui-app's wipe utility) sweeps every `traycer-gui-app:` key and reloads, and
// keying seeding off emptiness would resurrect the pre-wipe snapshot on that
// reload. The marker survives the wipe (its key isn't `traycer-gui-app:`-prefixed
// and auth keys are explicitly spared too), so a wiped profile stays wiped.
export const DEV_SHARED_LOCAL_STORAGE_SEEDED_MARKER_KEY =
  "traycer-desktop:dev-seeded";

export const DEV_SHARED_LOCAL_STORAGE_ENVELOPE_VERSION = 1;
