import { ipcRenderer } from "electron";
import { devRendererOriginFromEnv } from "../../ipc-contracts/dev-renderer-origin";
import {
  DEV_SHARED_LOCAL_STORAGE_SEEDED_MARKER_KEY,
  DEV_SHARED_LOCAL_STORAGE_SYNC_CHANNEL,
} from "../../electron-main/dev/dev-shared-local-storage-protocol";

/**
 * Standalone dev-only preload, registered by `dev-shared-local-storage.ts`
 * via `session.registerPreloadScript` (not the product `webPreferences.preload`
 * bridge), so it runs before any page script on every frame - including the
 * gui-app module-load-time reads in `theme-applier.ts` and the auth bootstrap.
 * Bundled as its own esbuild entry (see scripts/build-main-bundle.cjs); only
 * ever registered when a `DEV_DESKTOP_SLOT` is active.
 *
 * Session-level `registerPreloadScript({type: "frame"})` runs this in EVERY
 * frame, not just the top-level dev renderer window - restrict seeding to the
 * main frame of the expected dev renderer origin so an unrelated frame (e.g.
 * a future script-capable embedded preview) never gets the whole-store
 * snapshot written into its own origin's localStorage.
 */
if (
  process.isMainFrame &&
  window.location.origin === devRendererOriginFromEnv(process.env) &&
  window.localStorage.getItem(DEV_SHARED_LOCAL_STORAGE_SEEDED_MARKER_KEY) ===
    null
) {
  const snapshot: unknown = ipcRenderer.sendSync(
    DEV_SHARED_LOCAL_STORAGE_SYNC_CHANNEL,
  );
  if (snapshot !== null && typeof snapshot === "object") {
    for (const [key, value] of Object.entries(
      snapshot as Record<string, unknown>,
    )) {
      if (typeof value === "string") {
        window.localStorage.setItem(key, value);
      }
    }
  }
  window.localStorage.setItem(DEV_SHARED_LOCAL_STORAGE_SEEDED_MARKER_KEY, "1");
}
