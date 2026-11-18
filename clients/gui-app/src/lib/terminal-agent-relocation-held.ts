/**
 * The host's refusal to launch a terminal agent whose native session a data
 * relocation could not carry to the new location
 * (`TerminalAgentRelocationHeldError` in the host's
 * `terminal-session-manager.ts`). It rides the ordinary `E_INVALID_ARGUMENT`
 * response with a stable message prefix, the same convention
 * `SOURCE_NOT_READY:` uses (`tui-fork-profile-rejection.ts`), so an older
 * client still shows the plain message. Coupled to the host constant by
 * construction - update both together.
 */
const TERMINAL_AGENT_RELOCATION_HELD_PREFIX = "RELOCATION_HELD:";

/**
 * The held reason the host wrote after the prefix, or `null` when the error
 * is not a relocation hold.
 */
export function terminalAgentRelocationHeldReason(
  error: { readonly message?: string } | null,
): string | null {
  const message = error?.message;
  if (message === undefined) return null;
  const index = message.indexOf(TERMINAL_AGENT_RELOCATION_HELD_PREFIX);
  if (index === -1) return null;
  const reason = message
    .slice(index + TERMINAL_AGENT_RELOCATION_HELD_PREFIX.length)
    .trim();
  return reason.length > 0 ? reason : null;
}

/**
 * Marker the host writes before the prefix when the hold covers EVERY agent
 * on that host (its relocation impact record is unreadable): starting a new
 * agent is then no way on, so the tile must not offer it.
 */
const TERMINAL_AGENT_RELOCATION_HELD_HOST_WIDE_MARKER =
  "RELOCATION_HELD_HOST_WIDE";

export function terminalAgentRelocationHoldIsHostWide(
  error: { readonly message?: string } | null,
): boolean {
  return (
    error?.message?.includes(
      TERMINAL_AGENT_RELOCATION_HELD_HOST_WIDE_MARKER,
    ) === true
  );
}
