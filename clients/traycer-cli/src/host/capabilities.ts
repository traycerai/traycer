/**
 * Machine-readable capability contract for the CLI slot.
 *
 * A service definition (launchd plist, systemd unit, Windows Scheduled Task)
 * outlives the CLI binary it invokes: the slot is a user-owned symlink and can
 * genuinely point at an N-1 build. Before a definition passes an argument a
 * newer CLI introduced, it has to ask the binary it is about to exec whether
 * that argument exists.
 *
 * This is that question, and it is deliberately NOT `--help`. Help output is
 * human-facing layout: hiding an internal option behind `.hideHelp()` - the
 * house convention in `index.ts` for exactly the `"Internal:"` options
 * involved here - would silently answer "no" with every test still green, and
 * the identity binding the reclaim probe depends on would drop off every
 * platform at once. Capability tokens are a closed, pinned set; changing one
 * is a deliberate edit that a test fails on.
 *
 * Adding a token: append it here, pin it in
 * `__tests__/capabilities.test.ts`, and only then have an emitter gate on it.
 * Never remove or rename a token that a shipped service definition probes -
 * an emitted script asks an *older* CLI, so the token is a backwards
 * compatibility surface in the same sense as an RPC method name.
 */

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

/**
 * Pure - no data-dir contact, no host spawn, no network. Emitted service
 * scripts run this at every login before the supervisor starts, so it must be
 * a process spawn and a `printf`, nothing more.
 */
export function runHostCapabilities(
  request: HostCapabilitiesRequest,
): HostCapabilitiesResponse {
  if (request.kind === "has") {
    // Exit code IS the answer: the emitted probes branch on `$?` and never
    // parse stdout, so they need neither `grep` (absent on NixOS) nor a
    // stable text layout.
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
