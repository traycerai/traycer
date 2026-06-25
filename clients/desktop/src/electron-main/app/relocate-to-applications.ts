import { app, dialog } from "electron";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logger";

// A real CI release emits `app-update.yml` next to the app resources; dogfood
// `--dir` / `electron-builder --dir` staging installs never do. Without a feed
// this build can't auto-update at all, so there is nothing to relocate FOR -
// don't prompt or mark the location blocked. Mirrors `canCheckForUpdates` in
// updater.ts (kept sync here since it runs on the boot path).
function hasRealUpdateFeed(): boolean {
  return existsSync(join(process.resourcesPath, "app-update.yml"));
}

// Marker under userData remembering that the user declined the move. Like VS
// Code / Slack we ask once, not on every launch.
function relocationDeclinedMarkerPath(): string {
  return join(app.getPath("userData"), "relocation-declined");
}

function hasDeclinedRelocation(): boolean {
  return existsSync(relocationDeclinedMarkerPath());
}

function rememberRelocationDeclined(): void {
  // Boundary: a failed marker write only costs us a re-prompt next launch.
  try {
    writeFileSync(relocationDeclinedMarkerPath(), "");
  } catch (err) {
    log.warn("[relocate] could not persist decline marker", err);
  }
}

// Shown in the renderer (disabled download button tooltip) when the user is
// running from a read-only location and declined to relocate - updates can't be
// installed until the app lives in /Applications.
export const UPDATE_BLOCKED_LOCATION_REASON =
  "Move Traycer to your Applications folder to install updates.";

/**
 * True when the running macOS app can't apply auto-updates because it lives
 * outside /Applications (mounted .dmg, Downloads, or an App-Translocation
 * mount - all read-only to Squirrel.Mac). Always false off macOS / unpackaged,
 * where this failure mode doesn't exist.
 */
export function isUpdateBlockedByLocation(): boolean {
  return (
    process.platform === "darwin" &&
    app.isPackaged &&
    hasRealUpdateFeed() &&
    !app.isInApplicationsFolder()
  );
}

/**
 * macOS only. When the app is launched from outside `/Applications` - most often
 * run straight from the mounted `.dmg` (a read-only volume) or a Gatekeeper
 * App-Translocation path - Squirrel.Mac cannot apply auto-updates ("Cannot
 * update while running on a read-only volume"). The platform-standard remedy,
 * shown by apps like VS Code and Slack on first run, is to offer to move the
 * bundle into `/Applications` and relaunch from there.
 *
 * Runs AFTER the main window exists (a deferred boot step), so the prompt
 * appears over a loaded, usable app rather than hard-blocking a windowless
 * boot. Asked at most once - a decline is persisted. On accept, Electron moves
 * the bundle and relaunches from `/Applications`, quitting this instance.
 * Best-effort: any failure logs and leaves the app running where it is.
 */
export async function maybePromptRelocateToApplications(): Promise<void> {
  if (!isUpdateBlockedByLocation() || hasDeclinedRelocation()) {
    return;
  }

  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Move to Applications Folder", "Not Now"],
    defaultId: 0,
    cancelId: 1,
    message: "Move Traycer to your Applications folder?",
    detail:
      "Traycer is running from a read-only location, so it can't install updates. Move it to the Applications folder to keep it up to date automatically.",
  });
  if (response !== 0) {
    // Don't nag on every launch - the disabled in-app download button keeps the
    // option discoverable.
    rememberRelocationDeclined();
    return;
  }

  // Boundary: `moveToApplicationsFolder` performs native filesystem work and can
  // throw (permission denied, locked target). Handle it here so a failed move
  // never disrupts the running app - it just keeps running from where it is.
  try {
    app.moveToApplicationsFolder({
      conflictHandler: (conflictType) => {
        // Another copy already lives in `/Applications`.
        if (conflictType === "existsAndRunning") {
          // Can't replace a running copy - tell the user to quit it.
          dialog.showMessageBoxSync({
            type: "warning",
            buttons: ["OK"],
            message: "Traycer is already open from your Applications folder.",
            detail: "Quit that copy, then move this one again.",
          });
          return false;
        }
        // A dormant copy exists - confirm before Electron trashes it, since the
        // user only agreed to "move", not to deleting an existing install.
        const replace = dialog.showMessageBoxSync({
          type: "question",
          buttons: ["Replace", "Cancel"],
          defaultId: 0,
          cancelId: 1,
          message: "Replace the existing Traycer in your Applications folder?",
          detail:
            "An older copy is already there. Replacing it moves that copy to the Trash.",
        });
        return replace === 0;
      },
    });
  } catch (err) {
    log.warn("[relocate] move to Applications failed", err);
  }
}
