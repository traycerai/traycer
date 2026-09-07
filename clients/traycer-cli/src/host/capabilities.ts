/** Machine-readable CLI-slot capabilities. Hosts older than a field must see it absent, not false. */

/** `traycer host start --service-label <label>` - reclaim probe identity binding. */
export const HOST_CAPABILITY_SERVICE_LABEL = "service-label";
/** A service wrapper can fetch and present an exact v2 start-adoption nonce. */
export const HOST_CAPABILITY_HOST_START_ADOPTION_V2 = "host-start-adoption-v2";
/** Root-script lease protocol for non-CLI-owned Desktop maintenance. */
export const HOST_CAPABILITY_MAINTENANCE_LEASE_V1 = "maintenance-lease-v1";
/** Target-bound root-maintenance executor protocol. */
export const HOST_CAPABILITY_MAINTENANCE_LEASE_V2 = "maintenance-lease-v2";

/** Schema version of the `--json` document, not of the token set. */
export const HOST_CAPABILITIES_VERSION = 1;

export const HOST_CAPABILITIES: readonly string[] = [
  HOST_CAPABILITY_SERVICE_LABEL,
  HOST_CAPABILITY_HOST_START_ADOPTION_V2,
  HOST_CAPABILITY_MAINTENANCE_LEASE_V1,
  HOST_CAPABILITY_MAINTENANCE_LEASE_V2,
];

export type HostCapabilitiesRequest =
  | { readonly kind: "list"; readonly json: boolean }
  | { readonly kind: "has"; readonly capability: string };

export type HostCapabilitiesResponse = {
  readonly stdout: string;
  readonly exitCode: number;
};

/** Pure - no data-dir contact, no host spawn, no network. Emitted service scripts run this at every login before the supervisor starts, so it must be a process spawn and a `printf`, nothing more. */
export function runHostCapabilities(
  request: HostCapabilitiesRequest,
): HostCapabilitiesResponse {
  if (request.kind === "has") {
    // Exit code IS the answer: the emitted probes branch on `$?` and never parse stdout, so they need neither `grep` (absent on NixOS) nor a stable text layout.
    return {
      stdout: "",
      exitCode: HOST_CAPABILITIES.includes(request.capability) ? 0 : 1,
    };
  }
  if (request.json) {
    return {
      stdout: `${JSON.stringify({
        v: HOST_CAPABILITIES_VERSION,
        capabilities: HOST_CAPABILITIES,
      })}\n`,
      exitCode: 0,
    };
  }
  return { stdout: `${HOST_CAPABILITIES.join("\n")}\n`, exitCode: 0 };
}
