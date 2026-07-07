import type { ReactNode } from "react";
import { parseMcpToolName } from "@traycer/protocol/host/agent/gui/agent-runtime";

/**
 * Renders an MCP tool name as `[server] tool` (or `[server]` when the name
 * carries no tool component — Codex `mcp:<server>` and server-only Claude
 * `mcp__<server>`). Falls back to the raw string for non-MCP identities. The
 * server is dimmed and bracketed; the tool is emphasized. Purely presentational
 * — matching/trust always stay on the whole opaque `toolName`.
 */
export function McpToolName(props: { readonly toolName: string }): ReactNode {
  const parsed = parseMcpToolName(props.toolName);
  if (parsed === null) return props.toolName;
  return (
    <>
      <span className="text-muted-foreground/70">[{parsed.server}]</span>
      {parsed.tool !== null ? (
        <span className="ml-1 text-foreground/90">{parsed.tool}</span>
      ) : null}
    </>
  );
}
