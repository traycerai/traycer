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
