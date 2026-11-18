import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";

/**
 * The cross-profile fork-admission preflight RPC's method name, shared by
 * the capability gate and the mutation so the two can never name different
 * methods.
 */
export const VALIDATE_TUI_FORK_PROFILE_METHOD = "agent.tui.validateForkProfile";

/**
 * Whether `hostId` supports the cross-profile fork-admission preflight.
 *
 * `agent.tui.validateForkProfile` is registered OFF the released floor with
 * `degrade: { kind: "unsupported" }`, so a host predating it negotiates the
 * method away rather than failing the handshake. Its negotiated presence IS
 * the capability signal for cross-profile fork UI - there is no separate
 * flag. Fails closed while the host's manifest is still unknown (see
 * `useHostSupportsMethod`), so `use-create-tui-agent.ts` falls back to
 * skipping the preflight (never blindly calling an unsupported method) and
 * relying on `agent.tui.prepareLaunch`'s own authoritative guard.
 */
export function useTuiForkProfileSupported(hostId: string | null): boolean {
  return useHostSupportsMethod(hostId, VALIDATE_TUI_FORK_PROFILE_METHOD);
}
