import {
  defineRecordContract,
  defineVersionedRecordRegistry,
  type RecordValue,
} from "@traycer/protocol/framework/index";
import {
  authenticatedUserSchema,
  bundleSummarySchema,
  connectMcpServerResponseSchema,
  creditSchema,
  disconnectMcpServerResponseSchema,
  emailOtpResponseSchema,
  exchangeTokenResponseSchema,
  executeMcpServerToolResponseSchema,
  installMcpServerResponseSchema,
  legacyAuthenticatedUserSchema,
  listAllMcpServersResponseSchema,
  listMcpServerToolsResponseSchema,
  listMcpServersResponseSchema,
  mcpServerSchema,
  mcpToolSchema,
  organizationSchema,
  payAsYouGoUsageSchema,
  providerLoginResponseSchema,
  refreshMcpServersResponseSchema,
  refreshTokenResponseSchema,
  subscriptionSchema,
  teamSchema,
  updateMcpServerResponseSchema,
  userSchema,
  validateCouponResponseSchema,
} from "@traycer/protocol/auth/_internal/schemas";

/**
 * Auth wire DTO registry.
 *
 * Two layers of records:
 *
 * 1. **Entity records** - core domain shapes (`user`, `organization`,
 *    `team`, `subscription`, `credit`, `mcp-server`, `mcp-tool`, etc.)
 *    embedded inside multiple HTTP responses. Versioning these
 *    independently means a change to `User` is one bump, even when 12
 *    responses embed it.
 * 2. **Response-envelope records** - top-level HTTP wire surfaces
 *    consumed from `Authnv3Client`. Each is a record so the wire
 *    contract evolves explicitly.
 *
 * Schemas backing each contract live under
 * `protocol/auth/_internal/schemas.ts`; this file is the only one
 * outside `_internal/` allowed to import them.
 */

// ---- Entity records ----------------------------------------------------- //

export const userRecordV100 = defineRecordContract({
  name: "user",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: userSchema,
});

export const organizationRecordV100 = defineRecordContract({
  name: "organization",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: organizationSchema,
});

export const teamRecordV100 = defineRecordContract({
  name: "team",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: teamSchema,
});

export const subscriptionRecordV100 = defineRecordContract({
  name: "subscription",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: subscriptionSchema,
});

export const creditRecordV100 = defineRecordContract({
  name: "credit",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: creditSchema,
});

export const payAsYouGoUsageRecordV100 = defineRecordContract({
  name: "pay-as-you-go-usage",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: payAsYouGoUsageSchema,
});

export const bundleSummaryRecordV100 = defineRecordContract({
  name: "bundle-summary",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: bundleSummarySchema,
});

export const mcpServerRecordV100 = defineRecordContract({
  name: "mcp-server",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: mcpServerSchema,
});

export const mcpToolRecordV100 = defineRecordContract({
  name: "mcp-tool",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: mcpToolSchema,
});

// ---- Response-envelope records ------------------------------------------ //

export const authenticatedUserResponseRecordV100 = defineRecordContract({
  name: "authenticated-user-response",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: authenticatedUserSchema,
});

export const legacyAuthenticatedUserResponseRecordV100 = defineRecordContract({
  name: "legacy-authenticated-user-response",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: legacyAuthenticatedUserSchema,
});

export const providerLoginResponseRecordV100 = defineRecordContract({
  name: "provider-login-response",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: providerLoginResponseSchema,
});

export const refreshTokenResponseRecordV100 = defineRecordContract({
  name: "refresh-token-response",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: refreshTokenResponseSchema,
});

export const exchangeTokenResponseRecordV100 = defineRecordContract({
  name: "exchange-token-response",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: exchangeTokenResponseSchema,
});

export const validateCouponResponseRecordV100 = defineRecordContract({
  name: "validate-coupon-response",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: validateCouponResponseSchema,
});

export const emailOtpResponseRecordV100 = defineRecordContract({
  name: "email-otp-response",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: emailOtpResponseSchema,
});

export const installMcpServerResponseRecordV100 = defineRecordContract({
  name: "install-mcp-server-response",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: installMcpServerResponseSchema,
});

export const listMcpServersResponseRecordV100 = defineRecordContract({
  name: "list-mcp-servers-response",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: listMcpServersResponseSchema,
});

export const refreshMcpServersResponseRecordV100 = defineRecordContract({
  name: "refresh-mcp-servers-response",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: refreshMcpServersResponseSchema,
});

export const listAllMcpServersResponseRecordV100 = defineRecordContract({
  name: "list-all-mcp-servers-response",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: listAllMcpServersResponseSchema,
});

export const disconnectMcpServerResponseRecordV100 = defineRecordContract({
  name: "disconnect-mcp-server-response",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: disconnectMcpServerResponseSchema,
});

export const connectMcpServerResponseRecordV100 = defineRecordContract({
  name: "connect-mcp-server-response",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: connectMcpServerResponseSchema,
});

export const updateMcpServerResponseRecordV100 = defineRecordContract({
  name: "update-mcp-server-response",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: updateMcpServerResponseSchema,
});

export const listMcpServerToolsResponseRecordV100 = defineRecordContract({
  name: "list-mcp-server-tools-response",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: listMcpServerToolsResponseSchema,
});

export const executeMcpServerToolResponseRecordV100 = defineRecordContract({
  name: "execute-mcp-server-tool-response",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: executeMcpServerToolResponseSchema,
});

// ---- Registry ----------------------------------------------------------- //

export const authRecordRegistry = defineVersionedRecordRegistry({
  user: {
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: userRecordV100, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
  organization: {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: organizationRecordV100,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  team: {
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: teamRecordV100, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
  subscription: {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: subscriptionRecordV100,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  credit: {
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: creditRecordV100, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
  "pay-as-you-go-usage": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: payAsYouGoUsageRecordV100,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "bundle-summary": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: bundleSummaryRecordV100,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "mcp-server": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: mcpServerRecordV100,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "mcp-tool": {
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: mcpToolRecordV100, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
  "authenticated-user-response": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: authenticatedUserResponseRecordV100,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "legacy-authenticated-user-response": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: legacyAuthenticatedUserResponseRecordV100,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "provider-login-response": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providerLoginResponseRecordV100,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "refresh-token-response": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: refreshTokenResponseRecordV100,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "exchange-token-response": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: exchangeTokenResponseRecordV100,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "validate-coupon-response": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: validateCouponResponseRecordV100,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "email-otp-response": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: emailOtpResponseRecordV100,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "install-mcp-server-response": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: installMcpServerResponseRecordV100,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "list-mcp-servers-response": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: listMcpServersResponseRecordV100,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "refresh-mcp-servers-response": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: refreshMcpServersResponseRecordV100,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "list-all-mcp-servers-response": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: listAllMcpServersResponseRecordV100,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "disconnect-mcp-server-response": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: disconnectMcpServerResponseRecordV100,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "connect-mcp-server-response": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: connectMcpServerResponseRecordV100,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "update-mcp-server-response": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: updateMcpServerResponseRecordV100,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "list-mcp-server-tools-response": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: listMcpServerToolsResponseRecordV100,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "execute-mcp-server-tool-response": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: executeMcpServerToolResponseRecordV100,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
});

export type AuthRecordRegistry = typeof authRecordRegistry;

// Types via `RecordValue<>` so runtime + type stay in lock-step.

export type User = RecordValue<AuthRecordRegistry, "user">;
export type Organization = RecordValue<AuthRecordRegistry, "organization">;
export type Team = RecordValue<AuthRecordRegistry, "team">;
export type Subscription = RecordValue<AuthRecordRegistry, "subscription">;
export type Credit = RecordValue<AuthRecordRegistry, "credit">;
export type PayAsYouGoUsage = RecordValue<
  AuthRecordRegistry,
  "pay-as-you-go-usage"
>;
export type BundleSummary = RecordValue<AuthRecordRegistry, "bundle-summary">;
// `MCPTool` / `MCPServer` types are derived directly from their
// registered schemas via `RecordValue<>` so the registry's
// schema-vs-type lockstep guarantee holds - `inputSchema` and
// `outputSchema` stay as `Record<string, unknown>` on both sides of
// the boundary, matching the `z.record(z.string(), z.unknown())` in
// `mcpToolSchema`. Constructors that receive raw MCP SDK `object`
// values must narrow at the boundary rather than at the type wall.
export type MCPTool = RecordValue<AuthRecordRegistry, "mcp-tool">;

export type MCPServer = RecordValue<AuthRecordRegistry, "mcp-server">;

export type AuthenticatedUser = RecordValue<
  AuthRecordRegistry,
  "authenticated-user-response"
>;
export type LegacyAuthenticatedUser = RecordValue<
  AuthRecordRegistry,
  "legacy-authenticated-user-response"
>;
export type ProviderLoginResponse = RecordValue<
  AuthRecordRegistry,
  "provider-login-response"
>;
export type RefreshTokenResponse = RecordValue<
  AuthRecordRegistry,
  "refresh-token-response"
>;
export type ExchangeTokenResponse = RecordValue<
  AuthRecordRegistry,
  "exchange-token-response"
>;
export type ValidateCouponResponse = RecordValue<
  AuthRecordRegistry,
  "validate-coupon-response"
>;
export type EmailOtpResponse = RecordValue<
  AuthRecordRegistry,
  "email-otp-response"
>;
// Response envelopes that embed MCPServer / MCPTool derive their shape
// directly from the registered record schema - the embedded
// `inputSchema` / `outputSchema` remain `Record<string, unknown>` in
// lockstep with the runtime `mcpToolSchema`.
export type InstallMCPServerResponse = RecordValue<
  AuthRecordRegistry,
  "install-mcp-server-response"
>;
export type ListMCPServersResponse = RecordValue<
  AuthRecordRegistry,
  "list-mcp-servers-response"
>;
export type RefreshMCPServersResponse = RecordValue<
  AuthRecordRegistry,
  "refresh-mcp-servers-response"
>;
export type ListAllMCPServersResponse = RecordValue<
  AuthRecordRegistry,
  "list-all-mcp-servers-response"
>;
export type DisconnectMCPServerResponse = RecordValue<
  AuthRecordRegistry,
  "disconnect-mcp-server-response"
>;
export type ConnectMCPServerResponse = RecordValue<
  AuthRecordRegistry,
  "connect-mcp-server-response"
>;
export type UpdateMCPServerResponse = RecordValue<
  AuthRecordRegistry,
  "update-mcp-server-response"
>;
export type ListMCPServerToolsResponse = RecordValue<
  AuthRecordRegistry,
  "list-mcp-server-tools-response"
>;
export type ExecuteMCPServerToolResponse = RecordValue<
  AuthRecordRegistry,
  "execute-mcp-server-tool-response"
>;
