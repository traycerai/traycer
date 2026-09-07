/**
 * MCP enums and non-record helpers. Registered record types come from `protocol/auth/registry.ts`.
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
