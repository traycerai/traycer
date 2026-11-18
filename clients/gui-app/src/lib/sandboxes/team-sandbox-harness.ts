import type { GuiHarnessSandboxCredentialMode } from "@traycer/protocol/host/agent/gui/unary-schemas";

/** A harness a team sandbox does not offer. */
export const TEAM_SANDBOX_HARNESS_UNAVAILABLE =
  "Not available on team sandboxes.";

/**
 * Whether a harness is blocked on this host: on a team sandbox only a
 * harness whose credential stays a placeholder (the gateway swaps the real
 * one in) is offered. A row this build has no mode for is not offered there
 * either, since nothing says its credential stays with Traycer - and neither
 * is one naming the retired `process-scoped` mode, which no host emits.
 */
export function teamSandboxHarnessBlocked(
  mode: GuiHarnessSandboxCredentialMode | null | undefined,
  onTeamHost: boolean,
): boolean {
  return onTeamHost && mode !== "placeholder";
}
