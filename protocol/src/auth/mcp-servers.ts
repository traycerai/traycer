/**
 * MCP server enum + non-record helper types.
 *
 * The registered MCP record types (`MCPServer`, `MCPTool`, plus all
 * MCP-related response envelopes) are derived from their registered
 * Zod schemas via `RecordValue<>` and exported from
 * `protocol/auth/registry.ts`. Consumers should import them from
 * there.
 *
 * What stays in this module:
 *
 * - String-literal enums (`MCPServerStatus`, `MCPServerAuthType`)
 *   embedded inside the records.
 * - `ToolSchema` and `SchemaRendererProps` - UI-side helpers, never
 *   serialized over the wire and not records.
 * - `UserMCPServers` and `OrganizationMCPServers` - non-record
 *   composite shapes embedded in
 *   `ListAllMCPServersResponse`. The schemas exist in `_internal/`
 *   but the response envelope is the registered surface.
 */
import type { MCPServer, Organization, User } from "./registry";

export type MCPServerStatus =
  | "CONNECTED"
  | "CONNECTING"
  | "DISCONNECTED"
  | "UNAUTHORIZED"
  | "AUTHORIZING"
  | "AUTHORIZATION_FAILED";

export type MCPServerAuthType = "NO_AUTH" | "PAT" | "OAUTH";

export interface ToolSchema {
  properties?: Record<string, unknown>;
  required?: string[];
  type?: string;
}

export interface SchemaRendererProps {
  schema: ToolSchema | undefined;
  title: string;
  requiredFields?: string[];
}

export type UserMCPServers = {
  user: User;
  servers: MCPServer[];
};

export type OrganizationMCPServers = {
  organization: Organization;
  servers: MCPServer[];
};
