/**
 * `@traycer/protocol/auth` - canonical home for the auth, session, and
 * MCP-server wire DTOs that cross the open-source client/host
 * boundary.
 *
 * Cloud-only surface (referral, credit, github, misc, the rich
 * organization / team / seat shapes, and the `UserOrganizations`
 * helper) is intentionally *not* re-exported from here. It lives
 * with the authn service in an internal shared package (not in this
 * repo) alongside the Stripe SDK dependency that those DTOs frequently touch.
 *
 * Record-backed types (`User`, `Organization`, `Team`, `Subscription`,
 * `Credit`, `BundleSummary`, `PayAsYouGoUsage`, `MCPServer`, `MCPTool`,
 * and every HTTP response envelope) are derived from their registered
 * Zod schemas in `protocol/auth/registry.ts`. This barrel re-exports
 * those types alongside the enum + non-record extension types from
 * `user.ts` / `token.ts` / `mcp-servers.ts`. Consumers who want the
 * runtime schema use `getRecordSchema(authRecordRegistry, "<name>")`.
 */
export * from "./user";
export * from "./token";
export * from "./mcp-servers";
export * from "./devices-sessions";
export type {
  AuthenticatedUser,
  BundleSummary,
  ConnectMCPServerResponse,
  Credit,
  DisconnectMCPServerResponse,
  EmailOtpResponse,
  ExchangeTokenResponse,
  ExecuteMCPServerToolResponse,
  InstallMCPServerResponse,
  LegacyAuthenticatedUser,
  ListAllMCPServersResponse,
  ListMCPServerToolsResponse,
  ListMCPServersResponse,
  MCPServer,
  MCPTool,
  Organization,
  PayAsYouGoUsage,
  ProviderLoginResponse,
  RefreshMCPServersResponse,
  RefreshTokenResponse,
  Subscription,
  Team,
  UpdateMCPServerResponse,
  User,
  ValidateCouponResponse,
} from "./registry";
