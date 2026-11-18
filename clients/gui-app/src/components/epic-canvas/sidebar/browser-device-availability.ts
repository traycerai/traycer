import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";

/** Unknown or missing directory evidence must never hide a device as offline. */
export function isBrowserDeviceOffline(
  host: HostScopeOption | undefined,
): boolean {
  const state = host?.health.state;
  return (
    state === "offline" || state === "stopped" || state === "not-installed"
  );
}
