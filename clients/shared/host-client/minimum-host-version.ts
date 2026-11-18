import { compareHostVersions } from "../host-version/compare-host-versions";
import type { HostDirectoryEntry } from "./host-directory";
import { isRemoteHostDirectoryEntry } from "./remote-fetcher";

/** Raised with the paired host release, independently of app-only patches. */
export const MINIMUM_HOST_VERSION = "0.0.0";

export function hostVersionNeedsUpdate(
  hostVersion: string | null | undefined,
  minimumHostVersion: string,
): boolean {
  // The initial floor admits every host, including local development stamps.
  if (minimumHostVersion === "0.0.0" || hostVersion == null) return false;
  const comparison = compareHostVersions(hostVersion, minimumHostVersion);
  return comparison.comparable && comparison.ordering === "less";
}

/** Local directory versions come from pid.json; remote versions from authn. */
export function hostDirectoryEntryNeedsUpdate(
  entry: HostDirectoryEntry,
  minimumHostVersion: string,
): boolean {
  return hostVersionNeedsUpdate(
    isRemoteHostDirectoryEntry(entry)
      ? entry.remoteStatus.appVersion
      : entry.version,
    minimumHostVersion,
  );
}
