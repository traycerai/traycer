/**
 * Agent-facing presentation for a `terminal.readOutput` result.
 *
 * The wire contract carries a fact - `{ path }` and nothing else. The sentence
 * an agent is shown lives here instead, because BOTH fronts over the same host
 * operation must say the same thing: the injected `traycer_read_terminal` tool
 * (host) and the `traycer terminal output` command (CLI) each render their
 * result line through this one function. Same reason `formatAgentMessage`
 * (`../../agent/a2a-message-format`) is shared rather than duplicated per
 * front - a sentence copied into two call sites is a sentence that drifts, and
 * this one is a promise about what the file holds.
 *
 * Allowed dependencies: none. Keep it a pure string function so it stays
 * browser-safe and importable from every client.
 */

/**
 * Says "terminal output", never "snapshot": the file holds what the terminal
 * has printed, and re-reading it is how the agent refreshes - not a
 * point-in-time artifact worth holding on to.
 */
export function formatTerminalOutputPointer(path: string): string {
  return `terminal output written to ${path}`;
}
