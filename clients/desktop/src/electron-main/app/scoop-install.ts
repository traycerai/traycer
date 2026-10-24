import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SCOOP_UPDATE_BLOCKED_REASON =
  "Run scoop update traycer-desktop to install updates.";

/**
 * True when Scoop installed this build. The bucket manifest rendered by
 * `scripts/native-packaging/publish-cli-package-managers.cjs --desktop-scoop`
 * unpacks the NSIS payload into Scoop's own app folder and then writes `scoop`
 * into `resources/package-type` - the file electron-builder writes for deb/rpm
 * (`readLinuxPackageType`). The NSIS updater would install a second copy under
 * `%LOCALAPPDATA%\Programs` that Scoop never tracks, so these builds update
 * through `scoop update` only.
 */
export function isScoopInstall(): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  const path = join(process.resourcesPath, "package-type");
  if (!existsSync(path)) {
    return false;
  }
  return readFileSync(path, "utf-8").trim() === "scoop";
}
