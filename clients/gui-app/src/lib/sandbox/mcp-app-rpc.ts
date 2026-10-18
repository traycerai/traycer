import { createContext, use, useMemo } from "react";
import type {
  ChatMcpAppCallToolRequest,
  ChatMcpAppCallToolResponse,
  ChatMcpAppReadResourceRequest,
  ChatMcpAppReadResourceResponse,
  ChatMcpAppUpdateModelContextRequest,
  ChatMcpAppUpdateModelContextResponse,
} from "@traycer/protocol/host/chat/mcp-app";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import { useHostBinding } from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";

/**
 * The `chat.mcpApp.*` calls an MCP App row makes, typed by the protocol
 * contracts (`@traycer/protocol/host/chat/mcp-app`).
 *
 * A seam rather than `useHostQuery` so tests can hand in a fake through
 * {@link McpAppRpcContext}. Production calls go to the host the tab is bound
 * to, resolved the way `lib/files/epic-file-rpc.ts` resolves it. A host
 * without the methods answers `E_HOST_UNSUPPORTED` itself, and the row shows
 * the app read-only from its stored result.
 */
export interface McpAppRpc {
  readonly callTool: (
    params: ChatMcpAppCallToolRequest,
  ) => Promise<ChatMcpAppCallToolResponse>;
  readonly readResource: (
    params: ChatMcpAppReadResourceRequest,
  ) => Promise<ChatMcpAppReadResourceResponse>;
  readonly updateModelContext: (
    params: ChatMcpAppUpdateModelContextRequest,
  ) => Promise<ChatMcpAppUpdateModelContextResponse>;
}

export const McpAppRpcContext = createContext<McpAppRpc | null>(null);

export function useMcpAppRpc(): McpAppRpc {
  const override = use(McpAppRpcContext);
  const hostId = use(TabHostContext);
  const binding = useHostBinding();
  return useMemo<McpAppRpc>(() => {
    if (override !== null) return override;
    const client =
      hostId === null ? null : resolveNamedHostClient(binding, hostId);
    if (client === null) {
      const unavailable = (method: string) =>
        Promise.reject(hostClientUnavailableError(method));
      return {
        callTool: () => unavailable("chat.mcpApp.callTool"),
        readResource: () => unavailable("chat.mcpApp.readResource"),
        updateModelContext: () => unavailable("chat.mcpApp.updateModelContext"),
      };
    }
    return {
      callTool: (params) => client.request("chat.mcpApp.callTool", params),
      readResource: (params) =>
        client.request("chat.mcpApp.readResource", params),
      updateModelContext: (params) =>
        client.request("chat.mcpApp.updateModelContext", params),
    };
  }, [override, hostId, binding]);
}
