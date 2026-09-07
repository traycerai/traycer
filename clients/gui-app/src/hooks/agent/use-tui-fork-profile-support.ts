import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";

/** The cross-profile fork-admission preflight RPC's method name, shared by the capability gate and the mutation so the two can never name different methods. */
export const VALIDATE_TUI_FORK_PROFILE_METHOD = "agent.tui.validateForkProfile";

/**
 * Fails closed while the host manifest is unknown. Skip the preflight rather than calling an unsupported method; `prepareLaunch` still guards authoritatively.
 */
export function useTuiForkProfileSupported(hostId: string | null): boolean {
  return useHostSupportsMethod(hostId, VALIDATE_TUI_FORK_PROFILE_METHOD);
}
