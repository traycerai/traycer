/**
 * The injected browser MCP is reported differently by provider harnesses:
 * bare for in-process tools, server-prefixed for ACP/Codex-style tools, and
 * MCP-namespaced for Claude-style tools. Accept the underscore spelling too;
 * some providers sanitize the server's `traycer-browser` id.
 */
export function isTraycerBrowserReplToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase().replaceAll("-", "_");
  return (
    normalized === "repl" ||
    normalized === "browser/repl" ||
    normalized === "traycer_browser/repl" ||
    normalized === "mcp__browser__repl" ||
    normalized === "mcp__traycer_browser__repl"
  );
}
