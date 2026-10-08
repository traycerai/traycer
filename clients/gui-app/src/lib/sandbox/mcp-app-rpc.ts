import { createContext, use } from "react";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ChatMcpAppCallToolRequest,
  ChatMcpAppCallToolResponse,
  ChatMcpAppReadResourceRequest,
  ChatMcpAppReadResourceResponse,
  ChatMcpAppUpdateModelContextRequest,
  ChatMcpAppUpdateModelContextResponse,
} from "@traycer/protocol/host/chat/mcp-app";

/**
 * The `chat.mcpApp.*` calls an MCP App row makes, typed by the protocol
 * contracts (`@traycer/protocol/host/chat/mcp-app`).
 *
 * A seam for the reason `lib/files/epic-file-rpc.ts` gives: the methods join
 * the host RPC registry together with their resolvers. Until then nothing
 * answers them, every call rejects `E_HOST_UNSUPPORTED`, and the row shows
 * the app read-only from its stored result. Tests provide a fake through
 * {@link McpAppRpcContext}.
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

function unserved(method: string): Promise<never> {
  return Promise.reject(
    new HostRpcError({
      code: "E_HOST_UNSUPPORTED",
      message: `${method} is not served by this host`,
      requestId: "",
      method,
      fatalDetails: null,
    }),
  );
}

const UNSERVED_MCP_APP_RPC: McpAppRpc = {
  callTool: () => unserved("chat.mcpApp.callTool"),
  readResource: () => unserved("chat.mcpApp.readResource"),
  updateModelContext: () => unserved("chat.mcpApp.updateModelContext"),
};

export const McpAppRpcContext = createContext<McpAppRpc | null>(null);

export function useMcpAppRpc(): McpAppRpc {
  return use(McpAppRpcContext) ?? UNSERVED_MCP_APP_RPC;
}
