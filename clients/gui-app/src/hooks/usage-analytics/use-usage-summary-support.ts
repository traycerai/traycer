import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";

const USAGE_SUMMARY_METHOD = "host.usage.summary";

/**
 * Whether `hostId` advertised `host.usage.summary` at its last handshake.
 * `host.usage.summary` is registered `degrade: { kind: "unsupported" }` (see
 * the protocol registry), so an older host simply omits it rather than
 * failing the handshake - this is the gate every usage-cost affordance
 * (Usage page nav entry, epic cost badge) checks before rendering, fails
 * closed like every other optional-method gate in this app.
 */
export function useUsageSummarySupported(hostId: string | null): boolean {
  return useHostSupportsMethod(hostId, USAGE_SUMMARY_METHOD);
}
