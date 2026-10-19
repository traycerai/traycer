/** A harness a team sandbox does not offer. */
export const TEAM_SANDBOX_HARNESS_UNAVAILABLE =
  "Not available on team sandboxes.";

/**
 * Whether a harness is blocked on this host: on a team sandbox only a
 * harness whose credential stays a placeholder (the gateway swaps the real
 * one in) is offered, since anything else would put the credential where
 * every member's agent can read it. An unknown mode is not offered there.
 */
export function teamSandboxHarnessBlocked(
  mode: "placeholder" | "process-scoped" | "unsupported" | null | undefined,
  onTeamHost: boolean,
): boolean {
  return onTeamHost && mode !== "placeholder";
}
