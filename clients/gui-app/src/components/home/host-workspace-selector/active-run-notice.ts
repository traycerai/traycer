/** `hasActiveTurn` distinguishes the two; it is ignored for `"terminal-agent"`, which has no
 * background-work-outlives- the-turn concept distinct from PTY output. */
export function activeRunNoticeFor(
  surfaceKind: "chat" | "terminal-agent",
  hasActiveTurn: boolean,
): string {
  if (surfaceKind === "terminal-agent") {
    return "Terminal will restart after rebinding";
  }
  return hasActiveTurn
    ? "Stop the active run before rebinding"
    : "Wait for background tasks to complete before rebinding";
}
