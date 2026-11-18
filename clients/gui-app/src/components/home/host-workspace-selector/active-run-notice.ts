/**
 * The disabled-remove tooltip's wording for a bound owner surface that reads
 * active. `isOwnerActive` alone doesn't say why - it also reads true for
 * visible background work (Bash `run_in_background` / a subagent / Monitor)
 * outliving an already-completed turn, where there is no active run to stop,
 * only background tasks to wait out. `hasActiveTurn` distinguishes the two;
 * it is ignored for `"terminal-agent"`, which has no background-work-outlives-
 * the-turn concept distinct from PTY output.
 */
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
