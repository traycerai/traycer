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
  nativeListResultSchema,
  providerMcpCapabilitiesSchema,
  providerMcpCapabilitiesSchemaV70,
  providerModelProvidersCapabilitiesSchema,
  projectNativeCapabilitiesToV70,
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
import { providerIdSchema } from "@traycer/protocol/host/provider-ids";
import {
  PROVIDER_AUTH_SCHEMA_V20,
  providerCliStateSchema,
  providerCliStateSchemaV70,
  providerIdSchemaV70,
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
 * Model Providers wire contract.
 *
 * The load-bearing claim this file exists to hold: the `modelProviders` tab id
 * can only reach a decoder that knows it.
 *
 * Two facts make that true, and both are asserted below rather than assumed.
 * v7.0 is the LIVE line and is unreleased, so the member is mirrored onto it -
 * there is no peer in the field that negotiated v7.0 without it. And no
 * `providers.list` line below v7.0 models `nativeCapabilities` in any form, so
 * every older major drops the whole capability object rather than meeting a
 * tab id it cannot parse.
 *
 * The second fact is what makes the first safe, and it is worth stating why:
 * `supportedTabs` is an array of a CLOSED enum nested inside
 * `nativeCapabilities`, which `providerCliStateSchema` decodes through one
 * `.catch(DEFAULT)`. A member an older decoder could not read would not
 * degrade to "tab ignored" - it would take MCP, Plugins and Skills down with
 * it. No such decoder exists today; the day one does, a projection is owed,
 * and the enum-equality test below is what asks for it.
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

/** What an `opencode` host advertises once the tab is live. */
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
  it("is on the live tab enum and NOT on the frozen v7.0 one", () => {
    // The tab rides the head line. v7.0 is frozen; a v7.0 peer receives
    // `supportedTabs` through the projection, never the raw member.
    expect(providerSettingsTabSchema.safeParse("modelProviders").success).toBe(
      true,
    );
    expect(
      providerSettingsTabSchemaV70.safeParse("modelProviders").success,
    ).toBe(false);
  });

  it("requires the capability key rather than tolerating an absent one", () => {
    // Required-and-nullable, like its mcp/plugins/skills siblings. An absent
    // key would fail the whole capability object on a v7.0 client, which the
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
        actions: [
          "connect",
          "oauth",
          "disconnect",
          "createCustom",
          "updateCustom",
        ],
      }).success,
    ).toBe(true);
    expect(
      providerModelProvidersCapabilitiesSchema.safeParse({
        actions: ["reconnect"],
      }).success,
    ).toBe(false);
  });

  it("carries modelProviders: null on the live default and no key on the frozen one", () => {
    // The live default is what the head line serves; the v7.0 default is the
    // frozen line's own snapshot, which predates the member.
    expect(DEFAULT_PROVIDER_NATIVE_CAPABILITIES.modelProviders).toBeNull();
    expect(Object.keys(DEFAULT_PROVIDER_NATIVE_CAPABILITIES_V70)).not.toContain(
      "modelProviders",
    );
  });
});

describe("the tab id can only reach a decoder that knows it", () => {
  it("carries modelProviders on the live head line", () => {
    const opencodeRow = liveResponse.providers.find(
      (provider) => provider.providerId === "opencode",
    );
    expect(opencodeRow?.nativeCapabilities.supportedTabs).toContain(
      "modelProviders",
    );
  });

  it("projects the tab away for a v7.0 peer WITHOUT wiping its capabilities", () => {
    // The trap this projection exists for: the frozen tab enum rejects a
    // whole `supportedTabs` array over one unknown member, and the state's
    // `.catch()` would then serve the empty default - costing the peer MCP,
    // Plugins and Skills over one tab id. Filter, never reparse.
    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["providers.list"],
      8,
      7,
      liveResponse,
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    const row = downgraded.value.providers.find(
      (provider) => provider.providerId === "opencode",
    );
    expect(row?.nativeCapabilities.supportedTabs).toContain("mcp");
    expect(row?.nativeCapabilities.mcp).not.toBeNull();
    expect(JSON.stringify(downgraded.value)).not.toContain("modelProviders");
  });

  it("drops the whole capability object for a v6.0 client, tab and all", () => {
    // v6.0 models no capability object, so the reparse takes the entire
    // field, and the string cannot reach the wire at any older major.
    for (const targetMajor of [1, 2, 3, 4, 5, 6] as const) {
      const downgraded = downgradeResponseAcrossMajors(
        hostRpcRegistry["providers.list"],
        8,
        targetMajor,
        liveResponse,
      );
      expect(downgraded.ok, `v${targetMajor}.0`).toBe(true);
      if (!downgraded.ok) continue;
      expect(downgraded.value.providers[0]).not.toHaveProperty(
        "nativeCapabilities",
      );
      expect(
        JSON.stringify(downgraded.value),
        `v${targetMajor}.0`,
      ).not.toContain("modelProviders");
    }
  });
});

describe("providers.list head line -> every older major", () => {
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
          targetMajor as 1 | 2 | 3 | 4 | 5 | 6 | 7
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

describe("providers.list every older major -> the head line", () => {
  it("fills the v7.0-shaped default on the v6 -> v7 hop, with no modelProviders key", () => {
    // v6.0 models no capability object at all, so this hop invents the whole
    // thing from the v7.0-shaped default - which predates `modelProviders`.
    // `upgradeResponseToVersion` chains bridges by cast with no re-parse, so
    // the fill has to be real, not a schema default that never runs.
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.list"],
      { major: 6, minor: 0 },
      { major: 7, minor: 0 },
      providersListResponseSchemaV60.parse({
        providers: [providerState("opencode")],
      }),
    );
    const capabilities = upgraded.providers[0].nativeCapabilities;
    expect(Object.keys(capabilities)).not.toContain("modelProviders");
    expect(capabilities).toEqual(DEFAULT_PROVIDER_NATIVE_CAPABILITIES_V70);
    expect(providersListResponseSchemaV70.safeParse(upgraded).success).toBe(
      true,
    );
  });

  it("fills modelProviders: null as an OWN key on the v7 -> v8 hop", () => {
    // A missing key and an explicit null are what a consumer gate has to tell
    // apart. A v7.0 host predates the feature, so the hop reports exactly
    // that - null, present.
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.list"],
      { major: 7, minor: 0 },
      { major: 8, minor: 0 },
      providersListResponseSchemaV70.parse({
        providers: [providerState("opencode")],
        native: null,
      }),
    );
    const capabilities = upgraded.providers[0].nativeCapabilities;
    expect(Object.keys(capabilities)).toContain("modelProviders");
    expect(capabilities.modelProviders).toBeNull();
    expect(providersListResponseSchema.safeParse(upgraded).success).toBe(true);
  });

  it.each([1, 2, 3, 4, 5, 6] as const)(
    "upgrades a v%i.0 response to the head line with modelProviders null",
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
      configDeclaredCustom: false,
      custom: null,
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
      configDeclaredCustom: false,
      custom: null,
      methods: [],
    });
    expect(entry.canDisconnect).toBe(false);
    expect(entry.connected).toBe(true);
  });

  it("splits Config from Custom with configDeclaredCustom, which source cannot", () => {
    // Both rows are `source: "config"`. Upstream shows one as "Config" and the
    // other as "Custom", and the difference is not recoverable from `source`
    // alone - which is the whole reason this flag is on the wire.
    const plainConfig = modelProviderEntrySchema.parse({
      id: "openai",
      name: "OpenAI",
      source: "config",
      hasStoredCredential: false,
      canDisconnect: true,
      connected: true,
      configDeclaredCustom: false,
      custom: null,
      methods: [],
    });
    const declaredCustom = modelProviderEntrySchema.parse({
      id: "my-endpoint",
      name: "My Endpoint",
      source: "config",
      hasStoredCredential: false,
      canDisconnect: true,
      connected: true,
      configDeclaredCustom: true,
      custom: {
        baseUrl: "https://api.example.com/v1",
        models: [{ id: "gpt-4o", name: "GPT-4o" }],
        headers: [],
        env: [],
      },
      methods: [],
    });
    expect(plainConfig.source).toBe(declaredCustom.source);
    expect(plainConfig.configDeclaredCustom).toBe(false);
    expect(declaredCustom.configDeclaredCustom).toBe(true);
  });

  it("keeps a disconnected custom provider visible as a custom row", () => {
    // The round trip's resting state: created, then disconnected. The block is
    // still declared, so the row is still editable and still badges as Custom
    // - `connected: false` with `configDeclaredCustom: true` says exactly that
    // without a separate "disabled" field.
    const entry = modelProviderEntrySchema.parse({
      id: "my-endpoint",
      name: "My Endpoint",
      source: null,
      hasStoredCredential: false,
      canDisconnect: false,
      connected: false,
      configDeclaredCustom: true,
      custom: {
        baseUrl: "https://api.example.com/v1",
        models: [{ id: "gpt-4o", name: "GPT-4o" }],
        headers: [],
        env: [],
      },
      methods: [],
    });
    expect(entry.connected).toBe(false);
    expect(entry.configDeclaredCustom).toBe(true);
  });

  it("ties custom values to the flag in BOTH directions", () => {
    // One fact in two fields, so the wire refuses to let them disagree. Each
    // direction fails differently: a row claiming custom with no values gives
    // Edit nothing to prefill - the blank-overwrite this field exists to
    // prevent - while values without the flag offer an Edit the host will
    // refuse, or accept and quietly convert a provider nobody declared.
    const base = {
      id: "my-endpoint",
      name: "My Endpoint",
      source: null,
      hasStoredCredential: false,
      canDisconnect: false,
      connected: false,
      methods: [],
    };
    const declared = {
      baseUrl: "https://api.example.com/v1",
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
      headers: [],
      env: [],
    };
    expect(
      modelProviderEntrySchema.safeParse({
        ...base,
        configDeclaredCustom: true,
        custom: null,
      }).success,
    ).toBe(false);
    expect(
      modelProviderEntrySchema.safeParse({
        ...base,
        configDeclaredCustom: false,
        custom: declared,
      }).success,
    ).toBe(false);
    for (const entry of [
      { ...base, configDeclaredCustom: true, custom: declared },
      { ...base, configDeclaredCustom: false, custom: null },
    ]) {
      expect(modelProviderEntrySchema.safeParse(entry).success).toBe(true);
    }
  });

  it("reports a hand-broken declaration instead of vanishing the row", () => {
    // Read side is looser than the write side on purpose. `opencode.json` is
    // hand-editable, so a declared base URL can be malformed - and refusing to
    // report it would fail the row's parse and remove the one provider whose
    // declaration needs fixing, taking Edit (the only surface that could fix
    // it) with it. `createCustom`/`updateCustom` still reject the same value.
    const entry = modelProviderEntrySchema.parse({
      id: "my-endpoint",
      name: "My Endpoint",
      source: null,
      hasStoredCredential: false,
      canDisconnect: false,
      connected: false,
      configDeclaredCustom: true,
      custom: { baseUrl: "api.example.com", models: [], headers: [], env: [] },
      methods: [],
    });
    expect(entry.custom?.baseUrl).toBe("api.example.com");
    expect(
      modelProviderAuthActionSchema.safeParse({
        action: "updateCustom",
        modelProviderId: "my-endpoint",
        name: "My Endpoint",
        baseUrl: "api.example.com",
        models: [{ id: "gpt-4o", name: "GPT-4o" }],
      }).success,
    ).toBe(false);
  });

  it("never echoes the credential back on a row", () => {
    // `custom` mirrors the write shape field for field EXCEPT `key`. The
    // credential is write-only here, so Edit reopens with an empty key field
    // and leaving it empty must not clear a stored one - a rule the host keeps
    // because the wire simply cannot carry the secret back.
    const entry = modelProviderEntrySchema.parse({
      id: "my-endpoint",
      name: "My Endpoint",
      source: "api",
      hasStoredCredential: true,
      canDisconnect: true,
      connected: true,
      configDeclaredCustom: true,
      custom: {
        baseUrl: "https://api.example.com/v1",
        models: [{ id: "gpt-4o", name: "GPT-4o" }],
        headers: [],
        env: [],
        key: "sk-secret",
      },
      methods: [],
    });
    expect(entry.custom).not.toBeNull();
    expect(Object.keys(entry.custom ?? {})).not.toContain("key");
  });

  it("round-trips a declaration from the row into updateCustom", () => {
    // What Edit and bare re-enable both do, and the reason no `enable` verb
    // was needed: resubmit the row's own values.
    const entry = modelProviderEntrySchema.parse({
      id: "my-endpoint",
      name: "My Endpoint",
      source: null,
      hasStoredCredential: false,
      canDisconnect: false,
      connected: false,
      configDeclaredCustom: true,
      custom: {
        baseUrl: "https://api.example.com/v1",
        models: [
          { id: "gpt-4o", name: "GPT-4o" },
          { id: "gpt-4o-mini", name: "GPT-4o mini" },
        ],
        headers: [{ key: "X-Org", value: "acme" }],
        env: ["MY_ENDPOINT_KEY"],
      },
      methods: [],
    });
    expect(entry.custom).not.toBeNull();
    if (entry.custom === null) return;
    const parsed = modelProviderAuthActionSchema.parse({
      action: "updateCustom",
      modelProviderId: entry.id,
      name: entry.name,
      baseUrl: entry.custom.baseUrl,
      models: entry.custom.models,
      headers: entry.custom.headers,
      env: entry.custom.env,
    });
    expect(parsed.action).toBe("updateCustom");
    if (parsed.action !== "updateCustom") return;
    expect(parsed.models.map((model) => model.id)).toEqual([
      "gpt-4o",
      "gpt-4o-mini",
    ]);
    expect(parsed.headers).toEqual([{ key: "X-Org", value: "acme" }]);
    expect(parsed.env).toEqual(["MY_ENDPOINT_KEY"]);
  });

  it("requires configDeclaredCustom rather than defaulting it", () => {
    const { configDeclaredCustom: _omitted, ...withoutFlag } = {
      id: "my-endpoint",
      name: "My Endpoint",
      source: null,
      hasStoredCredential: false,
      canDisconnect: false,
      connected: false,
      configDeclaredCustom: true,
      custom: {
        baseUrl: "https://api.example.com/v1",
        models: [{ id: "gpt-4o", name: "GPT-4o" }],
        headers: [],
        env: [],
      },
      methods: [],
    };
    expect(modelProviderEntrySchema.safeParse(withoutFlag).success).toBe(false);
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
      configDeclaredCustom: false,
      custom: null,
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
      configDeclaredCustom: false,
      custom: null,
      methods: [],
    });
    expect(entry.canDisconnect).toBe(true);
  });

  it("accepts a null source both disconnected AND connected, and rejects an unmodeled one", () => {
    // `null` is not "unauthenticated". It carries two cases a reader must not
    // collapse: not connected, or connected through an origin this closed enum
    // cannot name.
    const base = {
      id: "groq",
      name: "Groq",
      hasStoredCredential: false,
      canDisconnect: false,
      configDeclaredCustom: false,
      custom: null,
      methods: [],
    };
    expect(
      modelProviderEntrySchema.safeParse({
        ...base,
        source: null,
        connected: false,
      }).success,
    ).toBe(true);
    // The fail-soft case: upstream reports a source value newer than this
    // enum, so the origin goes unnamed - but the provider is serving requests
    // right now, and reporting it as disconnected would hide a working row.
    expect(
      modelProviderEntrySchema.safeParse({
        ...base,
        source: null,
        connected: true,
      }).success,
    ).toBe(true);
    // The enum itself stays closed: an unrecognized value is normalized to
    // null by the HOST, never carried through as a string a client would have
    // to guess at.
    expect(
      modelProviderEntrySchema.safeParse({
        ...base,
        source: "keychain",
        connected: false,
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
    // (its `metadata`). No env-var NAME is on this wire: the name the value
    // ends up stored under is never asked for, so there is nothing for a
    // client to guess at or get wrong.
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

  it("declares a custom provider with name, base URL and model ids", () => {
    const parsed = modelProviderAuthActionSchema.parse({
      action: "createCustom",
      modelProviderId: "my-endpoint",
      name: "My Endpoint",
      baseUrl: "https://api.example.com/v1",
      models: [
        { id: "gpt-4o-mini", name: "GPT-4o mini" },
        { id: "gpt-4o", name: "GPT-4o" },
      ],
    });
    expect(parsed.action).toBe("createCustom");
    if (parsed.action !== "createCustom") return;
    expect(parsed.models.map((model) => model.id)).toEqual([
      "gpt-4o-mini",
      "gpt-4o",
    ]);
    // `headers` defaults to `[]` - two states, so "none" gets one spelling.
    expect(parsed.headers).toEqual([]);
    // `env` defaults to NULL, not `[]`. Omitting it must mean "leave the env
    // declaration alone", never "clear it" - see the three-state test below.
    expect(parsed.env).toBeNull();
    expect(parsed.key).toBeNull();
  });

  it("takes the same declarable fields for create and update", () => {
    // Upstream's dialog is one form either way, so the block's own fields come
    // from one shared shape; this pins that they cannot drift apart. The id is
    // the one field the arms differ on - see the naming/addressing split
    // below.
    const fields = {
      modelProviderId: "my-endpoint",
      name: "My Endpoint",
      baseUrl: "https://api.example.com/v1",
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
    };
    for (const action of ["createCustom", "updateCustom"] as const) {
      expect(
        modelProviderAuthActionSchema.safeParse({ action, ...fields }).success,
        action,
      ).toBe(true);
    }
  });

  it("carries no npm field - the host writes the only value that works", () => {
    // `T(id)` only recognizes `@ai-sdk/openai-compatible`, so any other value
    // would declare a block this tab could never edit again. An unknown key is
    // stripped by the parse rather than honoured.
    const parsed = modelProviderAuthActionSchema.parse({
      action: "createCustom",
      modelProviderId: "my-endpoint",
      name: "My Endpoint",
      baseUrl: "https://api.example.com/v1",
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
      npm: "@ai-sdk/anthropic",
    });
    expect(Object.keys(parsed)).not.toContain("npm");
  });

  it("rejects a base URL that is not a URL", () => {
    // The paste people actually make. Caught at the boundary so it is a form
    // error next to the field, not a provider that silently never works.
    for (const baseUrl of ["api.example.com", "", "   "]) {
      expect(
        modelProviderAuthActionSchema.safeParse({
          action: "createCustom",
          modelProviderId: "my-endpoint",
          name: "My Endpoint",
          baseUrl,
          models: [{ id: "gpt-4o", name: "GPT-4o" }],
        }).success,
        baseUrl,
      ).toBe(false);
    }
    expect(
      modelProviderAuthActionSchema.safeParse({
        action: "createCustom",
        modelProviderId: "local",
        name: "Local",
        baseUrl: "http://localhost:1234/v1",
        models: [{ id: "llama", name: "Llama" }],
      }).success,
    ).toBe(true);
  });

  it("requires a name on every model", () => {
    // A blank name renders as an unlabelled row in every model picker in the
    // app - worse than refusing it, and a shape upstream's own dialog cannot
    // produce either.
    for (const models of [
      [{ id: "gpt-4o", name: "" }],
      [{ id: "gpt-4o" }],
      [{ id: "", name: "GPT-4o" }],
    ]) {
      expect(
        modelProviderAuthActionSchema.safeParse({
          action: "createCustom",
          modelProviderId: "my-endpoint",
          name: "My Endpoint",
          baseUrl: "https://api.example.com/v1",
          models,
        }).success,
        JSON.stringify(models),
      ).toBe(false);
    }
  });

  it("puts no character rule on model ids, which routinely carry @ and /", () => {
    // The provider-id rule must never be reused here: roughly 2,000 ids in the
    // live catalog would fail it.
    expect(
      modelProviderAuthActionSchema.safeParse({
        action: "createCustom",
        modelProviderId: "my-endpoint",
        name: "My Endpoint",
        baseUrl: "https://api.example.com/v1",
        models: [
          { id: "@cf/meta/llama-3.2-1b-instruct", name: "Llama 3.2 1B" },
          { id: "gpt-4.1", name: "GPT-4.1" },
        ],
      }).success,
    ).toBe(true);
  });

  it("constrains a NEW provider id but never an existing one", () => {
    // The rule is about NAMING, so it binds exactly where a name is chosen.
    // Everywhere else the id is a fact already on disk - and a rule applied
    // there does not prevent a bad name, it strands a real provider.
    const base = {
      name: "My Endpoint",
      baseUrl: "https://api.example.com/v1",
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
    };
    // Lowercase alphanumeric first, then alphanumerics, hyphens, underscores.
    for (const id of ["my-endpoint", "my_endpoint", "a1", "0x"]) {
      expect(
        modelProviderAuthActionSchema.safeParse({
          action: "createCustom",
          modelProviderId: id,
          ...base,
        }).success,
        id,
      ).toBe(true);
    }
    for (const id of ["-leading", "_leading", "Upper", "has space", "dot.id"]) {
      expect(
        modelProviderAuthActionSchema.safeParse({
          action: "createCustom",
          modelProviderId: id,
          ...base,
        }).success,
        id,
      ).toBe(false);
    }
  });

  it("lets updateCustom address a block the naming rule would reject", () => {
    // Update is the one verb that could rename a block, so a naming rule
    // applied here would strand exactly the ids that need renaming.
    // `My.Gateway` is the hand-written `opencode.json` case; `wafer.ai` is a
    // catalog id nobody chose at all.
    const base = {
      name: "My Endpoint",
      baseUrl: "https://api.example.com/v1",
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
    };
    for (const id of ["wafer.ai", "My.Gateway", "-leading", "has space"]) {
      expect(
        modelProviderAuthActionSchema.safeParse({
          action: "updateCustom",
          modelProviderId: id,
          ...base,
        }).success,
        `update ${id}`,
      ).toBe(true);
      expect(
        modelProviderAuthActionSchema.safeParse({
          action: "createCustom",
          modelProviderId: id,
          ...base,
        }).success,
        `create ${id}`,
      ).toBe(false);
    }
    // Still non-empty - an id is the one thing update cannot do without.
    expect(
      modelProviderAuthActionSchema.safeParse({
        action: "updateCustom",
        modelProviderId: "",
        ...base,
      }).success,
    ).toBe(false);
  });

  it("keeps every id-addressing verb free of the naming rule", () => {
    // The same leak in its other possible homes. `connect`/`startOauth`/
    // `submitCode`/`disconnect` all address providers that already exist.
    expect(
      modelProviderAuthActionSchema.safeParse({
        action: "disconnect",
        modelProviderId: "wafer.ai",
      }).success,
    ).toBe(true);
    expect(
      modelProviderAuthActionSchema.safeParse({
        action: "connect",
        modelProviderId: "wafer.ai",
        methodIndex: null,
        key: "sk-secret",
        inputs: {},
      }).success,
    ).toBe(true);
    expect(
      modelProviderAuthActionSchema.safeParse({
        action: "startOauth",
        modelProviderId: "wafer.ai",
        methodIndex: 0,
        inputs: {},
      }).success,
    ).toBe(true);
    expect(
      modelProviderAuthActionSchema.safeParse({
        action: "submitCode",
        modelProviderId: "wafer.ai",
        attemptId: "attempt-1",
        code: "abc123",
      }).success,
    ).toBe(true);
  });

  it("accepts the base URLs upstream's dialog accepts, prefix rule and all", () => {
    // Their check is a `http(s)://` PREFIX test, not a URL parse. Adopting the
    // rule means adopting its edges: a value their app takes must not be a
    // Traycer-only failure the user cannot explain.
    const base = {
      action: "createCustom" as const,
      modelProviderId: "my-endpoint",
      name: "My Endpoint",
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
    };
    for (const baseUrl of [
      "https://api.example.com/v1",
      "http://localhost:1234/v1",
      "https://host with spaces/v1",
      "http://",
    ]) {
      expect(
        modelProviderAuthActionSchema.safeParse({ ...base, baseUrl }).success,
        baseUrl,
      ).toBe(true);
    }
    for (const baseUrl of ["api.example.com", "ftp://example.com", "", "  "]) {
      expect(
        modelProviderAuthActionSchema.safeParse({ ...base, baseUrl }).success,
        baseUrl,
      ).toBe(false);
    }
  });

  /** Parse and narrow to the `createCustom` arm, so field reads type-check. */
  function parseCreateCustom(input: unknown) {
    const parsed = modelProviderAuthActionSchema.parse(input);
    if (parsed.action !== "createCustom") {
      throw new Error(`expected createCustom, got ${parsed.action}`);
    }
    return parsed;
  }

  it("keeps omitted, cleared and replaced env declarations distinct", () => {
    // Three states, and the gap between the first two is the reason this field
    // is nullable while `headers` is defaulted. Deleting the block's `env` key
    // server-side needs an explicit null, so "clear" has to be sendable - but
    // if ABSENT also meant clear, every client that simply does not populate
    // the field would submit a silent wipe. An update changing the display
    // name would delete how the provider reads its key.
    const base = {
      action: "createCustom" as const,
      modelProviderId: "my-endpoint",
      name: "My Endpoint",
      baseUrl: "https://api.example.com/v1",
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
    };
    // Absent and explicit null are the SAME state after parsing - one spelling
    // of "untouched" downstream - and both differ from `[]`.
    expect(parseCreateCustom(base).env).toBeNull();
    expect(parseCreateCustom({ ...base, env: null }).env).toBeNull();
    expect(parseCreateCustom({ ...base, env: [] }).env).toEqual([]);
    expect(
      parseCreateCustom({
        ...base,
        env: ["MY_ENDPOINT_KEY", "FALLBACK_KEY"],
      }).env,
    ).toEqual(["MY_ENDPOINT_KEY", "FALLBACK_KEY"]);
    // The assertion the wipe hazard turns on: omission must not arrive as the
    // clear signal.
    expect(parseCreateCustom(base).env).not.toEqual([]);
  });

  it("still gives headers one spelling of none, because it has no clear state", () => {
    // A header set is fully described by what the form submits, so omitted and
    // empty mean the same thing and nothing is destroyed by treating them
    // alike. Removal is refused rather than expressed, which is why the
    // three-state shape would buy nothing here.
    const base = {
      action: "createCustom" as const,
      modelProviderId: "my-endpoint",
      name: "My Endpoint",
      baseUrl: "https://api.example.com/v1",
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
    };
    expect(parseCreateCustom(base).headers).toEqual([]);
    expect(parseCreateCustom({ ...base, headers: [] }).headers).toEqual([]);
    expect(
      modelProviderAuthActionSchema.safeParse({ ...base, headers: null })
        .success,
    ).toBe(false);
  });

  it("carries headers, an in-form key and parsed env names", () => {
    const parsed = modelProviderAuthActionSchema.parse({
      action: "createCustom",
      modelProviderId: "my-endpoint",
      name: "My Endpoint",
      baseUrl: "https://api.example.com/v1",
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
      headers: [{ key: "X-Org", value: "acme" }],
      key: "sk-secret",
      // The `{env:VAR}` syntax is parsed client-side; the wire carries names,
      // so the syntax stays a presentation detail of whichever client offers
      // it and the host is never handed a template to re-parse.
      env: ["MY_ENDPOINT_KEY"],
    });
    expect(parsed.action).toBe("createCustom");
    if (parsed.action !== "createCustom") return;
    expect(parsed.headers).toEqual([{ key: "X-Org", value: "acme" }]);
    expect(parsed.key).toBe("sk-secret");
    expect(parsed.env).toEqual(["MY_ENDPOINT_KEY"]);
  });

  it("gives an absent key exactly one spelling", () => {
    // Null, never "". Two spellings of "no key" means one ends up unhandled.
    const base = {
      action: "createCustom" as const,
      modelProviderId: "my-endpoint",
      name: "My Endpoint",
      baseUrl: "https://api.example.com/v1",
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
    };
    expect(modelProviderAuthActionSchema.parse(base)).toMatchObject({
      key: null,
    });
    expect(
      modelProviderAuthActionSchema.parse({ ...base, key: null }),
    ).toMatchObject({ key: null });
    expect(
      modelProviderAuthActionSchema.safeParse({ ...base, key: "" }).success,
    ).toBe(false);
  });

  it("rejects a custom provider with no models", () => {
    // Not tidiness: upstream's `T(id)` requires a non-empty model map, so a
    // block declared with none would fail the very predicate that decides
    // whether the row is editable - created, then immediately unreachable.
    expect(
      modelProviderAuthActionSchema.safeParse({
        action: "createCustom",
        modelProviderId: "my-endpoint",
        name: "My Endpoint",
        baseUrl: "https://api.example.com/v1",
        models: [],
      }).success,
    ).toBe(false);
  });

  it("has no removeCustom arm - removing a custom provider IS disconnecting it", () => {
    // Two verbs would have let a client delete the declaration while leaving
    // the provider enabled: one state, reachable two ways, with nothing to
    // clean up the difference.
    expect(
      modelProviderAuthActionSchema.safeParse({
        action: "removeCustom",
        modelProviderId: "my-endpoint",
      }).success,
    ).toBe(false);
    expect(
      modelProviderAuthActionSchema.safeParse({
        action: "disconnect",
        modelProviderId: "my-endpoint",
      }).success,
    ).toBe(true);
  });

  it("has no separate disabled-providers toggle either", () => {
    // Disabling is what disconnect DOES for a row with no credential to
    // remove. A toggle beside it would be a second spelling of the same
    // intention, and the two could disagree.
    expect(
      modelProviderAuthActionSchema.safeParse({
        action: "setDisabled",
        modelProviderId: "my-endpoint",
        disabled: true,
      }).success,
    ).toBe(false);
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

  it("has an OUTCOMES entry for every auth error code, so a new member cannot ship untested", () => {
    const covered = OUTCOMES.map(({ code }) => code).sort();
    expect(covered).toEqual(
      [...modelProviderAuthErrorCodeSchema.options].sort(),
    );
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
    for (const code of [
      "external_drift",
      "rollback_failed",
      "duplicate_name",
    ]) {
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

  // EMPTY, and kept empty rather than removed. It is the seam a deliberate
  // overlap between the two vocabularies has to pass through: an overlap that
  // must be written down here stays intentional, while deleting the mechanism
  // would let the next accidental one read as approved.
  const DELIBERATELY_SHARED_CODES: readonly string[] = [];

  it("shares exactly the codes it means to with the native vocabulary", () => {
    const ours = new Set<string>([
      ...modelProviderListErrorCodeSchema.options,
      ...modelProviderAuthErrorCodeSchema.options,
    ]);
    const overlap = providerNativeErrorCodeSchema.options.filter((code) =>
      ours.has(code),
    );
    expect([...overlap].sort()).toEqual([...DELIBERATELY_SHARED_CODES].sort());
  });

  it("keeps every other code out of the shared native vocabulary", () => {
    // Not a style preference: `providerNativeErrorCodeSchema` rides RELEASED
    // carriers, so it cannot be widened, and its other members describe
    // config-file EDITS. A model-provider code leaking into it (or vice versa)
    // would mean one of the two enums grew where it must not.
    const ours = [
      ...modelProviderListErrorCodeSchema.options,
      ...modelProviderAuthErrorCodeSchema.options,
    ];
    for (const code of ours) {
      if (DELIBERATELY_SHARED_CODES.includes(code)) continue;
      expect(
        providerNativeErrorCodeSchema.safeParse(code).success,
        `${code} must not exist on the shared native enum`,
      ).toBe(false);
    }
    for (const code of providerNativeErrorCodeSchema.options) {
      if (DELIBERATELY_SHARED_CODES.includes(code)) continue;
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

  it("cannot say config_unreadable, because nothing here can observe it", () => {
    // Every config read and write goes through the managed server, so a config
    // the server cannot parse is a server that never boots: there is no GET or
    // PATCH left to fail, and the condition can only arrive as a failed lease.
    //
    // A code no producer can emit is worse than a missing one - it gets
    // handled, weighed, and never reached. Rejected on both arms so it cannot
    // drift in.
    expect(
      modelProvidersListResultSchema.safeParse({
        ok: false,
        code: "config_unreadable",
        detail: "opencode.json: unexpected token at line 12",
      }).success,
    ).toBe(false);
    for (const response of [
      providersModelProviderAuthResponseSchema,
      providersAwaitModelProviderAuthResponseSchema,
    ]) {
      expect(
        response.safeParse({
          result: { kind: "error", code: "config_unreadable", detail: null },
        }).success,
      ).toBe(false);
    }
  });

  it("says it as server_unavailable instead, with the parser's own message", () => {
    // Strictly more actionable than the typed code was: `detail` carries the
    // redacted stderr tail, which names the file, the line and the column.
    expect(
      modelProvidersListResultSchema.safeParse({
        ok: false,
        code: "server_unavailable",
        detail: "opencode.json:12:5 unexpected token",
      }).success,
    ).toBe(true);
    expect(
      providersModelProviderAuthResponseSchema.safeParse({
        result: {
          kind: "error",
          code: "server_unavailable",
          detail: "opencode.json:12:5 unexpected token",
        },
      }).success,
    ).toBe(true);
  });

  it("keeps the code alive on the native vocabulary, which does read files", () => {
    // Not a deprecation. The MCP surface reads provider config files directly,
    // so it genuinely produces this condition and keeps the word for it.
    expect(
      providerNativeErrorCodeSchema.safeParse("config_unreadable").success,
    ).toBe(true);
  });
});

describe("the v7.0 capability freeze around the model-provider surface", () => {
  // Hand-frozen copies that still deep-equal their live counterparts. Green
  // today; red the day a live subtree grows past the frozen line - and the
  // answer to red is main's freeze rule: keep the copy frozen and extend the
  // v8->v7 projection/bridge to say what a v7.0 peer sees instead.
  const PAIRS = [
    [
      "mcp capabilities",
      providerMcpCapabilitiesSchema,
      providerMcpCapabilitiesSchemaV70,
    ],
    [
      "plugins capabilities",
      providerPluginsCapabilitiesSchema,
      providerPluginsCapabilitiesSchemaV70,
    ],
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

  it("frozen skills actionScopes = live keys minus inspect/edit/update, exactly", () => {
    const liveKeys = Object.keys(
      providerSkillsCapabilitiesSchema.shape.actionScopes.shape,
    ).sort();
    const frozenKeys = Object.keys(
      providerSkillsCapabilitiesSchemaV70.shape.actionScopes.shape,
    ).sort();
    expect(liveKeys).toEqual(
      [...frozenKeys, "edit", "inspect", "update"].sort(),
    );
  });

  it("frozen tabs = live tabs minus modelProviders, exactly", () => {
    // Pins BOTH directions of the projection's premise: the frozen enum has
    // no member the live one lacks, and `modelProviders` is the only member
    // the live one adds. A second live-only tab would land here first, as a
    // prompt to extend the projection's coverage tests.
    expect([...providerSettingsTabSchema.options].sort()).toEqual(
      [...providerSettingsTabSchemaV70.options, "modelProviders"].sort(),
    );
  });

  it("frozen capability keys = live keys minus modelProviders, exactly", () => {
    expect(
      [...Object.keys(providerNativeCapabilitiesSchema.shape)].sort(),
    ).toEqual(
      [
        ...Object.keys(providerNativeCapabilitiesSchemaV70.shape),
        "modelProviders",
      ].sort(),
    );
  });

  it("projects a full live descriptor without losing a sibling capability", () => {
    const projected = projectNativeCapabilitiesToV70(OPENCODE_CAPABILITIES);
    expect(projected.supportedTabs).not.toContain("modelProviders");
    expect(projected.mcp).toEqual(OPENCODE_CAPABILITIES.mcp);
    expect(projected.plugins).toEqual(OPENCODE_CAPABILITIES.plugins);
    expect(projected.skills).toEqual(OPENCODE_CAPABILITIES.skills);
  });

  it("wires the v7.0 state to the frozen capability descriptor by identity", () => {
    // Spot checks that name the seams a reader cares about; the deep
    // frozen-catalog snapshot is the exhaustive guarantee.
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

describe("no downgrade hop fails a whole response over one unsupported provider", () => {
  // The class the v7 -> v6 hop belongs to. `z.array` fails WHOLE on one bad
  // element, so a frozen line's id enum rejecting a newer provider does not
  // drop that provider - it throws the entire `providers.list` response for
  // that peer, taking every healthy provider with it.
  //
  // Reachable the instant `huggingface` joined the live id enum.
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

  it.each([1, 2, 3, 4, 5, 6] as const)(
    "7.0 -> v%i.0 answers rather than throwing when the list carries a newer provider",
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
      // `huggingface` is post-v6.0, so no older line names it.
      expect(ids).not.toContain("huggingface");
    },
  );
});
