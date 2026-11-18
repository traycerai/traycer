import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isPreReleaseVersion } from "@traycer-clients/shared/host-version/release-line";
import { desktopReleasesUrl } from "./desktop-release-feed";

/**
 * True when Scoop installed this build. The bucket manifest rendered by
 * `scripts/native-packaging/publish-cli-package-managers.cjs --desktop-scoop`
 * unpacks the NSIS payload into Scoop's own app folder and then writes `scoop`
 * into `resources/package-type` - the file electron-builder writes for deb/rpm
 * (`readLinuxPackageType`). The NSIS updater would install a second copy under
 * `%LOCALAPPDATA%\Programs` that Scoop never tracks, so these builds never
 * download or apply an update themselves.
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

/**
 * Why a Scoop install can't take `latestVersion` in place. The bucket's
 * manifest follows stable `desktop-v*` tags only, so a release candidate (one a
 * user accepted through compatibility recovery) is never reachable through
 * `scoop update`; that one points at the releases page instead.
 */
export function scoopUpdateBlockedReason(latestVersion: string | null): string {
  if (latestVersion !== null && isPreReleaseVersion(latestVersion)) {
    return `Scoop has stable releases only. Download v${latestVersion} from ${desktopReleasesUrl()}.`;
  }
  return "Run scoop update traycer-desktop to install updates.";
}
