/** Agent-facing presentation for a `terminal.readOutput` result. */

/**
 * Says "terminal output", never "snapshot": the file holds what the terminal has printed, and re-reading it is how the agent refreshes - not a point-in-time artifact worth holding on to.
 */
export function formatTerminalOutputPointer(path: string): string {
  return `terminal output written to ${path}`;
}
