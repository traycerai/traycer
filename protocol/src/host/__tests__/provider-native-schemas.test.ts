import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  downgradeProviderCliStateToV10,
  providerCliStateSchema,
  providerCliStateSchemaMutationV20,
  providerCliStateSchemaV10,
  providerCliStateSchemaV20,
  providersAddCustomPathRequestSchema,
  providersAddCustomPathResponseSchemaV20,
  providersAwaitLoginRequestSchema,
  providersAwaitLoginRequestSchemaV20,
  providersAwaitLoginResponseSchema,
  providersAwaitLoginResponseSchemaV20,
  providersClearApiKeyRequestSchema,
  providersClearApiKeyResponseSchemaV20,
  providersDeleteEnvOverrideRequestSchema,
  providersDeleteEnvOverrideResponseSchemaV20,
  providersListRequestSchema,
  providersListResponseSchema,
  providersListResponseSchemaV10,
  providersListResponseSchemaV20,
  providersListResponseSchemaV30,
  providersRemoveCustomPathRequestSchema,
  providersRemoveCustomPathResponseSchemaV20,
  providersSetApiKeyRequestSchema,
  providersSetApiKeyResponseSchemaV20,
  providersSetEnabledRequestSchema,
  providersSetEnabledRequestSchemaV20,
  providersSetEnabledResponseSchema,
  providersSetEnabledResponseSchemaV20,
  providersSetEnvOverrideRequestSchema,
  providersSetEnvOverrideResponseSchemaV20,
  providersSetSelectionRequestSchema,
  providersSetSelectionResponseSchemaV20,
  providersSetTerminalAgentArgsRequestSchema,
  providersSetTerminalAgentArgsResponseSchemaV20,
  providersStartLoginRequestSchema,
  providersStartLoginResponseSchema,
  providersCancelLoginRequestSchema,
  providersCancelLoginResponseSchema,
} from "@traycer/protocol/host/provider-schemas";
import {
  hostRpcRegistry,
  providersListDowngradeV4ToV1,
  providersListDowngradeV4ToV2,
  providersListDowngradeV4ToV3,
  providersListUpgradeV3ToV4,
  providersSetEnabledDowngradeV21ToV20,
  providersSetEnabledUpgradeV20ToV21,
  providersStartLoginUpgradeV10ToV11,
  providersCancelLoginUpgradeV10ToV11,
  providersAwaitLoginUpgradeV20ToV21,
} from "@traycer/protocol/host/registry";
import {
  nativeAuthActionSchema,
  nativeAuthCancelContextSchema,
  nativeAuthPollContextSchema,
  nativeAuthResultSchema,
  nativeListQuerySchema,
  nativeMutationSchema,
  providerMcpToolSchema,
  providerNativeCapabilitiesSchema,
  providerNativeErrorCodeSchema,
  providerNativeScopeSchema,
} from "@traycer/protocol/host/provider-native-schemas";
import { providerIdSchema, providerIdSchemaV20 } from "@traycer/protocol/host/provider-ids";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertParseAgainstTagSchema,
  buildHostV115MutationV20Fixtures,
  gitShow,
  HOST_V115_MUTATION_V20_SCHEMAS_PATH,
  HOST_V115_MUTATION_V20_TAG,
  importTaggedProviderSchemas,
} from "../../../scripts/snapshot-host-v1.1.5-mutation-v20-fixtures";
import { releasedMethodNames } from "./__fixtures__/released-method-names";
import { hostV115MutationV20Fixtures } from "./__fixtures__/host-v1.1.5-mutation-v20";

type MutationV20StatePayload = {
  readonly state: unknown;
};

type MutationV20Schema = {
  parse: (value: unknown) => MutationV20StatePayload;
  safeParse: (value: unknown) => { success: boolean };
};

/**
 * Live schema map for the ten host-v1.1.5 mutation@2.0 surfaces. Method names
 * and fixture values come from the tag-derived fixture; this map only binds
 * those names to the current protocol schemas under test.
 */
const MUTATION_V20_RESPONSE_SCHEMA_BY_METHOD: Record<
  string,
  { schema: MutationV20Schema; nullableState: boolean }
> = {
  "providers.setSelection": {
    schema: providersSetSelectionResponseSchemaV20,
    nullableState: false,
  },
  "providers.addCustomPath": {
    schema: providersAddCustomPathResponseSchemaV20,
    nullableState: false,
  },
  "providers.removeCustomPath": {
    schema: providersRemoveCustomPathResponseSchemaV20,
    nullableState: false,
  },
  "providers.setEnabled": {
    schema: providersSetEnabledResponseSchemaV20,
    nullableState: false,
  },
  "providers.setApiKey": {
    schema: providersSetApiKeyResponseSchemaV20,
    nullableState: false,
  },
  "providers.clearApiKey": {
    schema: providersClearApiKeyResponseSchemaV20,
    nullableState: false,
  },
  "providers.setTerminalAgentArgs": {
    schema: providersSetTerminalAgentArgsResponseSchemaV20,
    nullableState: false,
  },
  "providers.setEnvOverride": {
    schema: providersSetEnvOverrideResponseSchemaV20,
    nullableState: false,
  },
  "providers.deleteEnvOverride": {
    schema: providersDeleteEnvOverrideResponseSchemaV20,
    nullableState: false,
  },
  "providers.awaitLogin": {
    schema: providersAwaitLoginResponseSchemaV20,
    nullableState: true,
  },
};

const MUTATION_V20_REQUEST_PARSER_BY_METHOD: Record<
  string,
  { parse: (value: unknown) => unknown }
> = {
  "providers.setSelection": providersSetSelectionRequestSchema,
  "providers.addCustomPath": providersAddCustomPathRequestSchema,
  "providers.removeCustomPath": providersRemoveCustomPathRequestSchema,
  "providers.setEnabled": providersSetEnabledRequestSchemaV20,
  "providers.setApiKey": providersSetApiKeyRequestSchema,
  "providers.clearApiKey": providersClearApiKeyRequestSchema,
  "providers.setTerminalAgentArgs": providersSetTerminalAgentArgsRequestSchema,
  "providers.setEnvOverride": providersSetEnvOverrideRequestSchema,
  "providers.deleteEnvOverride": providersDeleteEnvOverrideRequestSchema,
  "providers.awaitLogin": providersAwaitLoginRequestSchemaV20,
};

/**
 * Tag-derived minimal state for a provider id. Values come from
 * `__fixtures__/host-v1.1.5-mutation-v20.ts` (generated from
 * `git show host-v1.1.5:protocol/src/host/provider-schemas.ts`).
 */
function baseState(providerId: string) {
  const fromTag =
    hostV115MutationV20Fixtures.minimalStatesByProviderId[
      providerId as keyof typeof hostV115MutationV20Fixtures.minimalStatesByProviderId
    ];
  if (fromTag === undefined) {
    throw new Error(
      `No tag-derived state for providerId=${providerId}; regenerate host-v1.1.5-mutation-v20 fixtures`,
    );
  }
  // Materialize a mutable plain object for test spreads (fixture is `as const`).
  return structuredClone(fromTag);
}

const sampleMcpCapabilities = {
  transports: ["stdio", "http"] as const,
  authTypes: ["none", "oauth"] as const,
  authActions: ["login", "logout"] as const,
  actionScopes: {
    list: ["global", "project"] as const,
    add: ["global"] as const,
    update: ["global"] as const,
    remove: ["global"] as const,
    toggleServer: ["global", "project"] as const,
    toggleTool: ["global", "project"] as const,
    discover: ["global"] as const,
    auth: ["global"] as const,
  },
  addServer: "cli" as const,
  removeServer: "cli" as const,
  updateServer: "patch" as const,
  perToolBacking: "store" as const,
  statusSource: "native" as const,
  toolsSource: "native" as const,
  schemasSource: "probe" as const,
  instructionsSource: "probe" as const,
  traycerSessionsOnlyEnforcement: true,
  stdioDegradeNotice: false,
  oauthDegradesToConfigOnly: true,
};

describe("nativeCapabilities on ProviderCliState", () => {
  it("parses latest state with nativeCapabilities action→scope table", () => {
    const state = providerCliStateSchema.parse({
      ...baseState("codex"),
      nativeCapabilities: {
        supportedTabs: ["general", "env", "usage", "mcp"],
        mcp: sampleMcpCapabilities,
        plugins: null,
        skills: {
          actionScopes: {
            list: ["global"],
            add: ["global"],
            create: [],
            import: [],
            remove: [],
          },
        },
      },
    });
    expect(state.nativeCapabilities.mcp?.perToolBacking).toBe("store");
    expect(state.nativeCapabilities.mcp?.actionScopes.toggleTool).toEqual([
      "global",
      "project",
    ]);
  });

  it("defaults nativeCapabilities via .catch for old-host wire shapes", () => {
    const state = providerCliStateSchema.parse(baseState("cursor"));
    expect(state.nativeCapabilities).toEqual(
      DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
    );
  });

  it("encodes V1 degraded per-tool and store-backed branches", () => {
    expect(
      providerNativeCapabilitiesSchema.parse({
        supportedTabs: ["general", "mcp"],
        mcp: {
          ...sampleMcpCapabilities,
          perToolBacking: "degraded-server-level",
          stdioDegradeNotice: true,
        },
        plugins: null,
        skills: null,
      }).mcp?.perToolBacking,
    ).toBe("degraded-server-level");
  });
});

describe("providers.list@4.0 upgrade/downgrade bridges", () => {
  it("upgrades v3.0 responses with the default descriptor and native:null", () => {
    const v30 = providersListResponseSchemaV30.parse({
      providers: [baseState("amp")],
    });
    const upgraded = providersListUpgradeV3ToV4.upgradeResponse(v30);
    expect(upgraded.providers[0]?.nativeCapabilities).toEqual(
      DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
    );
    expect(upgraded.native).toBeNull();
    expect(() => providersListResponseSchema.parse(upgraded)).not.toThrow();
  });

  it("upgrades v3.0 requests with native:null", () => {
    const upgraded = providersListUpgradeV3ToV4.upgradeRequest({});
    expect(upgraded.native).toBeNull();
  });

  it("downgrades v4.0 → v3.0 by stripping nativeCapabilities and native", () => {
    const v31 = providersListResponseSchema.parse({
      providers: [
        {
          ...baseState("amp"),
          nativeCapabilities: {
            supportedTabs: ["general", "mcp", "plugins"],
            mcp: sampleMcpCapabilities,
            plugins: {
              addModes: ["file-drop"],
              marketplaceBrowse: false,
              actionScopes: {
                list: ["global"],
                add: ["global"],
                remove: ["global"],
                setEnabled: [],
              },
              traycerSessionToolsNotice: true,
            },
            skills: null,
          },
        },
      ],
      native: null,
    });
    const result = providersListDowngradeV4ToV3.downgradeResponse(v31);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.providers[0]).not.toHaveProperty("nativeCapabilities");
    expect(result.value).not.toHaveProperty("native");
    expect(() =>
      providersListResponseSchemaV30.parse(result.value),
    ).not.toThrow();
  });

  it("downgrades v4.0 → v2.0 dropping Amp and nativeCapabilities", () => {
    const v31 = providersListResponseSchema.parse({
      providers: [
        {
          ...baseState("cursor"),
          nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
        },
        {
          ...baseState("amp"),
          nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
        },
      ],
      native: null,
    });
    const result = providersListDowngradeV4ToV2.downgradeResponse(v31);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.providers.map((provider) => provider.providerId),
    ).toEqual(["cursor"]);
    expect(result.value.providers[0]).not.toHaveProperty("nativeCapabilities");
    expect(() =>
      providersListResponseSchemaV20.parse(result.value),
    ).not.toThrow();
  });

  it("strips nativeCapabilities in V10 strictObject downgrade (silent-data-loss trap)", () => {
    const latest = providerCliStateSchema.parse({
      ...baseState("cursor"),
      nativeCapabilities: {
        supportedTabs: ["general", "mcp"],
        mcp: sampleMcpCapabilities,
        plugins: null,
        skills: null,
      },
    });
    const downgraded = downgradeProviderCliStateToV10(latest);
    expect(downgraded).not.toBeNull();
    if (downgraded === null) return;
    expect(downgraded).not.toHaveProperty("nativeCapabilities");
    expect(downgraded).not.toHaveProperty("availabilityPending");
    expect(() => providerCliStateSchemaV10.parse(downgraded)).not.toThrow();

    const list = providersListResponseSchema.parse({
      providers: [latest],
      native: null,
    });
    const listResult = providersListDowngradeV4ToV1.downgradeResponse(list);
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;
    expect(listResult.value.providers[0]).not.toHaveProperty(
      "nativeCapabilities",
    );
    expect(() =>
      providersListResponseSchemaV10.parse(listResult.value),
    ).not.toThrow();
  });

  it("dispatcher path: frozen list@3.0 / mutation@2.0 schemas strip nativeCapabilities", () => {
    const latestList = providersListResponseSchema.parse({
      providers: [
        {
          ...baseState("cursor"),
          nativeCapabilities: {
            supportedTabs: ["general", "mcp"],
            mcp: sampleMcpCapabilities,
            plugins: null,
            skills: null,
          },
        },
      ],
      native: {
        ok: true,
        kind: "mcp",
        servers: [],
      },
    });
    expect(latestList.providers[0]).toHaveProperty("nativeCapabilities");
    expect(latestList.native).not.toBeNull();

    const asV30 = providersListResponseSchemaV30.parse({
      providers: latestList.providers,
    });
    expect(asV30.providers[0]).not.toHaveProperty("nativeCapabilities");
    expect(asV30.providers[0]?.providerId).toBe("cursor");
    expect(asV30).not.toHaveProperty("native");

    const latestMutation = {
      state: providerCliStateSchema.parse({
        ...baseState("cursor"),
        nativeCapabilities: {
          supportedTabs: ["general", "mcp"],
          mcp: sampleMcpCapabilities,
          plugins: null,
          skills: null,
        },
      }),
    };
    expect(latestMutation.state).toHaveProperty("nativeCapabilities");
    const asV20 = providersSetApiKeyResponseSchemaV20.parse(latestMutation);
    expect(asV20.state).not.toHaveProperty("nativeCapabilities");
    expect(asV20.state.providerId).toBe("cursor");
  });
});

describe("carrier envelopes (object-preserving, no unions)", () => {
  it("accepts native list query on providers.list@3.1", () => {
    const query = nativeListQuerySchema.parse({
      kind: "mcp",
      providerId: "claude-code",
      scope: "global",
      workspaceRoot: null,
    });
    expect(query.kind).toBe("mcp");
    expect(
      providersListRequestSchema.parse({
        native: query,
      }).native?.kind,
    ).toBe("mcp");
  });

  it("XOR-validates setEnabled@2.1 enabled vs native", () => {
    expect(
      providersSetEnabledRequestSchema.safeParse({
        providerId: "claude-code",
        enabled: true,
        native: null,
      }).success,
    ).toBe(true);
    expect(
      providersSetEnabledRequestSchema.safeParse({
        providerId: "claude-code",
        enabled: null,
        native: {
          kind: "mcp",
          scope: "global",
          workspaceRoot: null,
          mutation: { action: "remove", name: "playwright" },
        },
      }).success,
    ).toBe(true);
    expect(
      providersSetEnabledRequestSchema.safeParse({
        providerId: "claude-code",
        enabled: true,
        native: {
          kind: "mcp",
          scope: "global",
          workspaceRoot: null,
          mutation: { action: "remove", name: "playwright" },
        },
      }).success,
    ).toBe(false);
    expect(
      providersSetEnabledRequestSchema.safeParse({
        providerId: "claude-code",
        enabled: null,
        native: null,
      }).success,
    ).toBe(false);
  });

  it("upgrades setEnabled 2.0→2.1 with native:null", () => {
    const classic = providersSetEnabledRequestSchemaV20.parse({
      providerId: "cursor",
      enabled: false,
    });
    const upgraded = providersSetEnabledUpgradeV20ToV21.upgradeRequest(classic);
    expect(upgraded).toEqual({
      providerId: "cursor",
      enabled: false,
      native: null,
      profileAction: null,
    });
    const upgradedResp = providersSetEnabledUpgradeV20ToV21.upgradeResponse({
      state: providerCliStateSchemaMutationV20.parse(baseState("cursor")),
    });
    expect(upgradedResp.native).toBeNull();
    expect(upgradedResp.state.nativeCapabilities).toEqual(
      DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
    );
  });

  it("refuses native setEnabled downgrade to 2.0", () => {
    const result = providersSetEnabledDowngradeV21ToV20.downgradeRequest({
      providerId: "claude-code",
      enabled: null,
      profileAction: null,
      native: {
        kind: "mcp",
        scope: "global",
        workspaceRoot: null,
        mutation: { action: "remove", name: "x" },
      },
    });
    expect(result.ok).toBe(false);
  });

  it("models full NativeAuthAction set and result variants", () => {
    expect(
      nativeAuthActionSchema.parse({
        action: "submitCode",
        scope: "global",
        workspaceRoot: null,
        serverName: "linear",
        code: "123456",
      }).action,
    ).toBe("submitCode");
    expect(
      nativeAuthActionSchema.parse({
        action: "forceReauth",
        scope: "project",
        workspaceRoot: "/repo",
        serverName: "github",
      }).action,
    ).toBe("forceReauth");
    for (const kind of [
      "authorizationUrl",
      "pendingInstruction",
      "pending",
      "done",
      "unsupported",
      "error",
    ] as const) {
      const payload =
        kind === "authorizationUrl"
          ? { kind, authorizationUrl: "https://example.com" }
          : kind === "pendingInstruction"
            ? { kind, instruction: "check log" }
            : kind === "unsupported"
              ? { kind, reason: null }
              : kind === "error"
                ? { kind, code: "unsupported_action", detail: null }
                : { kind };
      expect(nativeAuthResultSchema.parse(payload).kind).toBe(kind);
    }
  });

  it("startLogin/cancelLogin/awaitLogin upgrade defaults mcpAuth to null", () => {
    expect(
      providersStartLoginUpgradeV10ToV11.upgradeRequest({
        providerId: "claude-code",
      }).mcpAuth,
    ).toBeNull();
    expect(
      providersStartLoginUpgradeV10ToV11.upgradeResponse({
        url: null,
        started: true,
      }).mcpAuth,
    ).toBeNull();
    expect(
      providersCancelLoginUpgradeV10ToV11.upgradeRequest({
        providerId: "claude-code",
      }).mcpAuth,
    ).toBeNull();
    expect(
      providersAwaitLoginUpgradeV20ToV21.upgradeRequest({
        providerId: "claude-code",
      }).mcpAuth,
    ).toBeNull();
  });

  it("accepts mcpAuth on login family carriers", () => {
    expect(
      providersStartLoginRequestSchema.parse({
        providerId: "droid",
        mcpAuth: {
          action: "login",
          scope: "global",
          workspaceRoot: null,
          serverName: "linear",
        },
      }).mcpAuth?.action,
    ).toBe("login");
    expect(
      providersStartLoginResponseSchema.parse({
        url: null,
        started: false,
        mcpAuth: {
          kind: "authorizationUrl",
          authorizationUrl: "https://example.com/oauth",
        },
      }).mcpAuth?.kind,
    ).toBe("authorizationUrl");
    expect(
      providersAwaitLoginRequestSchema.parse({
        providerId: "droid",
        mcpAuth: {
          scope: "global",
          workspaceRoot: null,
          serverName: "linear",
        },
      }).mcpAuth?.serverName,
    ).toBe("linear");
    expect(
      providersAwaitLoginResponseSchema.parse({
        state: null,
        mcpAuth: { kind: "pending" },
      }).mcpAuth?.kind,
    ).toBe("pending");
    expect(
      providersCancelLoginRequestSchema.parse({
        providerId: "droid",
        mcpAuth: {
          scope: "global",
          workspaceRoot: null,
          serverName: "linear",
        },
      }).mcpAuth?.serverName,
    ).toBe("linear");
    expect(
      providersCancelLoginResponseSchema.parse({
        cancelled: true,
        mcpAuth: { kind: "done" },
      }).mcpAuth?.kind,
    ).toBe("done");
  });

  it("wire scope is global|project only", () => {
    expect(providerNativeScopeSchema.safeParse("global").success).toBe(true);
    expect(providerNativeScopeSchema.safeParse("project").success).toBe(true);
    expect(providerNativeScopeSchema.safeParse("cwd").success).toBe(false);
  });

  it("rejects invalid scope/workspaceRoot on every nested native context", () => {
    const invalidCombos = [
      { scope: "project" as const, workspaceRoot: null },
      { scope: "project" as const, workspaceRoot: "" },
      { scope: "global" as const, workspaceRoot: "/repo" },
    ];
    const validGlobal = { scope: "global" as const, workspaceRoot: null };
    const validProject = {
      scope: "project" as const,
      workspaceRoot: "/repo",
    };

    for (const combo of invalidCombos) {
      expect(
        nativeListQuerySchema.safeParse({
          kind: "mcp",
          providerId: "claude-code",
          ...combo,
        }).success,
      ).toBe(false);
      expect(
        nativeMutationSchema.safeParse({
          kind: "mcp",
          ...combo,
          mutation: { action: "remove", name: "x" },
        }).success,
      ).toBe(false);
      expect(
        nativeAuthActionSchema.safeParse({
          action: "login",
          ...combo,
          serverName: "linear",
        }).success,
      ).toBe(false);
      expect(
        nativeAuthPollContextSchema.safeParse({
          ...combo,
          serverName: "linear",
        }).success,
      ).toBe(false);
      expect(
        nativeAuthCancelContextSchema.safeParse({
          ...combo,
          serverName: "linear",
        }).success,
      ).toBe(false);
    }

    expect(
      nativeListQuerySchema.safeParse({
        kind: "mcp",
        providerId: "claude-code",
        ...validGlobal,
      }).success,
    ).toBe(true);
    expect(
      nativeListQuerySchema.safeParse({
        kind: "mcpDiscover",
        providerId: "claude-code",
        ...validProject,
        serverName: "s",
        forceRefresh: false,
      }).success,
    ).toBe(true);
    expect(
      nativeMutationSchema.safeParse({
        kind: "plugins",
        ...validProject,
        mutation: { action: "remove", id: "p" },
      }).success,
    ).toBe(true);
    expect(
      nativeAuthActionSchema.safeParse({
        action: "submitCode",
        ...validGlobal,
        serverName: "linear",
        code: "123",
      }).success,
    ).toBe(true);
    expect(
      nativeAuthPollContextSchema.safeParse({
        ...validProject,
        serverName: "linear",
      }).success,
    ).toBe(true);
    expect(
      nativeAuthCancelContextSchema.safeParse({
        ...validGlobal,
        serverName: "linear",
      }).success,
    ).toBe(true);
  });

  it("accepts write transport with secrets and read transport with masks", () => {
    const mutation = nativeMutationSchema.parse({
      kind: "mcp",
      scope: "global",
      workspaceRoot: null,
      mutation: {
        action: "add",
        name: "playwright",
        transport: {
          type: "stdio",
          command: "npx",
          args: ["@playwright/mcp"],
          env: [{ name: "TOKEN", value: "secret" }],
        },
      },
    });
    expect(mutation.kind).toBe("mcp");
    if (mutation.kind !== "mcp" || mutation.mutation.action !== "add") {
      throw new Error("expected mcp add");
    }
    expect(mutation.mutation.transport.type).toBe("stdio");

    const result = providersSetEnabledResponseSchema.parse({
      state: providerCliStateSchema.parse({
        ...baseState("claude-code"),
        nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
      }),
      native: {
        ok: true,
        kind: "mcp",
        servers: [
          {
            name: "playwright",
            enabled: true,
            transport: {
              type: "stdio",
              command: "npx",
              env: [{ name: "TOKEN", hasValue: true }],
            },
            status: "unknown",
            statusSource: "none",
            statusDetail: null,
            tools: [],
            discoveryPending: false,
            instructions: null,
            configOnly: false,
            stdioDegraded: false,
          },
        ],
      },
    });
    expect(result.native?.ok).toBe(true);
  });

  it("requires inputSchema to be a JSON-Schema object or null", () => {
    expect(
      providerMcpToolSchema.safeParse({
        name: "t",
        description: null,
        inputSchema: { type: "object", properties: {} },
        enabled: true,
        readOnly: false,
      }).success,
    ).toBe(true);
    expect(
      providerMcpToolSchema.safeParse({
        name: "t",
        description: null,
        inputSchema: null,
        enabled: true,
        readOnly: false,
      }).success,
    ).toBe(true);
    expect(
      providerMcpToolSchema.safeParse({
        name: "t",
        description: null,
        inputSchema: "not-an-object",
        enabled: true,
        readOnly: false,
      }).success,
    ).toBe(false);
    // denySources defaults to [] when omitted (older hosts / other providers).
    const withDefault = providerMcpToolSchema.parse({
      name: "t",
      description: null,
      inputSchema: null,
      enabled: true,
      readOnly: false,
    });
    expect(withDefault.denySources).toEqual([]);
    const withSources = providerMcpToolSchema.parse({
      name: "t",
      description: null,
      inputSchema: null,
      enabled: false,
      readOnly: true,
      denySources: ["user", "local"],
    });
    expect(withSources.denySources).toEqual(["user", "local"]);
  });

  it("enumerates native error codes", () => {
    for (const code of [
      "duplicate_name",
      "unsupported_scope",
      "unsupported_action",
      "no_change_detected",
      "external_drift",
      "store_version_unsupported",
      "rollback_failed",
    ] as const) {
      expect(providerNativeErrorCodeSchema.parse(code)).toBe(code);
    }
  });
});

describe("B1: mutation@2.0 is amp-inclusive (host-v1.1.5 oracle)", () => {
  const fixtures = hostV115MutationV20Fixtures;
  const responseMethods = fixtures.mutationResponseMethods;
  const requestMethods = fixtures.mutationRequestMethods;

  it("regenerate-and-compare: checked-in fixture equals live generator output", async () => {
    // Catches ANY hand-edit to the checked-in fixture (not just enum/provenance
    // fields): re-run the full generator against host-v1.1.5 and deep-equal.
    const fixtureDir = dirname(fileURLToPath(import.meta.url));
    const traycerRoot = resolve(fixtureDir, "../../../../");
    const regenerated = await buildHostV115MutationV20Fixtures(traycerRoot);
    // Strip `as const` readonly by JSON round-trip for stable deep equality.
    expect(JSON.parse(JSON.stringify(fixtures))).toEqual(
      JSON.parse(JSON.stringify(regenerated)),
    );
    // Cross-check: every tag-derived mutation provider id remains valid in
    // the live schema. The live enum is allowed to grow beyond the tag's
    // snapshot (e.g. Devin/Pi post-date host-v1.1.5) since
    // `providerCliStateSchemaMutationV20` deliberately tracks it - it must
    // never shrink or rename what the tag already proved accepted.
    for (const providerId of fixtures.mutationProviderIds) {
      expect(providerIdSchema.options).toContain(providerId);
    }
    // list@2.0 is frozen, so its tag-derived set must equal the frozen enum
    // exactly - unlike the mutation set above, it must never grow.
    expect([...fixtures.listV20ProviderIds]).toEqual([
      ...providerIdSchemaV20.options,
    ]);
    expect(fixtures.mutationProviderIds).toContain("amp");
    expect(fixtures.listV20ProviderIds).not.toContain("amp");
  }, 30_000);

  it("tag-derived schemas reject deliberately invalid samples", async () => {
    // Generation-time guarantee: samples must parse against host-v1.1.5 schemas.
    // A wrong field type fails the tag-era parser (not the current branch).
    const fixtureDir = dirname(fileURLToPath(import.meta.url));
    const traycerRoot = resolve(fixtureDir, "../../../../");
    const taggedSource = gitShow(
      traycerRoot,
      `${HOST_V115_MUTATION_V20_TAG}:${HOST_V115_MUTATION_V20_SCHEMAS_PATH}`,
    );
    const tagSchemas = await importTaggedProviderSchemas(taggedSource);
    expect(() =>
      assertParseAgainstTagSchema(
        "providersSetApiKeyRequestSchema[bad]",
        tagSchemas.providersSetApiKeyRequestSchema,
        { providerId: "amp", apiKey: 123 },
      ),
    ).toThrow(/Tag-schema validation failed/);
    expect(() =>
      assertParseAgainstTagSchema(
        "providerCliStateSchema[bad-enabled]",
        tagSchemas.providerCliStateSchema,
        { ...baseState("amp"), enabled: "yes" },
      ),
    ).toThrow(/Tag-schema validation failed/);
  }, 30_000);

  it("covers all ten tag-derived @2.0 request samples with amp", () => {
    expect(requestMethods).toHaveLength(10);
    for (const method of requestMethods) {
      const sample =
        fixtures.requestSamplesByMethod[
          method as keyof typeof fixtures.requestSamplesByMethod
        ];
      const parser = MUTATION_V20_REQUEST_PARSER_BY_METHOD[method];
      expect(sample, method).toBeDefined();
      expect(parser, method).toBeDefined();
      const parsed = parser.parse(sample) as { providerId: string };
      expect(parsed.providerId).toBe("amp");
    }
  });

  it("accepts amp on all ten state-returning @2.0 mutation responses", () => {
    const ampState = providerCliStateSchemaMutationV20.parse(baseState("amp"));
    expect(ampState.providerId).toBe("amp");
    expect(responseMethods).toHaveLength(10);
    for (const method of responseMethods) {
      const entry = MUTATION_V20_RESPONSE_SCHEMA_BY_METHOD[method];
      expect(entry, method).toBeDefined();
      const parsed = entry.schema.parse({ state: ampState });
      expect(
        (parsed.state as { providerId: string } | null)?.providerId,
      ).toBe("amp");
      if (entry.nullableState) {
        const nullParsed = entry.schema.parse({ state: null });
        expect(nullParsed.state).toBeNull();
      }
    }
  });

  it("amp-accept matrix: every tag-derived provider × all ten @2.0 responses", () => {
    // The tag-derived set is a snapshot of what host-v1.1.5 shipped, so it
    // may be a strict subset of the live enum (which has since grown, e.g.
    // Devin/Pi) - it must never be empty or contain an id the live schema
    // doesn't recognize.
    expect(fixtures.mutationProviderIds.length).toBeGreaterThan(0);
    for (const providerId of fixtures.mutationProviderIds) {
      expect(providerIdSchema.options).toContain(providerId);
      const state = providerCliStateSchemaMutationV20.parse(
        baseState(providerId),
      );
      for (const method of responseMethods) {
        const entry = MUTATION_V20_RESPONSE_SCHEMA_BY_METHOD[method];
        expect(
          entry.schema.safeParse({ state }).success,
          `${method} rejects ${providerId}`,
        ).toBe(true);
      }
    }
  });

  it("list@2.0 remains pre-amp (providerIdSchemaV20 freeze from tag)", () => {
    // amp is in the mutation enum (tag latest) but not list@2.0's frozen set
    expect(fixtures.listV20ProviderIds).not.toContain("amp");
    expect(
      providerCliStateSchemaV20.safeParse(baseState("amp")).success,
    ).toBe(false);
    const preAmpId = fixtures.listV20ProviderIds[0];
    expect(
      providerCliStateSchemaV20.safeParse(baseState(preAmpId)).success,
    ).toBe(true);
  });

  it("@2.1-only fields strip for @2.0 callers via non-strict parse", () => {
    const latest = providerCliStateSchema.parse({
      ...baseState("amp"),
      nativeCapabilities: {
        supportedTabs: ["general", "mcp"],
        mcp: sampleMcpCapabilities,
        plugins: null,
        skills: null,
      },
    });
    const asMutationV20 = providerCliStateSchemaMutationV20.parse(latest);
    expect(asMutationV20).not.toHaveProperty("nativeCapabilities");
    expect(asMutationV20.providerId).toBe("amp");
    for (const method of responseMethods) {
      const entry = MUTATION_V20_RESPONSE_SCHEMA_BY_METHOD[method];
      const parsed = entry.schema.parse({ state: latest });
      expect(parsed.state).not.toBeNull();
      expect(parsed.state).not.toHaveProperty("nativeCapabilities");
      expect((parsed.state as { providerId: string }).providerId).toBe("amp");
    }
  });
});

describe("registry method-name fold", () => {
  it("does not advertise the eight unreleased native method names", () => {
    const names = Object.keys(hostRpcRegistry);
    for (const method of [
      "providers.mcpList",
      "providers.mcpMutate",
      "providers.mcpDiscover",
      "providers.mcpAuth",
      "providers.pluginsList",
      "providers.pluginsMutate",
      "providers.skillsList",
      "providers.skillsMutate",
    ]) {
      expect(names).not.toContain(method);
    }
  });

  it("retains every released-floor method name (113)", () => {
    // host-v1.0.0 / released-method-names fixture freezes 113 unary names as
    // the released floor - optional capabilities that landed later (e.g.
    // host.notifications.*, providers.submitLoginCode) are excluded from
    // this floor by design and legitimately grow hostRpcRegistry beyond it.
    // A subset check (every floor name still present) is the correct
    // invariant here, not exact-set equality - that's inherently fragile
    // against ordinary optional-method growth.
    const names = Object.keys(hostRpcRegistry);
    for (const method of releasedMethodNames) {
      expect(names).toContain(method);
    }
    expect(releasedMethodNames).toHaveLength(113);
  });
});
