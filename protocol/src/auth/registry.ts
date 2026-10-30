import {
  defineRecordContract,
  defineRecordDowngradePath,
  defineRecordUpgradePath,
  defineVersionedRecordRegistry,
  type RecordValue,
  type ValueOf,
} from "@traycer/protocol/framework/index";
import type { DowngradeResult } from "@traycer/protocol/framework/versioned-record";
import {
  authenticatedUserSchema,
  authenticatedUserSchemaPreApple,
  authenticatedUserSchemaWithEnvironments,
  bundleSummarySchema,
  connectMcpServerResponseSchema,
  creditSchema,
  disconnectMcpServerResponseSchema,
  emailOtpResponseSchema,
  exchangeTokenResponseSchema,
  exchangeTokenResponseSchemaPreApple,
  executeMcpServerToolResponseSchema,
  installMcpServerResponseSchema,
  legacyAuthenticatedUserSchema,
  listAllMcpServersResponseSchema,
  listAllMcpServersResponseSchemaPreApple,
  listMcpServerToolsResponseSchema,
  listMcpServersResponseSchema,
  mcpServerSchema,
  mcpToolSchema,
  organizationSchema,
  payAsYouGoUsageSchema,
  providerLoginResponseSchema,
  providerLoginResponseSchemaPreApple,
  refreshMcpServersResponseSchema,
  refreshTokenResponseSchema,
  subscriptionSchema,
  teamSchema,
  updateMcpServerResponseSchema,
  userSchema,
  userSchemaPreApple,
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
 *
 * ## Majors, and why five records moved together
 *
 * `APPLE` widens a CLOSED enum a released client validates against, so it
 * is breaking under the framework's rules and lives at major 2 with a
 * 2-to-1 bridge. The registry does not discover an embedded `userSchema`
 * or run its bridge, so every envelope that should carry the true value is
 * bumped on its own: `user`, `authenticated-user-response`,
 * `provider-login-response`, `exchange-token-response` and
 * `list-all-mcp-servers-response`.
 *
 * `legacy-authenticated-user-response` and `organization` deliberately do
 * NOT move - both are frozen wire contracts for out-of-repo readers, and
 * an organization's `providerType` is always `EMAIL` on the wire.
 *
 * Downgrade paths exist only where something is actually downgraded:
 * `user` owns the one real bridge and `authenticated-user-response`
 * delegates to it. The three cloud-ui-only envelopes need a truthful
 * schema and an identity upgrade, nothing more, so their downgrade map is
 * empty - the framework permits that, and a caller asking for a downgrade
 * that does not exist gets a typed `DOWNGRADE_UNSUPPORTED` rather than a
 * silent mis-mapping.
 *
 * ## Major 3 of `authenticated-user-response`
 *
 * Major 3 adds the caller's `environments` and `actingAs`, both REQUIRED,
 * because a server authorizes with them and must be able to tell "none"
 * from "not said". It is served only by `GET /api/v3/user/negotiated` to a
 * caller that advertises it; the frozen `GET /api/v3/user` stays at major
 * 1. Only this envelope moves: the `user` inside it is unchanged.
 */

// ---- Entity records ----------------------------------------------------- //

export const userRecordV100 = defineRecordContract({
  name: "user",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: userSchemaPreApple,
});

export const userRecordV200 = defineRecordContract({
  name: "user",
  schemaVersion: { major: 2, minor: 0 } as const,
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
  schema: authenticatedUserSchemaPreApple,
});

export const authenticatedUserResponseRecordV200 = defineRecordContract({
  name: "authenticated-user-response",
  schemaVersion: { major: 2, minor: 0 } as const,
  schema: authenticatedUserSchema,
});

export const authenticatedUserResponseRecordV300 = defineRecordContract({
  name: "authenticated-user-response",
  schemaVersion: { major: 3, minor: 0 } as const,
  schema: authenticatedUserSchemaWithEnvironments,
});

export const legacyAuthenticatedUserResponseRecordV100 = defineRecordContract({
  name: "legacy-authenticated-user-response",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: legacyAuthenticatedUserSchema,
});

export const providerLoginResponseRecordV100 = defineRecordContract({
  name: "provider-login-response",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: providerLoginResponseSchemaPreApple,
});

export const providerLoginResponseRecordV200 = defineRecordContract({
  name: "provider-login-response",
  schemaVersion: { major: 2, minor: 0 } as const,
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
  schema: exchangeTokenResponseSchemaPreApple,
});

export const exchangeTokenResponseRecordV200 = defineRecordContract({
  name: "exchange-token-response",
  schemaVersion: { major: 2, minor: 0 } as const,
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
  schema: listAllMcpServersResponseSchemaPreApple,
});

export const listAllMcpServersResponseRecordV200 = defineRecordContract({
  name: "list-all-mcp-servers-response",
  schemaVersion: { major: 2, minor: 0 } as const,
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

// ---- Major 1 <-> major 2 bridges ---------------------------------------- //

/**
 * The ONE real bridge: an Apple user, described to a reader that predates
 * Apple.
 *
 * `EMAIL` is the stand-in because the only consumer that reads the value
 * (cloud-ui's auth provider) tests `!== "GITHUB"`, and an Apple account is
 * like an email one in every way that reader cares about - an
 * email-derived handle and no provider token.
 *
 * The result is re-parsed through the frozen major-1 schema rather than
 * returned as a spread: `downgradeRecordAcrossMajors` hands a bridge's
 * output straight back to its caller WITHOUT validating it, so this is the
 * only place the major-1 shape is actually enforced.
 */
function downgradeUserToV100(
  record: ValueOf<typeof userRecordV200>,
): DowngradeResult<ValueOf<typeof userRecordV100>> {
  const parsed = userRecordV100.schema.safeParse(
    record.providerType === "APPLE"
      ? { ...record, providerType: "EMAIL" }
      : record,
  );
  if (parsed.success) return { ok: true as const, value: parsed.data };
  return {
    ok: false as const,
    error: {
      code: "DOWNGRADE_UNSUPPORTED" as const,
      // Names no provider: every value major 2 adds after `APPLE` takes
      // this same path once it has no mapping, and naming the first one
      // would have misreported every one after it.
      message: "User contains provider state that record 1.0 cannot represent",
    },
  };
}

/**
 * Identity. Every major-1 value is already a valid major-2 value - the
 * bump only WIDENED what `providerType` may hold.
 */
const userUpgradeV100ToV200 = defineRecordUpgradePath<
  typeof userRecordV100,
  typeof userRecordV200
>({
  from: userRecordV100.schemaVersion,
  to: userRecordV200.schemaVersion,
  upgradeRecord: (record) => record,
});

const userDowngradeV200ToV100 = defineRecordDowngradePath<
  typeof userRecordV200,
  typeof userRecordV100
>({
  from: userRecordV200.schemaVersion,
  to: userRecordV100.schemaVersion,
  downgradeRecord: (record) => downgradeUserToV100(record),
});

const authenticatedUserResponseUpgradeV100ToV200 = defineRecordUpgradePath<
  typeof authenticatedUserResponseRecordV100,
  typeof authenticatedUserResponseRecordV200
>({
  from: authenticatedUserResponseRecordV100.schemaVersion,
  to: authenticatedUserResponseRecordV200.schemaVersion,
  upgradeRecord: (record) => record,
});

/**
 * Delegates the only decision to the `user` bridge and rebuilds the
 * envelope around its result, so the mapping lives in exactly one place.
 */
const authenticatedUserResponseDowngradeV200ToV100 = defineRecordDowngradePath<
  typeof authenticatedUserResponseRecordV200,
  typeof authenticatedUserResponseRecordV100
>({
  from: authenticatedUserResponseRecordV200.schemaVersion,
  to: authenticatedUserResponseRecordV100.schemaVersion,
  downgradeRecord: (record) => {
    const user = downgradeUserToV100(record.user);
    if (!user.ok) return user;
    const parsed = authenticatedUserResponseRecordV100.schema.safeParse({
      ...record,
      user: user.value,
    });
    if (parsed.success) return { ok: true as const, value: parsed.data };
    return {
      ok: false as const,
      error: {
        code: "DOWNGRADE_UNSUPPORTED" as const,
        message:
          "Authenticated user response contains state that record 1.0 cannot represent",
      },
    };
  },
});

// ---- Major 2 <-> major 3 bridges ---------------------------------------- //

/**
 * A major-2 body carries no environments, so the upgrade fills the "authn
 * holds no row yet" value. It exists because a client upgrades every parsed
 * body to its own latest; an UPGRADED value authorizes nothing - a server
 * reads these fields only from a response whose served major is 3.
 */
const authenticatedUserResponseUpgradeV200ToV300 = defineRecordUpgradePath<
  typeof authenticatedUserResponseRecordV200,
  typeof authenticatedUserResponseRecordV300
>({
  from: authenticatedUserResponseRecordV200.schemaVersion,
  to: authenticatedUserResponseRecordV300.schemaVersion,
  upgradeRecord: (record) => ({
    ...record,
    environments: { personal: null, teams: [] },
    actingAs: null,
  }),
});

/**
 * Drops the two major-3 fields by re-parsing through the major-2 schema,
 * which strips keys it does not declare. A reader of majors 1 and 2 that
 * wants `actingAs` gets it from authn outside the schema, as before.
 */
function downgradeAuthenticatedUserResponseToV200(
  record: ValueOf<typeof authenticatedUserResponseRecordV300>,
): DowngradeResult<ValueOf<typeof authenticatedUserResponseRecordV200>> {
  const parsed = authenticatedUserResponseRecordV200.schema.safeParse(record);
  if (parsed.success) return { ok: true as const, value: parsed.data };
  return {
    ok: false as const,
    error: {
      code: "DOWNGRADE_UNSUPPORTED" as const,
      message:
        "Authenticated user response contains state that record 2.0 cannot represent",
    },
  };
}

const authenticatedUserResponseDowngradeV300ToV200 = defineRecordDowngradePath<
  typeof authenticatedUserResponseRecordV300,
  typeof authenticatedUserResponseRecordV200
>({
  from: authenticatedUserResponseRecordV300.schemaVersion,
  to: authenticatedUserResponseRecordV200.schemaVersion,
  downgradeRecord: (record) => downgradeAuthenticatedUserResponseToV200(record),
});

/**
 * The framework runs only DIRECT paths from the latest major, and a client
 * that persists a major-1 value (the GUI's provisional-session snapshot)
 * downgrades from its latest. So 3 reaches 1 by composing the two bridges
 * that already decide each step, never by restating either.
 */
const authenticatedUserResponseDowngradeV300ToV100 = defineRecordDowngradePath<
  typeof authenticatedUserResponseRecordV300,
  typeof authenticatedUserResponseRecordV100
>({
  from: authenticatedUserResponseRecordV300.schemaVersion,
  to: authenticatedUserResponseRecordV100.schemaVersion,
  downgradeRecord: (record) => {
    const v200 = downgradeAuthenticatedUserResponseToV200(record);
    if (!v200.ok) return v200;
    return authenticatedUserResponseDowngradeV200ToV100.downgradeRecord(
      v200.value,
    );
  },
});

// The three envelopes below are read only by cloud-ui, which ships with
// authn-v3 and validates nothing. They need a truthful schema and an
// identity upgrade; nothing downgrades them, so they register no
// downgrade path at all rather than a bridge no caller exercises.

const providerLoginResponseUpgradeV100ToV200 = defineRecordUpgradePath<
  typeof providerLoginResponseRecordV100,
  typeof providerLoginResponseRecordV200
>({
  from: providerLoginResponseRecordV100.schemaVersion,
  to: providerLoginResponseRecordV200.schemaVersion,
  upgradeRecord: (record) => record,
});

const exchangeTokenResponseUpgradeV100ToV200 = defineRecordUpgradePath<
  typeof exchangeTokenResponseRecordV100,
  typeof exchangeTokenResponseRecordV200
>({
  from: exchangeTokenResponseRecordV100.schemaVersion,
  to: exchangeTokenResponseRecordV200.schemaVersion,
  upgradeRecord: (record) => record,
});

const listAllMcpServersResponseUpgradeV100ToV200 = defineRecordUpgradePath<
  typeof listAllMcpServersResponseRecordV100,
  typeof listAllMcpServersResponseRecordV200
>({
  from: listAllMcpServersResponseRecordV100.schemaVersion,
  to: listAllMcpServersResponseRecordV200.schemaVersion,
  upgradeRecord: (record) => record,
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
    2: {
      latestMinor: 0,
      versions: {
        0: {
          contract: userRecordV200,
          upgradeFromPreviousVersion: userUpgradeV100ToV200,
        },
      },
      downgradePathsFromLatest: { 1: userDowngradeV200ToV100 },
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
    2: {
      latestMinor: 0,
      versions: {
        0: {
          contract: authenticatedUserResponseRecordV200,
          upgradeFromPreviousVersion:
            authenticatedUserResponseUpgradeV100ToV200,
        },
      },
      downgradePathsFromLatest: {
        1: authenticatedUserResponseDowngradeV200ToV100,
      },
    },
    3: {
      latestMinor: 0,
      versions: {
        0: {
          contract: authenticatedUserResponseRecordV300,
          upgradeFromPreviousVersion:
            authenticatedUserResponseUpgradeV200ToV300,
        },
      },
      downgradePathsFromLatest: {
        1: authenticatedUserResponseDowngradeV300ToV100,
        2: authenticatedUserResponseDowngradeV300ToV200,
      },
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
    2: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providerLoginResponseRecordV200,
          upgradeFromPreviousVersion: providerLoginResponseUpgradeV100ToV200,
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
    2: {
      latestMinor: 0,
      versions: {
        0: {
          contract: exchangeTokenResponseRecordV200,
          upgradeFromPreviousVersion: exchangeTokenResponseUpgradeV100ToV200,
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
    2: {
      latestMinor: 0,
      versions: {
        0: {
          contract: listAllMcpServersResponseRecordV200,
          upgradeFromPreviousVersion:
            listAllMcpServersResponseUpgradeV100ToV200,
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
/** The caller's environment ids, as major 3 carries them. */
export type AuthenticatedUserEnvironments = AuthenticatedUser["environments"];
/** The environment an act-as grant acts for, as major 3 carries it. */
export type AuthenticatedUserActingAs = NonNullable<
  AuthenticatedUser["actingAs"]
>;
/** A claimed credit campaign that has not ended, as majors 2 and 3 carry it. */
export type AuthenticatedUserCampaignCredit = NonNullable<
  AuthenticatedUser["campaignCredits"]
>[number];
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
