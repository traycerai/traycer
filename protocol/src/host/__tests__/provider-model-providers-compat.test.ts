import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as nativeSchemaModule from "@traycer/protocol/host/provider-native-schemas";
import * as providerIdModule from "@traycer/protocol/host/provider-ids";
import * as providerSchemaModule from "@traycer/protocol/host/provider-schemas";
import {
  downgradeResponseAcrossMajors,
  upgradeResponseToVersion,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  DEFAULT_PROVIDER_NATIVE_CAPABILITIES_V70,
  modelProviderAuthActionSchema,
  modelProviderAuthResultSchema,
  modelProviderEntrySchema,
  modelProviderAuthErrorCodeSchema,
  modelProviderListErrorCodeSchema,
  modelProviderPromptSchema,
  modelProvidersListResultSchema,
  nativeListQuerySchema,
  nativeListQuerySchemaV70,
  nativeListResultSchema,
  nativeListResultSchemaV70,
  projectProviderNativeCapabilitiesToV70,
  tryProjectProviderNativeCapabilitiesToV70,
  providerMcpCapabilitiesSchema,
  providerMcpCapabilitiesSchemaV70,
  providerMcpServerSchema,
  providerMcpServerSchemaV70,
  providerMcpToolSchema,
  providerMcpToolSchemaV70,
  providerPluginSchema,
  providerPluginSchemaV70,
  providerSkillSchema,
  providerSkillSchemaV70,
  providerModelProvidersCapabilitiesSchema,
  providerNativeCapabilitiesSchema,
  providerNativeCapabilitiesSchemaV70,
  providerEnvOverrideScopeSchema,
  providerEnvOverrideScopeSchemaV70,
  providerNativeErrorCodeSchema,
  providerPluginsCapabilitiesSchema,
  providerPluginsCapabilitiesSchemaV70,
  providerSettingsTabSchema,
  providerSkillsCapabilitiesSchema,
  providerSkillsCapabilitiesSchemaV70,
  providerSettingsTabSchemaV70,
  type ProviderNativeCapabilities,
} from "@traycer/protocol/host/provider-native-schemas";
import { providerIdSchema, providerIdSchemaV70 } from "@traycer/protocol/host/provider-ids";
import {
  PROVIDER_AUTH_SCHEMA_V20,
  providerCliStateSchema,
  providerCliStateSchemaV70,
  providersAwaitModelProviderAuthRequestSchema,
  providersAwaitModelProviderAuthResponseSchema,
  providersCancelModelProviderAuthRequestSchema,
  providersCancelModelProviderAuthResponseSchema,
  providersListModelProvidersRequestSchema,
  providersListModelProvidersResponseSchema,
  providersListResponseSchema,
  providersListResponseSchemaV10,
  providersListResponseSchemaV20,
  providersListResponseSchemaV30,
  providersListResponseSchemaV40,
  providersListResponseSchemaV50,
  providersListResponseSchemaV60,
  providersListRequestSchema,
  providersListRequestSchemaV70,
  providersListResponseSchemaV70,
  providersModelProviderAuthRequestSchema,
  providersModelProviderAuthResponseSchema,
} from "@traycer/protocol/host/provider-schemas";

/**
 * Model Providers protocol ticket coverage (T1).
 *
 * The load-bearing claim this file exists to hold: the `modelProviders` tab id
 * can never reach a client that negotiated `providers.list@7.0` or lower. It is
 * not an additive value there. `supportedTabs` is an array of a CLOSED enum
 * nested inside `nativeCapabilities`, and `providerCliStateSchema` decodes that
 * whole object through one `.catch(DEFAULT)` - so an unknown member does not
 * degrade to "tab ignored", it takes MCP, Plugins and Skills down with it for
 * that provider.
 */

/**
 * Peel `.nullable()` / `.default()` / `.catch()` wrappers off a field schema to
 * reach the schema object underneath, so a test can assert WHICH schema a
 * frozen line is wired to rather than only how it behaves.
 */
function unwrapSchema(schema: z.ZodType): z.ZodType {
  let current: z.ZodType = schema;
  while (
    current instanceof z.ZodNullable ||
    current instanceof z.ZodOptional ||
    current instanceof z.ZodDefault ||
    current instanceof z.ZodCatch
  ) {
    // `.unwrap()` is typed against zod's internal base, so narrow rather than
    // cast - the point of using the public accessor was to stop reaching into
    // `def`, not to trade one escape hatch for another.
    const inner: unknown = current.unwrap();
    if (!(inner instanceof z.ZodType)) return current;
    current = inner;
  }
  return current;
}

const MCP_CAPABILITIES = {
  transports: ["stdio"] as const,
  authTypes: ["none"] as const,
  authActions: [] as const,
  actionScopes: {
    list: ["global"] as const,
    add: ["global"] as const,
    update: ["global"] as const,
    remove: ["global"] as const,
    toggleServer: ["global"] as const,
    toggleTool: ["global"] as const,
    discover: ["global"] as const,
    auth: [] as const,
  },
  addServer: "cli" as const,
  removeServer: "cli" as const,
  updateServer: "patch" as const,
  perToolBacking: "native" as const,
  statusSource: "native" as const,
  toolsSource: "native" as const,
  schemasSource: "native" as const,
  instructionsSource: "probe" as const,
  traycerSessionsOnlyEnforcement: false,
  stdioDegradeNotice: false,
  oauthDegradesToConfigOnly: false,
};

const SKILLS_CAPABILITIES = {
  actionScopes: {
    list: ["global"] as const,
    add: ["global"] as const,
    create: ["global"] as const,
    import: [] as const,
    remove: ["global"] as const,
  },
};

/** What an `opencode` host on v8.0 advertises once the tab is live. */
const OPENCODE_CAPABILITIES = providerNativeCapabilitiesSchema.parse({
  supportedTabs: ["general", "env", "usage", "mcp", "skills", "modelProviders"],
  mcp: MCP_CAPABILITIES,
  plugins: null,
  skills: SKILLS_CAPABILITIES,
  modelProviders: { actions: ["connect", "oauth", "disconnect"] },
});

function providerState(providerId: string) {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" as const },
    candidates: [],
    auth: {
      status: "unknown" as const,
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
  };
}

const opencodeState = providerCliStateSchema.parse({
  ...providerState("opencode"),
  nativeCapabilities: OPENCODE_CAPABILITIES,
});

/** The same host's `claude-code` row: no Model Providers surface at all. */
const claudeState = providerCliStateSchema.parse({
  ...providerState("claude-code"),
  nativeCapabilities: {
    supportedTabs: ["general", "env", "usage", "mcp"],
    mcp: MCP_CAPABILITIES,
    plugins: null,
    skills: null,
    modelProviders: null,
  },
});

const liveResponse = providersListResponseSchema.parse({
  providers: [opencodeState, claudeState],
  native: null,
});

describe("modelProviders tab id and capability block", () => {
  it("is on the live tab enum and absent from the frozen v7.0 one", () => {
    expect(providerSettingsTabSchema.safeParse("modelProviders").success).toBe(
      true,
    );
    expect(
      providerSettingsTabSchemaV70.safeParse("modelProviders").success,
    ).toBe(false);
  });

  it("requires the capability key rather than tolerating an absent one", () => {
    // Required-and-nullable, like its mcp/plugins/skills siblings. An absent
    // key would fail the whole capability object on a v8.0 client, which the
    // state-level `.catch()` then serves as the empty default - so a producer
    // that forgets the fill must fail here, loudly, not in the field.
    expect(
      providerNativeCapabilitiesSchema.safeParse({
        supportedTabs: ["general"],
        mcp: null,
        plugins: null,
        skills: null,
      }).success,
    ).toBe(false);
  });

  it("accepts an empty action list as a read-only catalog", () => {
    expect(
      providerModelProvidersCapabilitiesSchema.parse({ actions: [] }).actions,
    ).toEqual([]);
    expect(
      providerModelProvidersCapabilitiesSchema.safeParse({
        actions: ["connect", "oauth", "disconnect"],
      }).success,
    ).toBe(true);
    expect(
      providerModelProvidersCapabilitiesSchema.safeParse({
        actions: ["reconnect"],
      }).success,
    ).toBe(false);
  });

  it("carries modelProviders: null on both defaults, in the shape of their own line", () => {
    expect(DEFAULT_PROVIDER_NATIVE_CAPABILITIES.modelProviders).toBeNull();
    expect(DEFAULT_PROVIDER_NATIVE_CAPABILITIES_V70).not.toHaveProperty(
      "modelProviders",
    );
  });
});

describe("the v7.0 collapse this transition exists to prevent", () => {
  it("shows what an unprojected tab id would cost a v7.0 client", () => {
    // NOT a downgrade - the raw payload, handed to the frozen v7.0 state as if
    // the bridge had simply reparsed it. The tab id fails the enum, the array
    // fails, the capability object fails, and `.catch()` serves the empty
    // default: MCP and Skills are gone, silently, for that provider.
    const collapsed = providerCliStateSchemaV70.parse({
      ...providerState("opencode"),
      nativeCapabilities: OPENCODE_CAPABILITIES,
    });
    expect(collapsed.nativeCapabilities).toEqual(
      DEFAULT_PROVIDER_NATIVE_CAPABILITIES_V70,
    );
    expect(collapsed.nativeCapabilities.mcp).toBeNull();
    expect(collapsed.nativeCapabilities.skills).toBeNull();
  });

  it("projects the tab away instead, keeping every other capability intact", () => {
    const projected =
      projectProviderNativeCapabilitiesToV70(OPENCODE_CAPABILITIES);
    expect(projected.supportedTabs).toEqual([
      "general",
      "env",
      "usage",
      "mcp",
      "skills",
    ]);
    expect(projected).not.toHaveProperty("modelProviders");
    expect(projected.mcp).toEqual(OPENCODE_CAPABILITIES.mcp);
    expect(projected.skills).toEqual(OPENCODE_CAPABILITIES.skills);
    expect(providerNativeCapabilitiesSchemaV70.safeParse(projected).success).toBe(
      true,
    );
  });
});

describe("providers.list 8.0 -> 7.0", () => {
  it("hands a v7.0 client byte-identical capabilities for a provider without the tab", () => {
    // The parity claim in its strongest form: a provider that never advertised
    // the new tab must come out of the v8 wire exactly as it went in on v7.
    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["providers.list"],
      8,
      7,
      liveResponse,
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    const claudeRow = downgraded.value.providers.find(
      (provider) => provider.providerId === "claude-code",
    );
    expect(claudeRow?.nativeCapabilities).toEqual(
      providerNativeCapabilitiesSchemaV70.parse({
        supportedTabs: ["general", "env", "usage", "mcp"],
        mcp: MCP_CAPABILITIES,
        plugins: null,
        skills: null,
      }),
    );
  });

  it("cuts the tab id and the block from the provider that does advertise them", () => {
    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["providers.list"],
      8,
      7,
      liveResponse,
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    const opencodeRow = downgraded.value.providers.find(
      (provider) => provider.providerId === "opencode",
    );
    expect(opencodeRow?.nativeCapabilities.supportedTabs).not.toContain(
      "modelProviders",
    );
    expect(opencodeRow?.nativeCapabilities).not.toHaveProperty(
      "modelProviders",
    );
    // The rest of the row survives - this is a projection, not the collapse.
    expect(opencodeRow?.nativeCapabilities.mcp).toEqual(
      OPENCODE_CAPABILITIES.mcp,
    );
    expect(opencodeRow?.nativeCapabilities.skills).toEqual(
      OPENCODE_CAPABILITIES.skills,
    );
    expect(
      providersListResponseSchemaV70.safeParse(downgraded.value).success,
    ).toBe(true);
  });

  it("keeps the string out of the serialized v7.0 payload entirely", () => {
    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["providers.list"],
      8,
      7,
      liveResponse,
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(JSON.stringify(downgraded.value)).not.toContain("modelProviders");
  });
});

describe("providers.list 8.0 -> every older major", () => {
  const FROZEN_RESPONSES = {
    1: providersListResponseSchemaV10,
    2: providersListResponseSchemaV20,
    3: providersListResponseSchemaV30,
    4: providersListResponseSchemaV40,
    5: providersListResponseSchemaV50,
    6: providersListResponseSchemaV60,
    7: providersListResponseSchemaV70,
  } as const;

  it.each([1, 2, 3, 4, 5, 6, 7] as const)(
    "8.0 -> v%i.0 is registered, succeeds, and reparses through that line's frozen schema",
    (targetMajor) => {
      // Every major gets a DIRECT path (the registry composes nothing), so a
      // missing key here is not a degraded response - it is no response that
      // peer can decode at all.
      expect(
        hostRpcRegistry["providers.list"][8].downgradePathsFromLatest[
          targetMajor
        ],
      ).toBeDefined();
      const downgraded = downgradeResponseAcrossMajors(
        hostRpcRegistry["providers.list"],
        8,
        targetMajor,
        liveResponse,
      );
      expect(downgraded.ok).toBe(true);
      if (!downgraded.ok) return;
      expect(
        FROZEN_RESPONSES[targetMajor].safeParse(downgraded.value).success,
      ).toBe(true);
      expect(JSON.stringify(downgraded.value)).not.toContain("modelProviders");
    },
  );

  it("still delivers both providers to a v6.0 client, minus nativeCapabilities", () => {
    // The tab transition must not cost an older client a provider ROW. The
    // frozen sub-v7.0 lines never modeled `nativeCapabilities` at all, so they
    // drop it wholesale and the ids survive untouched.
    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["providers.list"],
      8,
      6,
      liveResponse,
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(
      downgraded.value.providers.map((provider) => provider.providerId),
    ).toEqual(["opencode", "claude-code"]);
    expect(downgraded.value.providers[0]).not.toHaveProperty(
      "nativeCapabilities",
    );
  });
});

describe("providers.list every older major -> 8.0", () => {
  it("fills modelProviders: null as an OWN key on the v7 -> v8 hop", () => {
    // A missing key and an explicit null are what a consumer gate has to tell
    // apart, and `upgradeResponseToVersion` chains bridges by cast with no
    // re-parse - so the fill has to be real, not a schema default that never
    // runs.
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.list"],
      { major: 7, minor: 0 },
      { major: 8, minor: 0 },
      providersListResponseSchemaV70.parse({
        providers: [
          {
            ...providerState("opencode"),
            nativeCapabilities: {
              supportedTabs: ["general", "env", "mcp"],
              mcp: MCP_CAPABILITIES,
              plugins: null,
              skills: null,
            },
          },
        ],
        native: null,
      }),
    );
    const capabilities = upgraded.providers[0].nativeCapabilities;
    expect(Object.keys(capabilities)).toContain("modelProviders");
    expect(capabilities.modelProviders).toBeNull();
    // Everything the v7.0 host did advertise is untouched by the fill.
    expect(capabilities.mcp).toEqual(OPENCODE_CAPABILITIES.mcp);
    expect(providersListResponseSchema.safeParse(upgraded).success).toBe(true);
  });

  it.each([1, 2, 3, 4, 5, 6] as const)(
    "upgrades a v%i.0 response to 8.0 with modelProviders null",
    (sourceMajor) => {
      const frozen = {
        1: providersListResponseSchemaV10,
        2: providersListResponseSchemaV20,
        3: providersListResponseSchemaV30,
        4: providersListResponseSchemaV40,
        5: providersListResponseSchemaV50,
        6: providersListResponseSchemaV60,
      }[sourceMajor];
      const upgraded = upgradeResponseToVersion(
        hostRpcRegistry["providers.list"],
        { major: sourceMajor, minor: 0 },
        { major: 8, minor: 0 },
        frozen.parse({ providers: [providerState("codex")] }),
      );
      expect(
        upgraded.providers[0].nativeCapabilities.modelProviders,
      ).toBeNull();
      expect(providersListResponseSchema.safeParse(upgraded).success).toBe(
        true,
      );
    },
  );
});

describe("the four Model Providers methods are optional capabilities", () => {
  const METHODS = [
    "providers.listModelProviders",
    "providers.modelProviderAuth",
    "providers.awaitModelProviderAuth",
    "providers.cancelModelProviderAuth",
  ] as const;

  it.each(METHODS)(
    "%s is registered at 1.0, degrades unsupported, and stays off the released floor",
    (method) => {
      // A brand-new method NAME is handshake-fatal against a released peer
      // unless it rides the optional-capability channel. `unsupported` is what
      // turns "this host is too old" into a per-call answer with upgrade
      // guidance instead of a dead connection.
      const entry = hostRpcRegistry[method];
      expect(entry).toBeDefined();
      expect(entry.degrade).toEqual({ kind: "unsupported" });
      expect(entry[1].versions[0].contract.schemaVersion).toEqual({
        major: 1,
        minor: 0,
      });
      expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(method);
    },
  );
});

describe("prompts DSL wire schema", () => {
  it("parses a text prompt with and without its optional facts", () => {
    expect(
      modelProviderPromptSchema.parse({
        type: "text",
        key: "region",
        message: "Region",
        placeholder: "us-east-1",
        when: { key: "mode", op: "eq", value: "advanced" },
      }),
    ).toEqual({
      type: "text",
      key: "region",
      message: "Region",
      placeholder: "us-east-1",
      when: { key: "mode", op: "eq", value: "advanced" },
    });
    expect(
      modelProviderPromptSchema.safeParse({
        type: "text",
        key: "region",
        message: "Region",
        placeholder: null,
        when: null,
      }).success,
    ).toBe(true);
  });

  it("requires the nullable keys rather than accepting an absent one", () => {
    // Required-and-nullable: upstream marks these optional, and the host
    // adapts. An omitted key here would mean an unmapped SDK field passes as
    // "not applicable" without anyone deciding that.
    expect(
      modelProviderPromptSchema.safeParse({
        type: "text",
        key: "region",
        message: "Region",
      }).success,
    ).toBe(false);
  });

  it("parses a select prompt with option hints and a neq condition", () => {
    const parsed = modelProviderPromptSchema.parse({
      type: "select",
      key: "mode",
      message: "Mode",
      options: [
        { label: "Basic", value: "basic", hint: null },
        { label: "Advanced", value: "advanced", hint: "more fields" },
      ],
      when: { key: "region", op: "neq", value: "" },
    });
    expect(parsed.type).toBe("select");
    if (parsed.type !== "select") return;
    expect(parsed.options[1].hint).toBe("more fields");
  });

  it("rejects an unmodeled prompt type and an unmodeled condition operator", () => {
    expect(
      modelProviderPromptSchema.safeParse({
        type: "checkbox",
        key: "k",
        message: "m",
        placeholder: null,
        when: null,
      }).success,
    ).toBe(false);
    expect(
      modelProviderPromptSchema.safeParse({
        type: "text",
        key: "k",
        message: "m",
        placeholder: null,
        when: { key: "other", op: "contains", value: "x" },
      }).success,
    ).toBe(false);
  });
});

describe("providers.listModelProviders payloads", () => {
  it("carries an entry with its source, flags and advertised methods", () => {
    const entry = modelProviderEntrySchema.parse({
      id: "anthropic",
      name: "Anthropic",
      source: "api",
      hasStoredCredential: true,
      canDisconnect: true,
      connected: true,
      methods: [
        {
          type: "api",
          label: "API Key",
          prompts: [],
        },
      ],
    });
    expect(entry.source).toBe("api");
    expect(entry.methods[0].prompts).toEqual([]);
  });

  it("reports an externally-sourced credential as read-only, never as storable", () => {
    // `env`/`config` describe a credential living outside anything this tab
    // can write. The row can still say `connected`, and it is `canDisconnect`
    // - not the source string - a renderer gates its disconnect affordance on.
    const entry = modelProviderEntrySchema.parse({
      id: "openai",
      name: "OpenAI",
      source: "env",
      hasStoredCredential: false,
      canDisconnect: false,
      connected: true,
      methods: [],
    });
    expect(entry.canDisconnect).toBe(false);
    expect(entry.connected).toBe(true);
  });

  it("can say connected-but-not-removable, which is why the two flags are separate", () => {
    // The autoload-`custom` residual, and the case that makes
    // `hasStoredCredential` and `canDisconnect` genuinely different questions
    // rather than two names for `source === "api"`. A provider autoloaded by a
    // plugin has nothing in the auth store to delete, so `auth.remove` is a
    // no-op and the row stays connected afterwards - a disconnect button there
    // is a click that reports success and changes nothing.
    const entry = modelProviderEntrySchema.parse({
      id: "some-loader-provider",
      name: "Loader Provider",
      source: "custom",
      hasStoredCredential: false,
      canDisconnect: false,
      connected: true,
      methods: [],
    });
    expect(entry.connected).toBe(true);
    expect(entry.canDisconnect).toBe(false);
    expect(entry.hasStoredCredential).toBe(false);
  });

  it("can also say custom-and-removable - the source does not decide either flag", () => {
    // Same source, both flags true: a `custom` row whose credential the host
    // CAN remove. If `source` decided the flags, one of these two rows would
    // be unrepresentable, and a renderer that read the source instead of the
    // flags would get exactly one of them wrong.
    const entry = modelProviderEntrySchema.parse({
      id: "some-loader-provider",
      name: "Loader Provider",
      source: "custom",
      hasStoredCredential: true,
      canDisconnect: true,
      connected: true,
      methods: [],
    });
    expect(entry.canDisconnect).toBe(true);
  });

  it("accepts a null source for an unauthenticated provider and rejects an unmodeled one", () => {
    expect(
      modelProviderEntrySchema.safeParse({
        id: "groq",
        name: "Groq",
        source: null,
        hasStoredCredential: false,
        canDisconnect: false,
        connected: false,
        methods: [],
      }).success,
    ).toBe(true);
    expect(
      modelProviderEntrySchema.safeParse({
        id: "groq",
        name: "Groq",
        source: "keychain",
        hasStoredCredential: false,
        canDisconnect: false,
        connected: false,
        methods: [],
      }).success,
    ).toBe(false);
  });

  it("answers with a success arm or a typed error, never a bare throw", () => {
    expect(
      modelProvidersListResultSchema.safeParse({ ok: true, providers: [] })
        .success,
    ).toBe(true);
    expect(
      modelProvidersListResultSchema.safeParse({
        ok: false,
        code: "capability_unavailable",
        detail: "opencode CLI below the minimum version",
      }).success,
    ).toBe(true);
    expect(
      modelProvidersListResultSchema.safeParse({
        ok: false,
        code: "server_unavailable",
        detail: "managed server did not start",
      }).success,
    ).toBe(true);
  });

  it("rejects the shared native-config codes on this surface", () => {
    // The two vocabularies are deliberately disjoint. `external_drift` and
    // friends describe editing provider CONFIG FILES; nothing here edits one.
    for (const code of [
      "duplicate_name",
      "external_drift",
      "rollback_failed",
      "no_change_detected",
      "unsupported_scope",
    ]) {
      expect(
        modelProvidersListResultSchema.safeParse({
          ok: false,
          code,
          detail: null,
        }).success,
        code,
      ).toBe(false);
    }
  });

  it("gates the request on a known Traycer provider id", () => {
    expect(
      providersListModelProvidersRequestSchema.safeParse({
        providerId: "opencode",
      }).success,
    ).toBe(true);
    expect(
      providersListModelProvidersRequestSchema.safeParse({
        providerId: "anthropic",
      }).success,
    ).toBe(false);
    expect(
      providersListModelProvidersResponseSchema.parse({
        result: { ok: true, providers: [] },
      }).result,
    ).toEqual({ ok: true, providers: [] });
  });
});

describe("providers.modelProviderAuth actions", () => {
  it("accepts a plain-key connect with no advertised method, for ANY provider", () => {
    // `methodIndex: null` means "the client chose no advertised method". The
    // host serves it with the generic API-key method upstream synthesizes when
    // `/provider/auth` offers none - so this path is legal for every provider,
    // not only the ones whose env member the host could resolve.
    const parsed = modelProviderAuthActionSchema.parse({
      action: "connect",
      modelProviderId: "anthropic",
      methodIndex: null,
      key: "sk-secret",
      inputs: {},
    });
    expect(parsed.action).toBe("connect");
    if (parsed.action !== "connect") return;
    expect(parsed.methodIndex).toBeNull();
    expect(parsed.key).toBe("sk-secret");
    expect(parsed.inputs).toEqual({});
  });

  it("carries the credential VALUE and nothing that names it", () => {
    // The shape this surface settled on after auditing upstream: `key` is the
    // pasted secret (upstream's `ApiAuth.key`), `inputs` are prompt answers
    // (its `metadata`). An earlier draft carried the models.dev `env[]` member
    // the value would be stored under, because the host validated the key
    // against that array - a name it then discarded. Upstream never asks for
    // it, so it is not on the wire.
    const parsed = modelProviderAuthActionSchema.parse({
      action: "connect",
      modelProviderId: "azure",
      methodIndex: 0,
      key: "sk-secret",
      inputs: { resourceName: "my-resource" },
      // Present in the INPUT on purpose: asserting the parse drops a key the
      // payload never carried proves nothing. A client still sending the old
      // field must have it stripped, not passed through.
      credentialKey: "AZURE_API_KEY",
    });
    expect(parsed.action).toBe("connect");
    if (parsed.action !== "connect") return;
    expect(Object.keys(parsed)).not.toContain("credentialKey");
    expect(parsed.inputs).toEqual({ resourceName: "my-resource" });
  });

  it("rejects a connect with no credential value", () => {
    // `key` is the whole point of the action; an empty one would be stored as
    // an unusable credential and report success.
    for (const key of [undefined, ""]) {
      expect(
        modelProviderAuthActionSchema.safeParse({
          action: "connect",
          modelProviderId: "anthropic",
          methodIndex: null,
          key,
          inputs: {},
        }).success,
        String(key),
      ).toBe(false);
    }
  });

  it("keys prompt answers by prompt key, so one cannot be answered twice", () => {
    // A map, not a list of `{key, value}` pairs: a duplicate key is not a
    // state anything downstream can act on, and this makes it unrepresentable
    // rather than merely wrong.
    const parsed = modelProviderAuthActionSchema.parse({
      action: "startOauth",
      modelProviderId: "anthropic",
      methodIndex: 0,
      inputs: { mode: "advanced", region: "us-east-1" },
    });
    expect(parsed.action).toBe("startOauth");
    if (parsed.action !== "startOauth") return;
    expect(parsed.inputs).toEqual({ mode: "advanced", region: "us-east-1" });
  });

  it("requires a method index to start OAuth", () => {
    expect(
      modelProviderAuthActionSchema.safeParse({
        action: "startOauth",
        modelProviderId: "anthropic",
        methodIndex: null,
        inputs: {},
      }).success,
    ).toBe(false);
    expect(
      modelProviderAuthActionSchema.safeParse({
        action: "startOauth",
        modelProviderId: "anthropic",
        methodIndex: 0,
        inputs: {},
      }).success,
    ).toBe(true);
  });

  it("addresses submitCode by attempt id, not by provider alone", () => {
    // Attempts are single-flight per (providerId, modelProviderId) and a new
    // one supersedes the pending one, so a code for a superseded attempt has
    // to be discardable rather than applied to whatever is pending now.
    expect(
      modelProviderAuthActionSchema.safeParse({
        action: "submitCode",
        modelProviderId: "anthropic",
        code: "abc123",
      }).success,
    ).toBe(false);
    expect(
      modelProviderAuthActionSchema.safeParse({
        action: "submitCode",
        modelProviderId: "anthropic",
        attemptId: "attempt-1",
        code: "abc123",
      }).success,
    ).toBe(true);
  });

  it("takes a disconnect with nothing but the upstream provider id", () => {
    expect(
      providersModelProviderAuthRequestSchema.safeParse({
        providerId: "opencode",
        action: { action: "disconnect", modelProviderId: "anthropic" },
      }).success,
    ).toBe(true);
  });

  it("rejects an empty upstream provider id", () => {
    expect(
      modelProviderAuthActionSchema.safeParse({
        action: "disconnect",
        modelProviderId: "",
      }).success,
    ).toBe(false);
  });
});

describe("model provider auth results", () => {
  it("carries the attempt id, url, method and instructions on an OAuth start", () => {
    const result = modelProviderAuthResultSchema.parse({
      kind: "authorizationUrl",
      attemptId: "attempt-1",
      authorizationUrl: "https://example.test/oauth",
      method: "code",
      instructions: "Paste the code shown after approving.",
    });
    expect(result.kind).toBe("authorizationUrl");
    if (result.kind !== "authorizationUrl") return;
    expect(result.attemptId).toBe("attempt-1");
    expect(result.method).toBe("code");
  });

  it("requires an attempt id on that arm - a flow nobody can address is unusable", () => {
    expect(
      modelProviderAuthResultSchema.safeParse({
        kind: "authorizationUrl",
        authorizationUrl: "https://example.test/oauth",
        method: "auto",
        instructions: null,
      }).success,
    ).toBe(false);
  });

  it("models pending / done / unsupported / error and nothing else", () => {
    for (const result of [
      { kind: "pending" },
      { kind: "done" },
      { kind: "unsupported", reason: "opencode CLI is too old" },
      { kind: "error", code: "provider_auth_failed", detail: null },
    ]) {
      expect(modelProviderAuthResultSchema.safeParse(result).success).toBe(
        true,
      );
    }
    expect(
      modelProviderAuthResultSchema.safeParse({ kind: "cancelled" }).success,
    ).toBe(false);
    // `pendingInstruction` has no counterpart here: upstream carries its
    // instruction text on the authorization response, so an instruction-only
    // arm is one nothing could ever emit.
    expect(
      modelProviderAuthResultSchema.safeParse({
        kind: "pendingInstruction",
        instruction: "do the thing",
      }).success,
    ).toBe(false);
  });

  it("wraps every method's payload in the same non-nullable result envelope", () => {
    expect(
      providersModelProviderAuthResponseSchema.safeParse({ result: null })
        .success,
    ).toBe(false);
    expect(
      providersAwaitModelProviderAuthResponseSchema.parse({
        result: { kind: "pending" },
      }).result.kind,
    ).toBe("pending");
  });
});

describe("await / cancel attempt addressing", () => {
  it("polls and cancels by (modelProviderId, attemptId)", () => {
    expect(
      providersAwaitModelProviderAuthRequestSchema.safeParse({
        providerId: "opencode",
        context: { modelProviderId: "anthropic", attemptId: "attempt-1" },
      }).success,
    ).toBe(true);
    expect(
      providersCancelModelProviderAuthRequestSchema.safeParse({
        providerId: "opencode",
        context: { modelProviderId: "anthropic", attemptId: "" },
      }).success,
    ).toBe(false);
  });

  it("separates 'was something torn down' from 'what is the state now'", () => {
    // Cancelling an attempt that already completed, expired or was superseded
    // is `cancelled: false` with a perfectly normal result - and cancel is
    // best-effort LOCAL either way: upstream has no OAuth-cancel endpoint.
    const response = providersCancelModelProviderAuthResponseSchema.parse({
      cancelled: false,
      result: { kind: "done" },
    });
    expect(response.cancelled).toBe(false);
    expect(response.result.kind).toBe("done");
  });
});

describe("attempt lifecycle is encodable end to end", () => {
  // The plan settles these outcomes; the wire has to be able to SAY them. The
  // shared native-config enum could not - it has no member for a superseded or
  // expired attempt - so a host would have had to overload `external_drift` or
  // invent silence. Each case below is one settled outcome and the client
  // action it implies.
  const OUTCOMES = [
    {
      name: "a stale attempt id is discarded, not answered with the live attempt's status",
      code: "attempt_not_found" as const,
    },
    {
      name: "a superseded attempt is told so, so its UI stands down instead of restarting",
      code: "attempt_superseded" as const,
    },
    {
      name: "an attempt reaped by the pending-auth registry reports expiry",
      code: "attempt_expired" as const,
    },
    {
      name: "a rejected code leaves the attempt live and asks for another",
      code: "code_rejected" as const,
    },
    {
      name: "prompt answers the provider refuses come back as invalid input",
      code: "invalid_input" as const,
    },
    {
      name: "an upstream credential/callback refusal is its own code",
      code: "provider_auth_failed" as const,
    },
    {
      name: "a managed server that will not start is not blamed on the credential",
      code: "server_unavailable" as const,
    },
    {
      name: "an unknown upstream provider id is answerable without guessing",
      code: "provider_not_found" as const,
    },
  ];

  it.each(OUTCOMES)("poll: $name", ({ code }) => {
    const parsed = providersAwaitModelProviderAuthResponseSchema.parse({
      result: { kind: "error", code, detail: null },
    });
    expect(parsed.result.kind).toBe("error");
    if (parsed.result.kind !== "error") return;
    expect(parsed.result.code).toBe(code);
  });

  it.each(OUTCOMES)("auth action: $name", ({ code }) => {
    expect(
      providersModelProviderAuthResponseSchema.safeParse({
        result: { kind: "error", code, detail: "detail text" },
      }).success,
    ).toBe(true);
  });

  it.each(OUTCOMES)("cancel: $name, with cancelled:false", ({ code }) => {
    // Cancel is best-effort and local. "Nothing was torn down" and "here is
    // why" are separate facts, and both have to be sayable together.
    const parsed = providersCancelModelProviderAuthResponseSchema.parse({
      cancelled: false,
      result: { kind: "error", code, detail: null },
    });
    expect(parsed.cancelled).toBe(false);
    expect(parsed.result.kind).toBe("error");
  });

  it("reports a successful cancel as cancelled:true with a non-error result", () => {
    const parsed = providersCancelModelProviderAuthResponseSchema.parse({
      cancelled: true,
      result: { kind: "done" },
    });
    expect(parsed.cancelled).toBe(true);
    expect(parsed.result.kind).toBe("done");
  });

  it("refuses attempt errors on the LIST result - they are impossible there", () => {
    // Listing the catalog has no attempt to supersede, no code to reject and
    // no prompt answers to validate. A wide enum shared by both contexts would
    // type-check every one of these and leave the impossibility to a comment.
    for (const code of [
      "attempt_not_found",
      "attempt_superseded",
      "attempt_expired",
      "code_rejected",
      "invalid_input",
      "provider_auth_failed",
      "provider_not_found",
    ]) {
      expect(
        modelProvidersListResultSchema.safeParse({
          ok: false,
          code,
          detail: null,
        }).success,
        code,
      ).toBe(false);
    }
  });

  it("refuses capability_unavailable on the AUTH error arm - that is the unsupported arm", () => {
    // The auth result already answers "not offered here" structurally. A code
    // saying the same thing is a second spelling, and consumers end up
    // handling one of the two.
    expect(
      providersModelProviderAuthResponseSchema.safeParse({
        result: {
          kind: "error",
          code: "capability_unavailable",
          detail: null,
        },
      }).success,
    ).toBe(false);
    expect(
      providersAwaitModelProviderAuthResponseSchema.safeParse({
        result: {
          kind: "error",
          code: "capability_unavailable",
          detail: null,
        },
      }).success,
    ).toBe(false);
    expect(
      providersCancelModelProviderAuthResponseSchema.safeParse({
        cancelled: false,
        result: {
          kind: "error",
          code: "capability_unavailable",
          detail: null,
        },
      }).success,
    ).toBe(false);
    // The condition is still sayable - through the arm that owns it.
    expect(
      providersModelProviderAuthResponseSchema.safeParse({
        result: { kind: "unsupported", reason: "opencode CLI is too old" },
      }).success,
    ).toBe(true);
  });

  it("refuses the shared native-config codes on the auth arm too", () => {
    for (const code of ["external_drift", "rollback_failed", "duplicate_name"]) {
      expect(
        providersModelProviderAuthResponseSchema.safeParse({
          result: { kind: "error", code, detail: null },
        }).success,
        code,
      ).toBe(false);
    }
  });

  it("keeps every list code sayable on the list result", () => {
    for (const code of modelProviderListErrorCodeSchema.options) {
      expect(
        modelProvidersListResultSchema.safeParse({
          ok: false,
          code,
          detail: null,
        }).success,
        code,
      ).toBe(true);
    }
  });

  it("keeps the auth error vocabulary disjoint from the shared native one", () => {
    // Not a style preference: `providerNativeErrorCodeSchema` rides RELEASED
    // carriers, so it cannot be widened, and its members describe config-file
    // edits. A model-provider code leaking into it (or vice versa) would mean
    // one of the two enums grew where it must not.
    const ours = [
      ...modelProviderListErrorCodeSchema.options,
      ...modelProviderAuthErrorCodeSchema.options,
    ];
    for (const code of ours) {
      expect(
        providerNativeErrorCodeSchema.safeParse(code).success,
        `${code} must not exist on the shared native enum`,
      ).toBe(false);
    }
    for (const code of providerNativeErrorCodeSchema.options) {
      expect(
        modelProviderListErrorCodeSchema.safeParse(code).success,
        `${code} must not exist on the list enum`,
      ).toBe(false);
      expect(
        modelProviderAuthErrorCodeSchema.safeParse(code).success,
        `${code} must not exist on the auth enum`,
      ).toBe(false);
    }
  });
});

/**
 * Every zod schema reachable from `root`, by identity.
 *
 * Walks `def` generically rather than switching on schema kind: the point is
 * to be exhaustive, and a per-kind walker silently stops at the first kind
 * nobody remembered to handle - which is the same class of miss this test
 * exists to catch.
 */
function collectReachableSchemas(root: z.ZodType): Set<z.ZodType> {
  const schemas = new Set<z.ZodType>();
  const containers = new WeakSet<object>();
  const pending: z.ZodType[] = [root];

  function walk(value: unknown): void {
    if (value instanceof z.ZodType) {
      pending.push(value);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    if (containers.has(value)) return;
    containers.add(value);
    for (const child of Object.values(value)) walk(child);
  }

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || schemas.has(current)) continue;
    schemas.add(current);
    walk(current.def);
  }
  return schemas;
}

/**
 * Every export name each schema object answers to, used only to make a failure
 * readable - not the guard itself. A LIST per object, not one name: several
 * schemas are exported twice under an alias (`PROVIDER_AUTH_SCHEMA` is the
 * same object as `PROVIDER_AUTH_SCHEMA_V20`), and keeping only the last one
 * seen would make a frozen node look live purely by declaration order.
 */
const SCHEMA_EXPORT_NAMES = new Map<z.ZodType, string[]>();
for (const [name, value] of [
  ...Object.entries(nativeSchemaModule),
  ...Object.entries(providerSchemaModule),
  ...Object.entries(providerIdModule),
]) {
  if (!(value instanceof z.ZodType)) continue;
  const names = SCHEMA_EXPORT_NAMES.get(value);
  if (names === undefined) {
    SCHEMA_EXPORT_NAMES.set(value, [name]);
    continue;
  }
  names.push(name);
}

/** A name is a freeze marker when it ends in a version suffix (`V70`, `V20`, …). */
const FROZEN_NAME = /V\d0$/;

function describeSchema(schema: z.ZodType): string {
  const names = SCHEMA_EXPORT_NAMES.get(schema);
  if (names !== undefined) return names.join(" / ");
  const def: unknown = schema.def;
  const kind =
    typeof def === "object" && def !== null && "type" in def
      ? String(def.type)
      : "schema";
  try {
    const shape = JSON.stringify(
      z.toJSONSchema(schema, { unrepresentable: "any" }),
    );
    return `<unexported ${kind}: ${shape.slice(0, 160)}>`;
  } catch {
    return `<unexported ${kind}>`;
  }
}

function unionOfClosures(roots: readonly z.ZodType[]): Set<z.ZodType> {
  const all = new Set<z.ZodType>();
  for (const root of roots) {
    for (const schema of collectReachableSchemas(root)) all.add(schema);
  }
  return all;
}

/**
 * Every schema object the LIVE `providers.list` contracts reach - the closure,
 * not the export list.
 *
 * The export list was this guard's first form and it had a hole: "live" meant
 * "exported", so a PRIVATE live node (`nativeListSuccessResultSchema` is one)
 * could be wired into a V70 schema and pass. Worse, the JSON-schema equality
 * tests below would pass too, because both sides would be comparing one shared
 * object with itself - leaving only the regeneratable catalog snapshot to
 * notice a later widening.
 *
 * A closure has no such hole: reachability does not care whether a node has a
 * name.
 */
const LIVE_SCHEMA_CLOSURE = unionOfClosures([
  providerCliStateSchema,
  providersListRequestSchema,
  providersListResponseSchema,
  providerNativeCapabilitiesSchema,
]);

/**
 * The one deliberate sharing between the live and v7.0 trees:
 * `PROVIDER_AUTH_SCHEMA_V20` is already frozen under its own version name, so
 * both lines legitimately point at it. Subtracted as a CLOSURE, not a single
 * node - its children (`PROVIDER_AUTH_STATUS_SCHEMA_V20`) are shared for
 * exactly the same reason.
 *
 * This is the entire allowlist. Anything else in the intersection is a leak,
 * and the fix is a V70 copy - never another entry here.
 */
const PERMITTED_SHARED_CLOSURE = collectReachableSchemas(
  PROVIDER_AUTH_SCHEMA_V20,
);

describe("the v7.0 freeze goes all the way down", () => {
  // A `...V70` schema that still points into the live tree is a freeze-shaped
  // alias, not a freeze: the outer object is pinned while everything inside it
  // stays free to grow, and growth in a closed enum or union is the half that
  // is FATAL to a peer that decodes v7.0 rather than merely leaked.
  //
  // Two rounds of review found a missed subtree each time, one level deeper
  // than the last fix. So the primary guard below is not a list of the
  // subtrees anyone remembered - it is an exhaustive walk of the schema graph,
  // which makes the NEXT missed subtree fail here instead of in a review.

  const V70_ROOTS: readonly { name: string; schema: z.ZodType }[] = [
    { name: "providerCliStateSchemaV70", schema: providerCliStateSchemaV70 },
    {
      name: "providersListRequestSchemaV70",
      schema: providersListRequestSchemaV70,
    },
    {
      name: "providersListResponseSchemaV70",
      schema: providersListResponseSchemaV70,
    },
    {
      name: "providerNativeCapabilitiesSchemaV70",
      schema: providerNativeCapabilitiesSchemaV70,
    },
  ];

  it.each(V70_ROOTS)(
    "$name shares no node with the live contracts at any depth",
    ({ schema }) => {
      // The whole contract in one assertion: closure ∩ closure, minus the one
      // deliberately shared frozen subtree. If this fails, the nodes it
      // reports are live schemas sitting on the v7.0 wire - give each a V70
      // hand-copy and rewire. Do NOT add them to the allowlist; the reason
      // they are reachable IS the defect.
      const leaks = [...collectReachableSchemas(schema)]
        .filter(
          (node) =>
            LIVE_SCHEMA_CLOSURE.has(node) &&
            !PERMITTED_SHARED_CLOSURE.has(node),
        )
        .map(describeSchema);
      expect(leaks).toEqual([]);
    },
  );

  it("actually has live nodes to catch, and a graph deep enough to find them", () => {
    // Guards the guard. A walker that silently stopped at depth 1, or a live
    // closure that came back empty, would make every assertion above vacuously
    // green.
    expect(LIVE_SCHEMA_CLOSURE.size).toBeGreaterThan(100);
    expect(
      collectReachableSchemas(providerCliStateSchemaV70).size,
    ).toBeGreaterThan(100);
    expect(
      collectReachableSchemas(providerCliStateSchemaV70).has(
        providerNativeCapabilitiesSchemaV70,
      ),
    ).toBe(true);
  });

  it("covers UNEXPORTED live nodes, which is the hole the export list had", () => {
    // The concrete reason this guard is a closure rather than a name list. If
    // every live node happened to be exported the two would be equivalent and
    // the rewrite pointless - so assert they are not: the live contracts do
    // reach nodes no name can address, and those are now in scope.
    const unexported = [...LIVE_SCHEMA_CLOSURE].filter(
      (node) => !SCHEMA_EXPORT_NAMES.has(node),
    );
    expect(unexported.length).toBeGreaterThan(0);
  });

  it("permits exactly one shared subtree, and every node in it is frozen", () => {
    // Pins the allowlist so a future "just add it to the permitted set" fix
    // cannot pass quietly: every NAMED node in it must carry a version suffix.
    expect(PERMITTED_SHARED_CLOSURE.has(PROVIDER_AUTH_SCHEMA_V20)).toBe(true);
    const liveNamed = [...PERMITTED_SHARED_CLOSURE]
      .map((node) => SCHEMA_EXPORT_NAMES.get(node))
      .filter((names): names is string[] => names !== undefined)
      // An object exported under several names is frozen if ANY of them says
      // so - the alias is a second door onto the same frozen schema.
      .filter((names) => !names.some((name) => FROZEN_NAME.test(name)))
      .map((names) => names.join(" / "));
    expect(liveNamed).toEqual([]);
  });

  // Live-vs-frozen equality per subtree. Green today because the copies agree;
  // red the day a live subtree grows, which routes the "what does a v7.0
  // client see?" decision to whoever grew it. Do NOT satisfy a failure by
  // editing the V70 copy - extend the v8→v7 projection to say explicitly what
  // gets projected away.
  const PAIRS = [
    ["mcp capabilities", providerMcpCapabilitiesSchema, providerMcpCapabilitiesSchemaV70],
    [
      "plugins capabilities",
      providerPluginsCapabilitiesSchema,
      providerPluginsCapabilitiesSchemaV70,
    ],
    [
      "skills capabilities",
      providerSkillsCapabilitiesSchema,
      providerSkillsCapabilitiesSchemaV70,
    ],
    ["native list query", nativeListQuerySchema, nativeListQuerySchemaV70],
    ["native list result", nativeListResultSchema, nativeListResultSchemaV70],
    // The row schemas the list result is BUILT from. Covered by the result
    // pair transitively, and named individually anyway: a failure on the
    // aggregate points at a 300-line union diff, while a failure here points
    // at the row that moved.
    ["mcp tool row", providerMcpToolSchema, providerMcpToolSchemaV70],
    ["mcp server row", providerMcpServerSchema, providerMcpServerSchemaV70],
    ["plugin row", providerPluginSchema, providerPluginSchemaV70],
    ["skill row", providerSkillSchema, providerSkillSchemaV70],
    [
      "env override scope",
      providerEnvOverrideScopeSchema,
      providerEnvOverrideScopeSchemaV70,
    ],
  ] as const;

  it.each(PAIRS)(
    "%s: the frozen v7.0 copy still matches the live schema",
    (_label, live, frozen) => {
      expect(z.toJSONSchema(frozen, { unrepresentable: "any" })).toEqual(
        z.toJSONSchema(live, { unrepresentable: "any" }),
      );
    },
  );

  it("carries config_unreadable on the v7.0 native result - v7.0 is unreleased", () => {
    // The decision this test exists to RECORD, because the equality guard
    // above fired to force it (in CI, on the merge preview - the tripwire
    // proving itself in the wild).
    //
    // `config_unreadable` was added to the LIVE native error enum on main
    // (#1050) after this branch cut. The reflex answer - frozen copy predates
    // it, so project it away on the v8→v7 bridge - is wrong here: NO released
    // tag ships `providers.list@7.0`. `host-v1.1.11` and every earlier
    // host/cli/desktop tag top out below it, so v7.0 is unreleased and #1050
    // grew it legitimately, exactly as the registry fields grew v6.0 before
    // `cli-v1.1.9` shipped it.
    //
    // Versions protect peers in the FIELD. There is no peer that negotiated
    // v7.0 and cannot read this code - the release that first ships v7.0 ships
    // it too. So the bridge needs no projection, and the frozen snapshot is
    // "v7.0 as of the moment v8.0 opened", which includes #1050.
    //
    // This stops being true the day a release ships v7.0. After that, a code
    // added to the live enum needs a real projection decision, and the
    // equality guard will ask for one again.
    expect(
      nativeListResultSchemaV70.safeParse({
        ok: false,
        code: "config_unreadable",
        detail: "redacted parse error",
      }).success,
    ).toBe(true);
    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["providers.list"],
      8,
      7,
      {
        providers: [],
        native: {
          ok: false,
          code: "config_unreadable",
          detail: "redacted parse error",
        },
      },
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(downgraded.value.native).toEqual({
      ok: false,
      code: "config_unreadable",
      detail: "redacted parse error",
    });
  });

  it("the tab projection agrees with the frozen enum, member for member", () => {
    // `projectTabToV70` is an exhaustive SWITCH, so a new live tab fails to
    // compile until someone decides its side of the cut. What a switch cannot
    // check is whether that decision matches the frozen enum - so this does:
    // every live tab the projection keeps must be one v7.0 can decode, and
    // every tab it drops must be one v7.0 cannot.
    for (const tab of providerSettingsTabSchema.options) {
      const kept = projectProviderNativeCapabilitiesToV70({
        ...DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
        supportedTabs: [tab],
      }).supportedTabs;
      expect(kept, tab).toEqual(
        providerSettingsTabSchemaV70.safeParse(tab).success ? [tab] : [],
      );
    }
  });

  it("keeps the frozen provider-id enum out of the live one's future", () => {
    // The v7.0 native query and the v7.0 state both carry a provider id. A
    // provider added to the live enum reaches a v7.0 caller only through the
    // bridge, never by the frozen schema quietly widening underneath it.
    expect(providerIdSchemaV70.options).toEqual(providerIdSchema.options);
  });

  it("wires the v7.0 contracts to the frozen tree by identity", () => {
    // Spot checks that name the seams a reader cares about. The exhaustive
    // walk above is the guarantee; these say out loud which schema each v7.0
    // field is supposed to be.
    expect(unwrapSchema(providersListRequestSchemaV70.shape.native)).toBe(
      nativeListQuerySchemaV70,
    );
    expect(unwrapSchema(providersListResponseSchemaV70.shape.native)).toBe(
      nativeListResultSchemaV70,
    );
    expect(
      unwrapSchema(providerCliStateSchemaV70.shape.nativeCapabilities),
    ).toBe(providerNativeCapabilitiesSchemaV70);
    expect(unwrapSchema(providerNativeCapabilitiesSchemaV70.shape.mcp)).toBe(
      providerMcpCapabilitiesSchemaV70,
    );
    expect(
      unwrapSchema(providerNativeCapabilitiesSchemaV70.shape.envOverrideScope),
    ).toBe(providerEnvOverrideScopeSchemaV70);
  });
});

describe("an unrepresentable row degrades per row, never per response", () => {
  // The two contracts were quietly in conflict: the projection fails closed,
  // and `downgradeProviderCliStateToV70` documents `| null` per row. Calling
  // the strict form inside the row's `safeParse` argument list let the throw
  // escape past that contract - one bad provider failed the whole
  // `providers.list` response for that peer.
  //
  // Runtime resolution: the row contract wins. Build-time loudness stays with
  // the equality guard above, which is the only mechanism that reaches the
  // person who grew the enum.

  /**
   * A capability object v7.0 cannot represent: an unknown `mcp` transport.
   *
   * Built by MUTATING a genuinely-parsed object rather than by casting one
   * into existence. Live and frozen agree today, so the value this test needs
   * is one only a FUTURE live enum can produce - and the point is to prove the
   * bridge degrades on such a value, not to introduce a type escape for it.
   * `transports` is a plain array on the parsed result, so pushing an
   * unrecognized member reproduces exactly what a widened live enum would send.
   */
  function unrepresentableCapabilities(): ProviderNativeCapabilities {
    const capabilities = providerNativeCapabilitiesSchema.parse(
      structuredClone(OPENCODE_CAPABILITIES),
    );
    const mcp = capabilities.mcp;
    if (mcp === null) throw new Error("fixture must carry mcp capabilities");
    const transports: string[] = mcp.transports;
    transports.push("websocket");
    return capabilities;
  }
  const unrepresentable = unrepresentableCapabilities();

  it("the strict projection still throws - the loud form is unchanged", () => {
    expect(() =>
      projectProviderNativeCapabilitiesToV70(unrepresentable),
    ).toThrow();
  });

  it("the degrading projection answers null instead", () => {
    expect(tryProjectProviderNativeCapabilitiesToV70(unrepresentable)).toBeNull();
  });

  it("drops only the offending row and still serves every healthy provider", () => {
    const bad = { ...opencodeState, nativeCapabilities: unrepresentable };
    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["providers.list"],
      8,
      7,
      { providers: [bad, claudeState], native: null },
    );
    // The assertion that matters: `ok`, not a thrown error. Before the split
    // this call threw and the peer got nothing at all.
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(
      downgraded.value.providers.map((provider) => provider.providerId),
    ).toEqual(["claude-code"]);
  });
});

describe("no downgrade hop fails a whole response over one unsupported provider", () => {
  // The class the v8 -> v6 hop belonged to. `z.array` fails WHOLE on one bad
  // element, so a frozen line's id enum rejecting a newer provider does not
  // drop that provider - it throws the entire `providers.list` response for
  // that peer, taking every healthy provider with it.
  //
  // Latent since v8.0 opened and reachable the instant `huggingface` merged.
  // Asserted across EVERY hop rather than the one that was wrong, because the
  // next provider id will arrive the same way this one did.
  const FROZEN_RESPONSES = {
    1: providersListResponseSchemaV10,
    2: providersListResponseSchemaV20,
    3: providersListResponseSchemaV30,
    4: providersListResponseSchemaV40,
    5: providersListResponseSchemaV50,
    6: providersListResponseSchemaV60,
    7: providersListResponseSchemaV70,
  } as const;

  // `huggingface` is post-v6.0, so majors 1-6 must drop it and v7.0 must keep
  // it - the same split main's own v7→v6 bridge comment describes.
  const newestProvider = providerCliStateSchema.parse({
    ...providerState("huggingface"),
    nativeCapabilities: OPENCODE_CAPABILITIES,
  });

  it.each([1, 2, 3, 4, 5, 6, 7] as const)(
    "8.0 -> v%i.0 answers rather than throwing when the list carries a newer provider",
    (targetMajor) => {
      const downgraded = downgradeResponseAcrossMajors(
        hostRpcRegistry["providers.list"],
        8,
        targetMajor,
        { providers: [newestProvider, claudeState], native: null },
      );
      // `ok`, not a thrown error. This is the whole assertion.
      expect(downgraded.ok).toBe(true);
      if (!downgraded.ok) return;
      expect(
        FROZEN_RESPONSES[targetMajor].safeParse(downgraded.value).success,
      ).toBe(true);
      // The healthy provider survives either way; the newer one appears only
      // on the line whose enum names it.
      const ids = downgraded.value.providers.map(
        (provider) => provider.providerId,
      );
      expect(ids).toContain("claude-code");
      expect(ids.includes("huggingface")).toBe(targetMajor >= 7);
    },
  );
});
