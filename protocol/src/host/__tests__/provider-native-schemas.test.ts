import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  DEFAULT_PROVIDER_NATIVE_CAPABILITIES_V70_PREIMAGE,
  downgradeProviderCliStateToV10,
  providerCliStateSchema,
  providerMutationCliStateSchemaV20,
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
  providersListRequestSchemaBeforeV70,
  providersListResponseSchema,
  providersListResponseSchemaV70Preimage,
  providersListResponseSchemaV10,
  providersListResponseSchemaV20,
  providersListResponseSchemaV30,
  providersListResponseSchemaV50,
  providersListResponseSchemaV60,
  providersRemoveCustomPathRequestSchema,
  providersRemoveCustomPathResponseSchemaV20,
  providersSetApiKeyRequestSchema,
  providersSetApiKeyResponseSchemaV20,
  providersSetEnabledRequestSchema,
  providersMcpAuthRequestSchema,
  providersMcpAuthResponseSchema,
  providersAwaitMcpAuthRequestSchema,
  providersAwaitMcpAuthResponseSchema,
  providersCancelMcpAuthRequestSchema,
  providersCancelMcpAuthResponseSchema,
  providersNativeMutateRequestSchema,
  providersNativeMutateResponseSchema,
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
  providersListDowngradeV7ToV1,
  providersListDowngradeV7ToV2,
  providersListDowngradeV7ToV3,
  providersListDowngradeV7ToV6,
  providersListUpgradeV3ToV4,
  providersListUpgradeV5ToV6,
  providersListUpgradeV6ToV7,
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
import {
  providerIdSchema,
  providerIdSchemaV20,
} from "@traycer/protocol/host/provider-ids";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertParseAgainstTagSchema,
  buildHostV115MutationV20Fixtures,
  gitShow,
  HOST_V115_MUTATION_V20_SCHEMAS_PATH,
  HOST_V115_MUTATION_V20_TAG,
  hostV115TagObjectsAvailable,
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
        modelProviders: null,
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
        modelProviders: null,
      }).mcp?.perToolBacking,
    ).toBe("degraded-server-level");
  });
});

describe("providers.list@7.0 upgrade/downgrade bridges", () => {
  // `cli-v1.1.9` froze v6.0, so its schema models neither `nativeCapabilities`
  // nor `native`. `upgradeResponseToVersion` chains these callbacks by cast
  // with no re-parse, so filling here would not fail loudly - it would put the
  // fields on a released wire that never carried them. The fill has to wait
  // for v6.0 -> v7.0, and this pins the hop as a pass-through so a future
  // "helpful" fill here has to argue with a red test first.
  it("fills nothing on the v5.0 -> v6.0 hop (target is frozen)", () => {
    const v50 = providersListResponseSchemaV50.parse({
      providers: [baseState("amp")],
    });
    const upgraded = providersListUpgradeV5ToV6.upgradeResponse(v50);
    expect(upgraded.providers[0]).not.toHaveProperty("nativeCapabilities");
    expect(upgraded).not.toHaveProperty("native");
    expect(() => providersListResponseSchemaV60.parse(upgraded)).not.toThrow();
  });

  it("upgrades v6.0 responses with the default descriptor and native:null", () => {
    const v60 = providersListResponseSchemaV60.parse({
      providers: [baseState("amp")],
    });
    const upgraded = providersListUpgradeV6ToV7.upgradeResponse(v60);
    // The v7-era default plus `modelProviders: null` on top. Two fills, in one
    // hop: this bridge absorbed the v7 -> v8 hop's when that unreleased major
    // collapsed into v7.0, and the composition has to survive the merge.
    expect(upgraded.providers[0]?.nativeCapabilities).toEqual({
      ...DEFAULT_PROVIDER_NATIVE_CAPABILITIES_V70_PREIMAGE,
      modelProviders: null,
    });
    expect(upgraded.native).toBeNull();
    // Parsed against the LIVE shape, which is what v7.0 binds now that it is
    // the head line - the v7-era pin would accept a row missing the fill.
    expect(() => providersListResponseSchema.parse(upgraded)).not.toThrow();
  });

  // `native` rides v7.0 ALONE. It was authored against the live request object
  // while v6.0 was unreleased, so it silently grew the already-shipped
  // v4.0/v5.0/v6.0 request lines too - and `host-v1.1.10` then froze those
  // three lines WITHOUT it, because the commit that added it missed the
  // release cherry-pick. These three tests pin where the carrier is allowed to
  // exist, so the same drift cannot come back through a "helpful" fill.
  it("keeps native off every released request line below v7.0", () => {
    expect(
      providersListRequestSchemaBeforeV70.parse({
        forceAuthRefresh: true,
        native: {
          kind: "mcp",
          providerId: "claude-code",
          scope: "global",
          workspaceRoot: null,
        },
      }),
    ).not.toHaveProperty("native");
    expect(providersListRequestSchema.parse({}).native).toBeNull();
  });

  it("upgrades v3.0 requests as identity (both lines predate native)", () => {
    const upgraded = providersListUpgradeV3ToV4.upgradeRequest({
      forceAuthRefresh: true,
    });
    expect(upgraded).not.toHaveProperty("native");
    expect(upgraded.forceAuthRefresh).toBe(true);
  });

  it("upgrades v6.0 requests with native:null", () => {
    const upgraded = providersListUpgradeV6ToV7.upgradeRequest({});
    expect(upgraded.native).toBeNull();
  });

  it("downgrades v7.0 → v6.0 requests by stripping native", () => {
    const result = providersListDowngradeV7ToV6.downgradeRequest(
      providersListRequestSchema.parse({
        forceAuthRefresh: true,
        native: {
          kind: "mcp",
          providerId: "claude-code",
          scope: "global",
          workspaceRoot: null,
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toHaveProperty("native");
    expect(result.value.forceAuthRefresh).toBe(true);
  });

  // The adjacent hop, and the one most likely to rot: v6.0 is a RELEASED line
  // (`cli-v1.1.9`) that never carried either field, so it is the first client
  // a leak would actually reach. The far downgrades below cover v3/v2/v1.
  it("downgrades v7.0 → v6.0 by stripping nativeCapabilities and native", () => {
    const v70 = providersListResponseSchema.parse({
      providers: [
        {
          ...baseState("amp"),
          nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
        },
      ],
      native: { ok: true, kind: "mcp", servers: [] },
    });
    const result = providersListDowngradeV7ToV6.downgradeResponse(
      providersListResponseSchema.parse(v70),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.providers[0]).not.toHaveProperty("nativeCapabilities");
    expect(result.value).not.toHaveProperty("native");
    expect(() =>
      providersListResponseSchemaV60.parse(result.value),
    ).not.toThrow();
  });

  it("downgrades v7.0 → v3.0 by stripping nativeCapabilities and native", () => {
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
            modelProviders: null,
          },
        },
      ],
    });
    const result = providersListDowngradeV7ToV3.downgradeResponse(
      providersListResponseSchema.parse(v31),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.providers[0]).not.toHaveProperty("nativeCapabilities");
    expect(result.value).not.toHaveProperty("native");
    expect(() =>
      providersListResponseSchemaV30.parse(result.value),
    ).not.toThrow();
  });

  it("downgrades v7.0 → v2.0 dropping Amp and nativeCapabilities", () => {
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
    });
    const result = providersListDowngradeV7ToV2.downgradeResponse(
      providersListResponseSchema.parse(v31),
    );
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
        modelProviders: null,
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
    });
    const listResult = providersListDowngradeV7ToV1.downgradeResponse(
      providersListResponseSchema.parse(list),
    );
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
            modelProviders: null,
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
          modelProviders: null,
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

  // Regression guard for the compat break this surface originally shipped:
  // `native` was folded onto the RELEASED `providers.setEnabled@2.1` and
  // `enabled` was demoted to optional so native-only callers could omit it.
  // Both are wire breaks against every `cli-v1.1.7+` / `host-v1.1.7+` peer.
  // Native mutations live on `providers.nativeMutate@1.0` now.
  it("keeps setEnabled@2.1 at its released shape: enabled required, no native", () => {
    expect(
      providersSetEnabledRequestSchema.safeParse({
        providerId: "claude-code",
        enabled: true,
      }).success,
    ).toBe(true);
    // Omitting `enabled` must FAIL. If this ever passes, this tree emits
    // payloads a released peer cannot parse.
    expect(
      providersSetEnabledRequestSchema.safeParse({
        providerId: "claude-code",
      }).success,
    ).toBe(false);
    expect(
      providersSetEnabledRequestSchema.safeParse({
        providerId: "claude-code",
        enabled: null,
      }).success,
    ).toBe(false);
    // `native` is not part of this carrier - a non-strict object ignores it
    // rather than rejecting, so assert it is dropped, not carried.
    expect(
      providersSetEnabledRequestSchema.parse({
        providerId: "claude-code",
        enabled: true,
        native: {
          kind: "mcp",
          scope: "global",
          workspaceRoot: null,
          mutation: { action: "remove", name: "playwright" },
        },
      }),
    ).not.toHaveProperty("native");
    expect(
      providersSetEnabledResponseSchema.parse({
        state: providerCliStateSchema.parse(baseState("cursor")),
        native: { ok: true, kind: "mcp", servers: [] },
      }),
    ).not.toHaveProperty("native");
  });

  it("upgrades setEnabled 2.0→2.1 without a native field", () => {
    const classic = providersSetEnabledRequestSchemaV20.parse({
      providerId: "cursor",
      enabled: false,
    });
    const upgraded = providersSetEnabledUpgradeV20ToV21.upgradeRequest(classic);
    expect(upgraded).toEqual({
      providerId: "cursor",
      enabled: false,
      profileAction: null,
    });
    const upgradedResp = providersSetEnabledUpgradeV20ToV21.upgradeResponse({
      state: providerMutationCliStateSchemaV20.parse(baseState("cursor")),
    });
    expect(upgradedResp).not.toHaveProperty("native");
    // The mutation echo is pinned to the frozen `providerMutationCliStateSchemaV21`,
    // which deliberately does NOT model `nativeCapabilities` - a state echo
    // cannot change what is installed, so capability facts ride
    // `providers.list` only.
    expect(upgradedResp.state).not.toHaveProperty("nativeCapabilities");
  });

  it("downgrades a classic setEnabled 2.1 request to 2.0", () => {
    const result = providersSetEnabledDowngradeV21ToV20.downgradeRequest({
      providerId: "claude-code",
      enabled: true,
      profileAction: null,
    });
    expect(result.ok).toBe(true);
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

  // Companion guard to the setEnabled one above: the three released login
  // minors must not grow a native field either.
  it("keeps the login family carriers free of mcpAuth", () => {
    expect(
      providersStartLoginUpgradeV10ToV11.upgradeRequest({
        providerId: "claude-code",
      }),
    ).not.toHaveProperty("mcpAuth");
    expect(
      providersStartLoginUpgradeV10ToV11.upgradeResponse({
        url: null,
        started: true,
      }),
    ).not.toHaveProperty("mcpAuth");
    expect(
      providersCancelLoginUpgradeV10ToV11.upgradeRequest({
        providerId: "claude-code",
      }),
    ).not.toHaveProperty("mcpAuth");
    expect(
      providersAwaitLoginUpgradeV20ToV21.upgradeRequest({
        providerId: "claude-code",
      }),
    ).not.toHaveProperty("mcpAuth");
    // Non-strict objects ignore unknown keys, so prove the field is DROPPED
    // by the parse rather than merely unvalidated. Every carrier the compat
    // gate flagged is asserted here, request AND response: a `.default(null)`
    // field reintroduced on any one of them re-breaks the released line, and
    // the upgrade-path assertions above cannot see that (they spread a plain
    // object and never run the schema).
    expect(
      providersStartLoginRequestSchema.parse({
        providerId: "droid",
        mcpAuth: {
          action: "login",
          scope: "global",
          workspaceRoot: null,
          serverName: "linear",
        },
      }),
    ).not.toHaveProperty("mcpAuth");
    expect(
      providersStartLoginResponseSchema.parse({
        url: null,
        started: false,
        mcpAuth: { kind: "done" },
      }),
    ).not.toHaveProperty("mcpAuth");
    expect(
      providersAwaitLoginRequestSchema.parse({
        providerId: "droid",
        mcpAuth: { scope: "global", workspaceRoot: null, serverName: "linear" },
      }),
    ).not.toHaveProperty("mcpAuth");
    expect(
      providersAwaitLoginResponseSchema.parse({
        state: null,
        mcpAuth: { kind: "pending" },
      }),
    ).not.toHaveProperty("mcpAuth");
    expect(
      providersCancelLoginRequestSchema.parse({
        providerId: "droid",
        mcpAuth: { scope: "global", workspaceRoot: null, serverName: "linear" },
      }),
    ).not.toHaveProperty("mcpAuth");
    expect(
      providersCancelLoginResponseSchema.parse({
        cancelled: true,
        mcpAuth: { kind: "done" },
      }),
    ).not.toHaveProperty("mcpAuth");
  });

  it("carries the native payloads on the dedicated optional methods", () => {
    expect(
      providersMcpAuthRequestSchema.parse({
        providerId: "droid",
        action: {
          action: "login",
          scope: "global",
          workspaceRoot: null,
          serverName: "linear",
        },
      }).action.action,
    ).toBe("login");
    expect(
      providersMcpAuthResponseSchema.parse({
        result: {
          kind: "authorizationUrl",
          authorizationUrl: "https://example.com/oauth",
        },
      }).result.kind,
    ).toBe("authorizationUrl");
    expect(
      providersAwaitMcpAuthRequestSchema.parse({
        providerId: "droid",
        context: { scope: "global", workspaceRoot: null, serverName: "linear" },
      }).context.serverName,
    ).toBe("linear");
    expect(
      providersAwaitMcpAuthResponseSchema.parse({ result: { kind: "pending" } })
        .result.kind,
    ).toBe("pending");
    expect(
      providersCancelMcpAuthRequestSchema.parse({
        providerId: "droid",
        context: { scope: "global", workspaceRoot: null, serverName: "linear" },
      }).context.serverName,
    ).toBe("linear");
    const cancelled = providersCancelMcpAuthResponseSchema.parse({
      cancelled: true,
      result: { kind: "done" },
    });
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.result.kind).toBe("done");
    expect(
      providersNativeMutateRequestSchema.parse({
        providerId: "claude-code",
        mutation: {
          kind: "mcp",
          scope: "global",
          workspaceRoot: null,
          mutation: { action: "remove", name: "playwright" },
        },
      }).mutation.kind,
    ).toBe("mcp");
    expect(
      providersNativeMutateResponseSchema.parse({
        result: { ok: true, kind: "mcp", servers: [] },
      }).result,
    ).toEqual({ ok: true, kind: "mcp", servers: [] });
  });

  // `result` is deliberately REQUIRED on these methods: they exist only to
  // serve native actions, so "no payload" is not a reachable success state.
  it("requires a result on every dedicated native response", () => {
    expect(providersMcpAuthResponseSchema.safeParse({}).success).toBe(false);
    expect(providersAwaitMcpAuthResponseSchema.safeParse({}).success).toBe(
      false,
    );
    expect(
      providersCancelMcpAuthResponseSchema.safeParse({ cancelled: true })
        .success,
    ).toBe(false);
    expect(providersNativeMutateResponseSchema.safeParse({}).success).toBe(
      false,
    );
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

    const result = providersNativeMutateResponseSchema.parse({
      result: {
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
    expect(result.result.ok).toBe(true);
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
      "config_unreadable",
    ] as const) {
      expect(providerNativeErrorCodeSchema.parse(code)).toBe(code);
    }
  });
});

describe("B1: mutation@2.0 is amp-inclusive (host-v1.1.5 oracle)", () => {
  const fixtures = hostV115MutationV20Fixtures;
  const responseMethods = fixtures.mutationResponseMethods;
  const requestMethods = fixtures.mutationRequestMethods;
  // Everything below that reads the tag itself needs this clone to actually
  // have the host-v1.1.5 objects. `actions/checkout` fetches no tags, so the
  // `@traycer/protocol` leg of `test.yml` fetches the one tag explicitly to
  // keep these two live in CI — skipping them there would have left generator
  // drift uncaught, since `guarded-files-tripwire` only stops the checked-in
  // fixture being hand-edited. The skip remains for local clones without the
  // tag, so a shallow checkout reports "no evidence" rather than a failure.
  const traycerRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../",
  );
  const tagReachable = hostV115TagObjectsAvailable(traycerRoot);

  it.skipIf(!tagReachable)(
    "regenerate-and-compare: checked-in fixture equals live generator output",
    async () => {
      // Catches ANY hand-edit to the checked-in fixture (not just
      // enum/provenance fields): re-run the full generator against
      // host-v1.1.5 and deep-equal.
      const regenerated = await buildHostV115MutationV20Fixtures(traycerRoot);
      // Strip `as const` readonly by JSON round-trip for stable deep equality.
      expect(JSON.parse(JSON.stringify(fixtures))).toEqual(
        JSON.parse(JSON.stringify(regenerated)),
      );
      // Cross-check: every tag-derived mutation provider id remains valid in
      // the live schema. The live enum is allowed to grow beyond the tag's
      // snapshot (e.g. Devin/Pi post-date host-v1.1.5) since
      // `providerMutationCliStateSchemaV20` deliberately tracks it - it must
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
    },
    30_000,
  );

  it.skipIf(!tagReachable)(
    "tag-derived schemas reject deliberately invalid samples",
    async () => {
      // Generation-time guarantee: samples must parse against host-v1.1.5
      // schemas. A wrong field type fails the tag-era parser (not the current
      // branch).
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
    },
    30_000,
  );

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
    const ampState = providerMutationCliStateSchemaV20.parse(baseState("amp"));
    expect(ampState.providerId).toBe("amp");
    expect(responseMethods).toHaveLength(10);
    for (const method of responseMethods) {
      const entry = MUTATION_V20_RESPONSE_SCHEMA_BY_METHOD[method];
      expect(entry, method).toBeDefined();
      const parsed = entry.schema.parse({ state: ampState });
      expect((parsed.state as { providerId: string } | null)?.providerId).toBe(
        "amp",
      );
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
      const state = providerMutationCliStateSchemaV20.parse(
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
    expect(providerCliStateSchemaV20.safeParse(baseState("amp")).success).toBe(
      false,
    );
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
        modelProviders: null,
      },
    });
    const asMutationV20 = providerMutationCliStateSchemaV20.parse(latest);
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
  // This used to assert the native surface added NO method names at all,
  // because a new name was once handshake-fatal against a released peer, so
  // every native payload folded onto an existing carrier. The optional
  // capability channel lifted that constraint, and folding turned out to be
  // the more dangerous option - it grew four ALREADY-RELEASED wire shapes.
  //
  // The invariant that replaces it: a native method may exist, but only off
  // the released floor and only with a degrade story, which is exactly what
  // keeps it non-fatal for a peer that lacks it.
  it("keeps every native method off the released floor with a degrade story", () => {
    const nativeMethods = [
      "providers.mcpAuth",
      "providers.awaitMcpAuth",
      "providers.cancelMcpAuth",
      "providers.nativeMutate",
    ] as const;
    for (const method of nativeMethods) {
      const entry = hostRpcRegistry[method];
      expect(entry).toBeDefined();
      // On the floor => a peer that lacks it fails the WHOLE handshake.
      expect(releasedMethodNames).not.toContain(method);
      // No degrade story => `checkOptionalUnary` raises a blocking finding.
      expect(entry.degrade).toEqual({ kind: "unsupported" });
    }
  });

  // The list/discover surface still rides `providers.list`, but on a brand-new
  // MAJOR (7.0), which is additive rather than a change to a released line.
  it("carries native list/discover on an unreleased providers.list major", () => {
    const listMajors = Object.keys(hostRpcRegistry["providers.list"])
      .filter((key) => /^\d+$/.test(key))
      .map(Number);
    expect(Math.max(...listMajors)).toBeGreaterThan(6);
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
