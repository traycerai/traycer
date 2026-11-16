import { resolvePlatformBaseUrl } from "@/lib/auth/platform-base-url";

/**
 * Dashboard paths Members links to. Empty handle means the team cannot be
 * named in a URL; callers hide the control rather than compose `/team//…`.
 */

export function seatsManagementPath(handle: string): string | null {
  if (handle.length === 0) return null;
  return `/team/${encodeURIComponent(handle)}/seat-management`;
}

/** Where a team gets the Traycer subscription a seats write needs. */
export function teamBillingPath(handle: string): string | null {
  if (handle.length === 0) return null;
  return `/team/${encodeURIComponent(handle)}/billing`;
}

export function seatsManagementUrl(
  signInUrl: string,
  handle: string,
): string | null {
  const path = seatsManagementPath(handle);
  if (path === null) return null;
  return `${resolvePlatformBaseUrl(signInUrl)}${path}`;
}

export function teamBillingUrl(
  signInUrl: string,
  handle: string,
): string | null {
  const path = teamBillingPath(handle);
  if (path === null) return null;
  return `${resolvePlatformBaseUrl(signInUrl)}${path}`;
}
