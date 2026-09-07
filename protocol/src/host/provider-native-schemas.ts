/** Payload schemas for provider-native MCP / plugins / skills settings. */
import { z } from "zod";
import { providerIdSchema } from "./provider-ids";

// ── Scope tuple (shared by every native verb) ──────────────────────────────

/** Wire scope is `global | project` only (tech-plan Decision 5). */
export const providerNativeScopeSchema = z.enum(["global", "project"]);
export type ProviderNativeScope = z.infer<typeof providerNativeScopeSchema>;

/** Base object for the scope tuple - kept unrefined so request schemas can `.extend()` it. */
export const providerNativeScopeTupleBaseSchema = z.object({
  providerId: providerIdSchema,
  scope: providerNativeScopeSchema,
  workspaceRoot: z.string().nullable(),
});

/**
 * Shared scope/workspaceRoot invariant used by every nested native context (list query, mutation, auth action/poll/cancel).
 */
export function refineProviderNativeScope(
  value: { readonly scope?: unknown; readonly workspaceRoot?: unknown },
  ctx: z.RefinementCtx,
): void {
  if (!("scope" in value) || !("workspaceRoot" in value)) {
    return;
  }
  const scope = value.scope;
  const workspaceRoot = value.workspaceRoot;
  if (scope !== "global" && scope !== "project") {
    return;
  }
  if (typeof workspaceRoot !== "string" && workspaceRoot !== null) {
    return;
  }
  if (scope === "project") {
    if (workspaceRoot === null || workspaceRoot.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["workspaceRoot"],
        message: 'scope "project" requires a non-empty workspaceRoot',
      });
    }
    return;
  }
  if (workspaceRoot !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["workspaceRoot"],
      message: 'scope "global" requires workspaceRoot: null',
    });
  }
}

/** Refine any object schema that includes the scope-tuple fields. */
export function withProviderNativeScopeInvariant<Shape extends z.ZodRawShape>(
  schema: z.ZodObject<Shape>,
) {
  return schema.superRefine(refineProviderNativeScope);
}

export const providerNativeScopeTupleSchema = withProviderNativeScopeInvariant(
  providerNativeScopeTupleBaseSchema,
);
export type ProviderNativeScopeTuple = z.infer<
  typeof providerNativeScopeTupleSchema
>;

// ── Native error contract (rides inside additive native result fields) ─────

export const providerNativeErrorCodeSchema = z.enum([
  "duplicate_name",
  "unsupported_scope",
  "unsupported_action",
  "no_change_detected",
  "external_drift",
  "store_version_unsupported",
  "rollback_failed",
  // The provider's own config could not be READ or PARSED - a malformed `config.yaml`/`config.toml`/`mcp.json`, or an unreadable one.
  "config_unreadable",
]);
export type ProviderNativeErrorCode = z.infer<
  typeof providerNativeErrorCodeSchema
>;

export const providerNativeErrorResultSchema = z.object({
  ok: z.literal(false),
  code: providerNativeErrorCodeSchema,
  detail: z.string().nullable(),
});
export type ProviderNativeErrorResult = z.infer<
  typeof providerNativeErrorResultSchema
>;

// ── Capability descriptor (action → scope table) ───────────────────────────

export const providerSettingsTabSchema = z.enum([
  "general",
  "env",
  "usage",
  "mcp",
  "plugins",
  "skills",
  "modelProviders",
]);
export type ProviderSettingsTab = z.infer<typeof providerSettingsTabSchema>;

/** Which provider operations receive Settings → Providers environment overrides. */
export const providerEnvOverrideScopeSchema = z.enum([
  "harness-and-native-config",
  "native-config-only",
]);
export type ProviderEnvOverrideScope = z.infer<
  typeof providerEnvOverrideScopeSchema
>;

export const providerMcpTransportSchema = z.enum(["stdio", "http", "sse"]);
export type ProviderMcpTransport = z.infer<typeof providerMcpTransportSchema>;

export const providerMcpAuthTypeSchema = z.enum([
  "none",
  "header",
  "env",
  "oauth",
]);
export type ProviderMcpAuthType = z.infer<typeof providerMcpAuthTypeSchema>;

/**
 * Auth actions the UI may render for this provider.
 * Descriptor-driven so config-only providers never show a fake login button. - `login` / `submitCode` / `logout` / `clearAuth` - standard flows - `forceReauth` - copilot-style "logout" (no clean logout; re-auth only)
 */
export const providerMcpAuthActionSchema = z.enum([
  "login",
  "submitCode",
  "logout",
  "clearAuth",
  "forceReauth",
]);
export type ProviderMcpAuthAction = z.infer<typeof providerMcpAuthActionSchema>;

/** Mutation verbs the host will accept for this provider. */
export const providerMcpMutationActionSchema = z.enum([
  "add",
  "update",
  "remove",
  "toggleServer",
  "toggleTool",
]);
export type ProviderMcpMutationAction = z.infer<
  typeof providerMcpMutationActionSchema
>;

export const providerMcpPerToolBackingSchema = z.enum([
  "native",
  "store",
  "degraded-server-level",
  "none",
]);
export type ProviderMcpPerToolBacking = z.infer<
  typeof providerMcpPerToolBackingSchema
>;

export const providerMcpDataSourceSchema = z.enum(["native", "probe", "none"]);
export type ProviderMcpDataSource = z.infer<typeof providerMcpDataSourceSchema>;

/**
 * Write path for server CRUD. Cursor is patch-only; opencode CLI add + patch
 * remove; kimi patch-only (kimi-code has no `mcp` CLI).
 */
export const providerMcpWritePathSchema = z.enum(["cli", "patch", "none"]);
export type ProviderMcpWritePath = z.infer<typeof providerMcpWritePathSchema>;

/**
 * MCP surface actions that may be advertised with a per-action scope list.
 * Missing/empty scopes means the action is unsupported for that provider.
 */
export const providerMcpCapabilityActionSchema = z.enum([
  "list",
  "add",
  "update",
  "remove",
  "toggleServer",
  "toggleTool",
  "discover",
  "auth",
]);
export type ProviderMcpCapabilityAction = z.infer<
  typeof providerMcpCapabilityActionSchema
>;

/** OAuth fields to capture on Add when `authTypes` includes `"oauth"`. */
export const providerMcpOauthFieldSchema = z.enum(["clientId", "resource"]);
export type ProviderMcpOauthField = z.infer<typeof providerMcpOauthFieldSchema>;

export const providerMcpCapabilitiesSchema = z.object({
  transports: z.array(providerMcpTransportSchema),
  authTypes: z.array(providerMcpAuthTypeSchema),
  authActions: z.array(providerMcpAuthActionSchema),
  /**
   * Action → supported scopes table. Empty array means the action is not
   * offered for any scope (UI hides it; host rejects it).
   */
  actionScopes: z.object({
    list: z.array(providerNativeScopeSchema),
    add: z.array(providerNativeScopeSchema),
    update: z.array(providerNativeScopeSchema),
    remove: z.array(providerNativeScopeSchema),
    toggleServer: z.array(providerNativeScopeSchema),
    toggleTool: z.array(providerNativeScopeSchema),
    discover: z.array(providerNativeScopeSchema),
    auth: z.array(providerNativeScopeSchema),
  }),
  addServer: providerMcpWritePathSchema,
  removeServer: providerMcpWritePathSchema,
  updateServer: providerMcpWritePathSchema,
  /**
   * True when the provider's write path genuinely serializes more than one header row (installed-CLI-confirmed repeatable flag, or a config-file headers map).
   * False (default) - the renderer shows exactly one header row with no "Add header" affordance, so no captured row is ever silently dropped by the host.
   */
  supportsMultipleHeaders: z.boolean().default(false).optional(),
  /** OAuth fields to render on Add when `authTypes` includes `"oauth"`. */
  oauthFields: z.array(providerMcpOauthFieldSchema).default([]).optional(),
  perToolBacking: providerMcpPerToolBackingSchema,
  /**
   * Status dot source. UI labels probe results as connectivity checks, never
   * as "provider CLI is logged in."
   */
  statusSource: providerMcpDataSourceSchema,
  toolsSource: providerMcpDataSourceSchema,
  /** Tool input schemas. */
  schemasSource: providerMcpDataSourceSchema,
  /** `initialize.instructions` - probe-only for every provider. */
  instructionsSource: z.enum(["probe", "none"]),
  /**
   * True when store-backed enforcement only applies inside Traycer-launched sessions (codex `-c enabled_tools`, amp SDK `enabledTools`).
   */
  traycerSessionsOnlyEnforcement: z.boolean(),
  /**
   * V3 ACP fallback: stdio servers are config-management-only (cannot inject
   * over ACP). UI shows a degrade notice when true.
   */
  stdioDegradeNotice: z.boolean(),
  /**
   * OAuth'd servers have no Traycer probe path (wrong OAuth client). Status /
   * names only where a native source exists; hover schemas/instructions omit.
   */
  oauthDegradesToConfigOnly: z.boolean(),
});
export type ProviderMcpCapabilities = z.infer<
  typeof providerMcpCapabilitiesSchema
>;

export const providerPluginsAddModeSchema = z.enum([
  "cli-source",
  "marketplace",
  "file-drop",
  "patch",
  "read-only",
]);
export type ProviderPluginsAddMode = z.infer<
  typeof providerPluginsAddModeSchema
>;

export const providerPluginsCapabilityActionSchema = z.enum([
  "list",
  "add",
  "remove",
  "setEnabled",
]);
export type ProviderPluginsCapabilityAction = z.infer<
  typeof providerPluginsCapabilityActionSchema
>;

export const providerPluginsCapabilitiesSchema = z.object({
  addModes: z.array(providerPluginsAddModeSchema),
  /**
   * Machine-readable marketplace listing. False for droid/copilot/qwen
   * (text-only) - UI offers add-by-source instead of browse.
   */
  marketplaceBrowse: z.boolean(),
  /**
   * Action → supported scopes table. Empty array means the action is not
   * offered for any scope.
   */
  actionScopes: z.object({
    list: z.array(providerNativeScopeSchema),
    add: z.array(providerNativeScopeSchema),
    remove: z.array(providerNativeScopeSchema),
    setEnabled: z.array(providerNativeScopeSchema),
  }),
  /**
   * V4 amp: plugins load for CLI `tools list` / `plugins list`, but plugin
   * tools are absent from Traycer `execute()` stream. UI warns when true.
   */
  traycerSessionToolsNotice: z.boolean(),
});
export type ProviderPluginsCapabilities = z.infer<
  typeof providerPluginsCapabilitiesSchema
>;

export const providerSkillsCapabilityActionSchema = z.enum([
  "list",
  "add",
  "create",
  "import",
  "remove",
  "inspect",
  "edit",
  "update",
]);
export type ProviderSkillsCapabilityAction = z.infer<
  typeof providerSkillsCapabilityActionSchema
>;

export const providerSkillsCapabilitiesSchema = z.object({
  /**
   * Action → supported scopes table.
   * Do not default them - absent is the signal.
   */
  actionScopes: z.object({
    list: z.array(providerNativeScopeSchema),
    add: z.array(providerNativeScopeSchema),
    create: z.array(providerNativeScopeSchema),
    import: z.array(providerNativeScopeSchema),
    remove: z.array(providerNativeScopeSchema),
    inspect: z.array(providerNativeScopeSchema).optional(),
    edit: z.array(providerNativeScopeSchema).optional(),
    update: z.array(providerNativeScopeSchema).optional(),
  }),
});
export type ProviderSkillsCapabilities = z.infer<
  typeof providerSkillsCapabilitiesSchema
>;

/**
 * Actions the Model Providers tab may offer for a provider's UPSTREAM LLM credentials (OpenCode's `opencode auth login` surface, rendered visually).
 * Listing is what a non-null capability block MEANS - a block that cannot list has nothing to render - and upstream credentials are per-user, so `global`/`project` has no referent here (see the plan's "Scope selector".
 */
export const providerModelProvidersCapabilityActionSchema = z.enum([
  "connect",
  "oauth",
  "disconnect",
  "createCustom",
  "updateCustom",
]);
export type ProviderModelProvidersCapabilityAction = z.infer<
  typeof providerModelProvidersCapabilityActionSchema
>;

/** Model Providers tab facts. */
export const providerModelProvidersCapabilitiesSchema = z.object({
  actions: z.array(providerModelProvidersCapabilityActionSchema),
});
export type ProviderModelProvidersCapabilities = z.infer<
  typeof providerModelProvidersCapabilitiesSchema
>;

/**
 * Per-capability facts the UI renders tabs/modals from. Null domain objects
 * mean the tab is unsupported (also reflected in `supportedTabs`).
 */
export const providerNativeCapabilitiesSchema = z.object({
  supportedTabs: z.array(providerSettingsTabSchema),
  /**
   * Omitted by older hosts and ordinary contracts, which retain the existing harness-and-native-config behaviour.
   */
  envOverrideScope: providerEnvOverrideScopeSchema.optional(),
  mcp: providerMcpCapabilitiesSchema.nullable(),
  plugins: providerPluginsCapabilitiesSchema.nullable(),
  skills: providerSkillsCapabilitiesSchema.nullable(),
  /**
   * Upstream LLM credential management - see `providerModelProvidersCapabilitiesSchema`.
   * Required-and-nullable, exactly like its three siblings, rather than `.optional()`: every hop that lands on this shape has to fill it, and required is what makes forgetting fail loudly.
   */
  modelProviders: providerModelProvidersCapabilitiesSchema.nullable(),
});
export type ProviderNativeCapabilities = z.infer<
  typeof providerNativeCapabilitiesSchema
>;

/**
 * Default descriptor for old-host responses / `.catch()` on wire parse.
 * Empty tabs → UI shows only the pre-existing General/Env/Usage surfaces that do not depend on this field.
 */
export const DEFAULT_PROVIDER_NATIVE_CAPABILITIES: ProviderNativeCapabilities =
  {
    supportedTabs: ["general", "env", "usage"],
    mcp: null,
    plugins: null,
    skills: null,
    modelProviders: null,
  };

// ── Transport + auth (write vs masked read) ────────────────────────────────

/** Write-side secret: raw value is accepted on the wire once, never echoed. */
export const providerMcpSecretWriteSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
});
export type ProviderMcpSecretWrite = z.infer<
  typeof providerMcpSecretWriteSchema
>;

/** Read-side secret mask: name + presence only. */
export const providerMcpSecretMaskSchema = z.object({
  name: z.string().min(1),
  hasValue: z.boolean(),
});
export type ProviderMcpSecretMask = z.infer<typeof providerMcpSecretMaskSchema>;

export const providerMcpAuthWriteSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("header"),
    name: z.string().min(1),
    value: z.string(),
    /** Extra repeatable header rows beyond `name`/`value` (the first row). */
    additionalHeaders: z
      .array(providerMcpSecretWriteSchema)
      .default([])
      .optional(),
  }),
  z.object({
    type: z.literal("env"),
    name: z.string().min(1),
    value: z.string(),
  }),
  z.object({
    type: z.literal("oauth"),
    /** Provider-specific OAuth client identity (Codex `--oauth-client-id`). */
    oauthClientId: z.string().nullable().default(null).optional(),
    /** Codex `--oauth-resource`. */
    oauthResource: z.string().nullable().default(null).optional(),
  }),
]);
export type ProviderMcpAuthWrite = z.infer<typeof providerMcpAuthWriteSchema>;

export const providerMcpAuthReadSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("header"),
    name: z.string().min(1),
    hasValue: z.boolean(),
  }),
  z.object({
    type: z.literal("env"),
    name: z.string().min(1),
    hasValue: z.boolean(),
  }),
  z.object({
    type: z.literal("oauth"),
  }),
]);
export type ProviderMcpAuthRead = z.infer<typeof providerMcpAuthReadSchema>;

/**
 * Write-side transport (mutate add/update). Secrets may be present; host never
 * echoes them on list responses.
 */
export const providerMcpServerTransportWriteSchema = z.discriminatedUnion(
  "type",
  [
    z.object({
      type: z.literal("stdio"),
      command: z.string().min(1),
      args: z.array(z.string()),
      env: z.array(providerMcpSecretWriteSchema).nullable(),
    }),
    z.object({
      type: z.literal("http"),
      url: z.string().min(1),
      auth: providerMcpAuthWriteSchema.nullable(),
    }),
    z.object({
      type: z.literal("sse"),
      url: z.string().min(1),
      auth: providerMcpAuthWriteSchema.nullable(),
    }),
  ],
);
export type ProviderMcpServerTransportWrite = z.infer<
  typeof providerMcpServerTransportWriteSchema
>;

/**
 * Read-side transport (list/discover). Least-privilege: no raw env/headers/
 * argv on the wire - command/url identity only, secrets masked.
 */
export const providerMcpServerTransportReadSchema = z.discriminatedUnion(
  "type",
  [
    z.object({
      type: z.literal("stdio"),
      command: z.string(),
      env: z.array(providerMcpSecretMaskSchema).nullable(),
    }),
    z.object({
      type: z.literal("http"),
      url: z.string(),
      auth: providerMcpAuthReadSchema.nullable(),
    }),
    z.object({
      type: z.literal("sse"),
      url: z.string(),
      auth: providerMcpAuthReadSchema.nullable(),
    }),
  ],
);
export type ProviderMcpServerTransportRead = z.infer<
  typeof providerMcpServerTransportReadSchema
>;

// ── MCP list / server row ──────────────────────────────────────────────────

export const providerMcpServerStatusSchema = z.enum([
  "connected",
  "disconnected",
  "connecting",
  "needs_auth",
  "error",
  "unknown",
  "config_only",
]);
export type ProviderMcpServerStatus = z.infer<
  typeof providerMcpServerStatusSchema
>;

export const providerMcpToolDenySourceSchema = z.enum([
  "user",
  "shared",
  "local",
]);
export type ProviderMcpToolDenySource = z.infer<
  typeof providerMcpToolDenySourceSchema
>;

export const providerMcpToolSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  /**
   * JSON Schema object for tool input, when known. Null when names-only
   * (native without schemas) or not yet discovered.
   */
  inputSchema: z.record(z.string(), z.unknown()).nullable(),
  enabled: z.boolean(),
  /**
   * True when the tool row is display-only (degraded-server-level backing or OAuth-degraded probe), or when a deny is inherited from a non-local source that a local toggle cannot clear.
   */
  readOnly: z.boolean(),
  /** Sources that currently deny this tool (union). */
  denySources: z.array(providerMcpToolDenySourceSchema).default([]).optional(),
});
/**
 * Inferred type keeps `denySources` optional so host constructors that do not set Claude provenance need not pass an empty array.
 */
export type ProviderMcpTool = z.infer<typeof providerMcpToolSchema>;

export const providerMcpServerSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
  transport: providerMcpServerTransportReadSchema,
  status: providerMcpServerStatusSchema,
  /**
   * Which plane produced `status` - UI labels probe vs native differently.
   */
  statusSource: providerMcpDataSourceSchema,
  statusDetail: z.string().nullable(),
  tools: z.array(providerMcpToolSchema),
  /**
   * True while discovery is in-flight; client re-fetches / polls list.
   */
  discoveryPending: z.boolean(),
  /**
   * `initialize.instructions` text when probe-available; null otherwise.
   */
  instructions: z.string().nullable(),
  /**
   * Server is OAuth-gated and Traycer cannot probe it; manage via provider
   * native surface / config only.
   */
  configOnly: z.boolean(),
  /**
   * Stdio server under an ACP provider that cannot inject stdio over ACP
   * (V3 degrade). Config editable; live connect unavailable in-session.
   */
  stdioDegraded: z.boolean(),
});
export type ProviderMcpServer = z.infer<typeof providerMcpServerSchema>;

// ── Plugins / skills rows ──────────────────────────────────────────────────

export const providerPluginSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string().nullable(),
  enabled: z.boolean(),
  source: z.string().nullable(),
  /**
   * True when the plugin is listed but cannot be toggled/removed in v1
   * (read-only tab).
   */
  readOnly: z.boolean(),
  /**
   * Plugin description, when the provider's listing exposes one. Additive:
   * defaults to null for providers that don't populate it yet.
   */
  description: z.string().nullable().default(null).optional(),
  /**
   * Human-facing name from the provider's own manifest ("PDF", "Default templates") where `name` is the install id ("pdf", "openai-templates").
   */
  displayName: z.string().nullable().default(null).optional(),
  /** The provider ships artwork for this plugin AND the file is present on disk. */
  hasIcon: z.boolean().default(false).optional(),
  /** The provider ships a SEPARATE dark-theme asset for this plugin. */
  hasDarkIcon: z.boolean().default(false).optional(),
});
export type ProviderPlugin = z.infer<typeof providerPluginSchema>;

/**
 * Which theme variant of a plugin icon to resolve. Hosts fall back to the
 * light asset when a plugin ships no dark one, so `dark` is always answerable.
 */
export const providerPluginIconThemeSchema = z.enum(["light", "dark"]);
export type ProviderPluginIconTheme = z.infer<
  typeof providerPluginIconThemeSchema
>;

/** One plugin's artwork, inlined as a `data:` URI. */
export const providerPluginIconSchema = z.object({
  /** `data:<mime>;base64,<bytes>`, or null when unreadable/absent/oversized. */
  dataUri: z.string().nullable(),
  /** Why there is no icon, for logs. Not surfaced as an error state. */
  error: z.string().nullable(),
});
export type ProviderPluginIcon = z.infer<typeof providerPluginIconSchema>;

export const providerSkillSourceBadgeSchema = z.enum([
  "shared",
  "provider",
  "plugin",
  "managed",
]);
export type ProviderSkillSourceBadge = z.infer<
  typeof providerSkillSourceBadgeSchema
>;

export const providerSkillSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  path: z.string(),
  source: providerSkillSourceBadgeSchema,
  /**
   * Provenance display line ("Imported from <source>"). Omitted or null when
   * the skill was authored locally or has no recorded origin.
   */
  origin: z.string().nullable().optional(),
  /**
   * True when a foreign real directory occupies a would-be link target.
   * Omitted means this is not a conflict row.
   */
  conflict: z.boolean().optional(),
});
export type ProviderSkill = z.infer<typeof providerSkillSchema>;

/**
 * Frozen skill row as of the `providers.list@7.0` cut. Live
 * {@link providerSkillSchema} grew `origin` / `conflict`; v7.0 must not.
 */
export const providerSkillSchemaV70Preimage = z.object({
  name: z.string(),
  description: z.string().nullable(),
  path: z.string(),
  source: providerSkillSourceBadgeSchema,
});
export type ProviderSkillV70Preimage = z.infer<
  typeof providerSkillSchemaV70Preimage
>;

export const providerSkillInspectCandidateSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable(),
  relPath: z.string().min(1),
  installed: z.boolean(),
});
export type ProviderSkillInspectCandidate = z.infer<
  typeof providerSkillInspectCandidateSchema
>;

export const providersSkillsInspectResultSchema = z.object({
  token: z.string().min(1),
  commitSha: z.string().min(1),
  candidates: z.array(providerSkillInspectCandidateSchema),
});
export type ProvidersSkillsInspectResult = z.infer<
  typeof providersSkillsInspectResultSchema
>;

// ── Mutation action payloads ───────────────────────────────────────────────

export const providersMcpMutateActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("add"),
    name: z.string().min(1),
    transport: providerMcpServerTransportWriteSchema,
  }),
  z.object({
    action: z.literal("update"),
    name: z.string().min(1),
    transport: providerMcpServerTransportWriteSchema,
  }),
  z.object({
    action: z.literal("remove"),
    name: z.string().min(1),
  }),
  z.object({
    action: z.literal("toggleServer"),
    name: z.string().min(1),
    enabled: z.boolean(),
  }),
  z.object({
    action: z.literal("toggleTool"),
    serverName: z.string().min(1),
    toolName: z.string().min(1),
    enabled: z.boolean(),
  }),
]);
export type ProvidersMcpMutateAction = z.infer<
  typeof providersMcpMutateActionSchema
>;

export const providersPluginsMutateActionSchema = z.discriminatedUnion(
  "action",
  [
    z.object({
      action: z.literal("add"),
      /**
       * Source string: npm/path/git/`plugin@marketplace`/local path depending
       * on provider add mode.
       */
      source: z.string().min(1),
    }),
    z.object({
      action: z.literal("remove"),
      id: z.string().min(1),
    }),
    z.object({
      action: z.literal("setEnabled"),
      id: z.string().min(1),
      enabled: z.boolean(),
    }),
  ],
);
export type ProvidersPluginsMutateAction = z.infer<
  typeof providersPluginsMutateActionSchema
>;

export const providersSkillsMutateActionSchema = z
  .discriminatedUnion("action", [
    z.object({
      action: z.literal("add"),
      /**
       * Absolute path to a local skill directory (or SKILL.md file) to copy
       * into the shared or provider-native root.
       */
      sourcePath: z.string().min(1),
      /**
       * When true, write under the provider-native root; otherwise the shared
       * `~/.agents/skills` root.
       */
      providerScoped: z.boolean(),
    }),
    z.object({
      action: z.literal("create"),
      /** Skill directory / frontmatter name (host validates name pattern). */
      name: z.string().min(1),
      description: z.string(),
      body: z.string(),
      /**
       * When true, write under the provider-native root; otherwise the shared
       * `~/.agents/skills` root.
       */
      providerScoped: z.boolean(),
    }),
    z.object({
      action: z.literal("import"),
      /**
       * File, URL, or directory depending on provider (e.g. copilot
       * `skill add`).
       */
      source: z.string().min(1),
      /** When true, write under the provider-native root; otherwise the shared `~/.agents/skills` root. */
      providerScoped: z.boolean(),
      /**
       * Inspect-session token from a prior `inspect`. Omitted on the legacy
       * single-shot import path.
       */
      token: z.string().min(1).optional(),
      /**
       * Candidate names selected in the picker. Omitted on the legacy
       * single-shot import path.
       */
      names: z.array(z.string().min(1)).optional(),
    }),
    z.object({
      action: z.literal("inspect"),
      /**
       * File, URL, `owner/repo`, tree URL, or `npx skills add …` wrapper.
       */
      source: z.string().min(1),
      /**
       * Dest-root scope used to mark candidates `installed`. Same axis as
       * the mutation envelope's `scope`.
       */
      scope: providerNativeScopeSchema,
    }),
    z.object({
      action: z.literal("edit"),
      path: z.string().min(1),
      /** SHA-256 of the exact SKILL.md text the editor loaded. */
      expectedHash: z.string().regex(/^[0-9a-f]{64}$/),
      name: z.string().min(1),
      description: z.string(),
      body: z.string(),
    }),
    z.object({
      action: z.literal("update"),
      name: z.string().min(1),
      path: z.string().min(1),
      /**
       * Required to clobber local edits (canon hash ≠ recorded
       * `installedHash`). Omitted / false is a dry check that must not write.
       */
      confirm: z.boolean().optional(),
    }),
    z.object({
      action: z.literal("remove"),
      name: z.string().min(1),
      path: z.string().min(1),
    }),
  ])
  .superRefine((value, ctx) => {
    if (value.action !== "import") return;
    if ((value.token === undefined) === (value.names === undefined)) return;
    ctx.addIssue({
      code: "custom",
      path: value.token === undefined ? ["token"] : ["names"],
      message: "token and names must be provided together",
    });
  });
export type ProvidersSkillsMutateAction = z.infer<
  typeof providersSkillsMutateActionSchema
>;

// ── Carrier payloads: list (providers.list@3.1) ────────────────────────────

/**
 * Native list query folded onto `providers.list@3.1` as `native`.
 * Scope/workspaceRoot invariant applied via shared refinement (union arms cannot individually be ZodEffects under discriminatedUnion).
 */
export const nativeListQuerySchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("mcp"),
      providerId: providerIdSchema,
      scope: providerNativeScopeSchema,
      workspaceRoot: z.string().nullable(),
    }),
    z.object({
      kind: z.literal("plugins"),
      providerId: providerIdSchema,
      scope: providerNativeScopeSchema,
      workspaceRoot: z.string().nullable(),
    }),
    z.object({
      kind: z.literal("skills"),
      providerId: providerIdSchema,
      scope: providerNativeScopeSchema,
      workspaceRoot: z.string().nullable(),
    }),
    z.object({
      kind: z.literal("mcpDiscover"),
      providerId: providerIdSchema,
      scope: providerNativeScopeSchema,
      workspaceRoot: z.string().nullable(),
      serverName: z.string().min(1),
      /**
       * When true, bypass the discovery cache and re-probe / re-query native.
       */
      forceRefresh: z.boolean(),
    }),
    /** One plugin's artwork, addressed BY ID rather than by a path taken from the `plugins` row. */
    z.object({
      kind: z.literal("pluginIcon"),
      providerId: providerIdSchema,
      scope: providerNativeScopeSchema,
      workspaceRoot: z.string().nullable(),
      pluginId: z.string().min(1),
      theme: providerPluginIconThemeSchema,
    }),
  ])
  .superRefine(refineProviderNativeScope);
export type NativeListQuery = z.infer<typeof nativeListQuerySchema>;

const nativeListSuccessResultSchema = z.discriminatedUnion("kind", [
  z.object({
    ok: z.literal(true),
    kind: z.literal("mcp"),
    servers: z.array(providerMcpServerSchema),
  }),
  z.object({
    ok: z.literal(true),
    kind: z.literal("plugins"),
    plugins: z.array(providerPluginSchema),
  }),
  z.object({
    ok: z.literal(true),
    kind: z.literal("skills"),
    skills: z.array(providerSkillSchema),
  }),
  z.object({
    ok: z.literal(true),
    kind: z.literal("mcpDiscover"),
    server: providerMcpServerSchema,
  }),
  z.object({
    ok: z.literal(true),
    kind: z.literal("pluginIcon"),
    icon: providerPluginIconSchema,
  }),
]);

export const nativeListResultSchema = z.union([
  nativeListSuccessResultSchema,
  providerNativeErrorResultSchema,
]);
export type NativeListResult = z.infer<typeof nativeListResultSchema>;

/**
 * Frozen list result as of the `providers.list@7.0` cut.
 * Live {@link nativeListResultSchema} grew `origin` / `conflict` on skill rows; v7.0 must not.
 */
const nativeListSuccessResultSchemaV70Preimage = z.discriminatedUnion("kind", [
  z.object({
    ok: z.literal(true),
    kind: z.literal("mcp"),
    servers: z.array(providerMcpServerSchema),
  }),
  z.object({
    ok: z.literal(true),
    kind: z.literal("plugins"),
    plugins: z.array(providerPluginSchema),
  }),
  z.object({
    ok: z.literal(true),
    kind: z.literal("skills"),
    skills: z.array(providerSkillSchemaV70Preimage),
  }),
  z.object({
    ok: z.literal(true),
    kind: z.literal("mcpDiscover"),
    server: providerMcpServerSchema,
  }),
  z.object({
    ok: z.literal(true),
    kind: z.literal("pluginIcon"),
    icon: providerPluginIconSchema,
  }),
]);

export const nativeListResultSchemaV70Preimage = z.union([
  nativeListSuccessResultSchemaV70Preimage,
  providerNativeErrorResultSchema,
]);
export type NativeListResultV70Preimage = z.infer<
  typeof nativeListResultSchemaV70Preimage
>;

// ── Carrier payloads: mutate (providers.setEnabled@2.1) ────────────────────

/** Native mutation folded onto `providers.setEnabled@2.1` as `native`. */
export const nativeMutationSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("mcp"),
      scope: providerNativeScopeSchema,
      workspaceRoot: z.string().nullable(),
      mutation: providersMcpMutateActionSchema,
    }),
    z.object({
      kind: z.literal("plugins"),
      scope: providerNativeScopeSchema,
      workspaceRoot: z.string().nullable(),
      mutation: providersPluginsMutateActionSchema,
    }),
    z.object({
      kind: z.literal("skills"),
      scope: providerNativeScopeSchema,
      workspaceRoot: z.string().nullable(),
      mutation: providersSkillsMutateActionSchema,
    }),
  ])
  .superRefine((value, ctx) => {
    refineProviderNativeScope(value, ctx);
    if (
      value.kind === "skills" &&
      value.mutation.action === "inspect" &&
      value.mutation.scope !== value.scope
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["mutation", "scope"],
        message: "inspect scope must match the mutation scope",
      });
    }
  });
export type NativeMutation = z.infer<typeof nativeMutationSchema>;

const nativeMutationSuccessResultSchema = z.discriminatedUnion("kind", [
  z.object({
    ok: z.literal(true),
    kind: z.literal("mcp"),
    servers: z.array(providerMcpServerSchema),
  }),
  z.object({
    ok: z.literal(true),
    kind: z.literal("plugins"),
    plugins: z.array(providerPluginSchema),
  }),
  z.object({
    ok: z.literal(true),
    kind: z.literal("skills"),
    skills: z.array(providerSkillSchema),
  }),
  z.object({
    ok: z.literal(true),
    kind: z.literal("skillsInspect"),
    ...providersSkillsInspectResultSchema.shape,
  }),
]);

export const nativeMutationResultSchema = z.union([
  nativeMutationSuccessResultSchema,
  providerNativeErrorResultSchema,
]);
export type NativeMutationResult = z.infer<typeof nativeMutationResultSchema>;

// ── Carrier payloads: MCP auth (startLogin / awaitLogin / cancelLogin) ─────

/** `providers.startLogin@1.1` - Full MCP auth action set. */
export const nativeAuthActionSchema = z
  .discriminatedUnion("action", [
    z.object({
      action: z.literal("login"),
      scope: providerNativeScopeSchema,
      workspaceRoot: z.string().nullable(),
      serverName: z.string().min(1),
    }),
    z.object({
      action: z.literal("submitCode"),
      scope: providerNativeScopeSchema,
      workspaceRoot: z.string().nullable(),
      serverName: z.string().min(1),
      code: z.string().min(1),
    }),
    z.object({
      action: z.literal("logout"),
      scope: providerNativeScopeSchema,
      workspaceRoot: z.string().nullable(),
      serverName: z.string().min(1),
    }),
    z.object({
      action: z.literal("clearAuth"),
      scope: providerNativeScopeSchema,
      workspaceRoot: z.string().nullable(),
      serverName: z.string().min(1),
    }),
    z.object({
      action: z.literal("forceReauth"),
      scope: providerNativeScopeSchema,
      workspaceRoot: z.string().nullable(),
      serverName: z.string().min(1),
    }),
  ])
  .superRefine(refineProviderNativeScope);
export type NativeAuthAction = z.infer<typeof nativeAuthActionSchema>;

/**
 * Bounded status-poll context for `providers.awaitLogin@2.1` with mcpAuth.
 * Never a long poll - host pending-auth registry (R02) owns concurrency; this schema only supports repeated bounded polls returning a status.
 */
export const nativeAuthPollContextSchema = withProviderNativeScopeInvariant(
  z.object({
    scope: providerNativeScopeSchema,
    workspaceRoot: z.string().nullable(),
    serverName: z.string().min(1),
  }),
);
export type NativeAuthPollContext = z.infer<typeof nativeAuthPollContextSchema>;

/**
 * Cancel context for `providers.cancelLogin@1.1` with mcpAuth.
 */
export const nativeAuthCancelContextSchema = withProviderNativeScopeInvariant(
  z.object({
    scope: providerNativeScopeSchema,
    workspaceRoot: z.string().nullable(),
    serverName: z.string().min(1),
  }),
);
export type NativeAuthCancelContext = z.infer<
  typeof nativeAuthCancelContextSchema
>;

/**
 * Login (and forceReauth) result variants: - `authorizationUrl` - open in browser, then poll awaitLogin - `pendingInstruction` - show user-facing text (e.g. kimi log-tail path) - `pending` - auth still in flight (bounded.
 */
export const nativeAuthResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("authorizationUrl"),
    authorizationUrl: z.string(),
  }),
  z.object({
    kind: z.literal("pendingInstruction"),
    instruction: z.string(),
  }),
  z.object({
    kind: z.literal("pending"),
  }),
  z.object({
    kind: z.literal("done"),
  }),
  z.object({
    kind: z.literal("unsupported"),
    reason: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("error"),
    code: providerNativeErrorCodeSchema,
    detail: z.string().nullable(),
  }),
]);
export type NativeAuthResult = z.infer<typeof nativeAuthResultSchema>;

// ── Model providers (upstream LLM credential connect) ──────────────────────
// Everything below is a FROZEN COPY of the shape the upstream server advertises, not a re-export of the vendored SDK's generated types.

/**
 * Conditional display rule for a prompt: show it only while the answer already captured under `key` satisfies `op` against `value`.
 */
export const modelProviderPromptConditionSchema = z.object({
  key: z.string().min(1),
  op: z.enum(["eq", "neq"]),
  value: z.string(),
});
export type ModelProviderPromptCondition = z.infer<
  typeof modelProviderPromptConditionSchema
>;

/**
 * One field an auth method asks for beyond the credential itself (a region, an account id, a deployment name).
 * `placeholder` / `hint` / `when` are REQUIRED-and-nullable rather than `.optional()`, even though upstream marks them optional.
 */
export const modelProviderPromptSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    key: z.string().min(1),
    message: z.string(),
    placeholder: z.string().nullable(),
    when: modelProviderPromptConditionSchema.nullable(),
  }),
  z.object({
    type: z.literal("select"),
    key: z.string().min(1),
    message: z.string(),
    options: z.array(
      z.object({
        label: z.string(),
        value: z.string(),
        hint: z.string().nullable(),
      }),
    ),
    when: modelProviderPromptConditionSchema.nullable(),
  }),
]);
export type ModelProviderPrompt = z.infer<typeof modelProviderPromptSchema>;

/**
 * One advertised way to authenticate an upstream provider.
 * `prompts` is a required array (empty, never absent) - "this method asks for nothing extra" is a fact worth stating, and an absent key would make every consumer write the same `?? []`.
 */
export const modelProviderAuthMethodSchema = z.object({
  type: z.enum(["oauth", "api"]),
  label: z.string(),
  prompts: z.array(modelProviderPromptSchema),
});
export type ModelProviderAuthMethod = z.infer<
  typeof modelProviderAuthMethodSchema
>;

/**
 * Where the credential this provider is CURRENTLY using comes from, as the server reports it: `env` a variable in the host's environment, `config` a provider block in an OpenCode config file, `custom` a plugin/loader.
 * Renderers read `connected` for state and treat a null source as an unlabelled origin, never as an absent credential.
 */
export const modelProviderSourceSchema = z.enum([
  "env",
  "config",
  "custom",
  "api",
]);
export type ModelProviderSource = z.infer<typeof modelProviderSourceSchema>;

/**
 * One upstream provider row.
 * It is not derivable from `source`, and a renderer must not try.
 */
const modelProviderEntryBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  source: modelProviderSourceSchema.nullable(),
  hasStoredCredential: z.boolean(),
  canDisconnect: z.boolean(),
  connected: z.boolean(),
  methods: z.array(modelProviderAuthMethodSchema),
  configDeclaredCustom: z.boolean(),
  /**
   * The values this provider is DECLARED with, when it is a config-declared custom one.
   * That is the host's rule to keep; the wire simply never carries a secret back.
   */
  custom: z
    .object({
      baseUrl: z.string(),
      models: z.array(z.object({ id: z.string(), name: z.string() })),
      headers: z.array(z.object({ key: z.string(), value: z.string() })),
      env: z.array(z.string()),
    })
    .nullable(),
});

/**
 * `configDeclaredCustom` and `custom` are one fact in two fields, so the wire enforces that they agree rather than trusting every producer to.
 * A row carrying values while denying it is custom gives the client an Edit affordance the host will refuse - or worse, one it accepts, quietly converting a provider the user never declared.
 */
export const modelProviderEntrySchema =
  modelProviderEntryBaseSchema.superRefine((entry, ctx) => {
    if (entry.configDeclaredCustom && entry.custom === null) {
      ctx.addIssue({
        code: "custom",
        path: ["custom"],
        message:
          "configDeclaredCustom: true requires the declared custom values",
      });
    }
    if (!entry.configDeclaredCustom && entry.custom !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["custom"],
        message: "custom values require configDeclaredCustom: true",
      });
    }
  });
export type ModelProviderEntry = z.infer<typeof modelProviderEntrySchema>;

/**
 * Failure vocabulary for this surface.
 * Nothing here can, and a code no producer can emit is worse than a missing one: it gets handled, weighed, and never reached.
 */
export const modelProviderListErrorCodeSchema = z.enum([
  "capability_unavailable",
  "server_unavailable",
]);
export type ModelProviderListErrorCode = z.infer<
  typeof modelProviderListErrorCodeSchema
>;

/**
 * Auth failures.
 * Re-list. - `attempt_not_found` - no attempt with that id: it completed, was cancelled, or was never minted.
 */
export const modelProviderAuthErrorCodeSchema = z.enum([
  "server_unavailable",
  "provider_not_found",
  "attempt_not_found",
  "attempt_superseded",
  "attempt_expired",
  "code_rejected",
  "invalid_input",
  "provider_auth_failed",
]);
export type ModelProviderAuthErrorCode = z.infer<
  typeof modelProviderAuthErrorCodeSchema
>;

/** Same envelope shape as `providerNativeErrorResultSchema`, own vocabulary. */
export const modelProviderListErrorResultSchema = z.object({
  ok: z.literal(false),
  code: modelProviderListErrorCodeSchema,
  detail: z.string().nullable(),
});
export type ModelProviderListErrorResult = z.infer<
  typeof modelProviderListErrorResultSchema
>;

const modelProvidersListSuccessResultSchema = z.object({
  ok: z.literal(true),
  providers: z.array(modelProviderEntrySchema),
});

/** `providers.listModelProviders` payload. */
export const modelProvidersListResultSchema = z.union([
  modelProvidersListSuccessResultSchema,
  modelProviderListErrorResultSchema,
]);
export type ModelProvidersListResult = z.infer<
  typeof modelProvidersListResultSchema
>;

/** Prompt answers, keyed by each prompt's `key` - the shape upstream stores as `ApiAuth.metadata`. */
export const modelProviderAuthInputsSchema = z.record(z.string(), z.string());
export type ModelProviderAuthInputs = z.infer<
  typeof modelProviderAuthInputsSchema
>;

/** The Model Providers auth action set. */
/**
 * Config key for a NEW custom provider block.
 * Enforcing a naming rule on those makes a real provider unreachable to punish a name Traycer never chose - and unreachable by the one verb that could rename it.
 */
const newCustomProviderIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-_]*$/);

/**
 * Config key of an EXISTING provider block.
 * It owns the config file, so it is the side that knows which keys cannot survive a write; a charset list here would be a second, weaker copy of that judgement, and the weaker copy is the one that would drift.
 */
const existingCustomProviderIdSchema = z.string().min(1);

/**
 * One model in a custom provider's map: the id the API is called with, and the label the picker shows.
 * The provider-id rule above must never be reused here - it would reject roughly 2,000 real model ids.
 */
const customProviderModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

/** One literal request header written to the block's `options.headers`. */
const customProviderHeaderSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
});

/** The declarable half of a custom provider - everything the form collects about the block itself. */
const customProviderShape = {
  name: z.string().min(1),
  /** `options.baseURL`. */
  baseUrl: z.string().regex(/^https?:\/\//),
  /** The block's model map, as ordered rows. */
  models: z.array(customProviderModelSchema).min(1),
  /**
   * Literal headers for `options.headers`.
   * Defaulted rather than nullable because this field has only TWO states to express - some headers, or none - and a default gives "none" exactly one spelling.
   */
  headers: z.array(customProviderHeaderSchema).default([]),
  /**
   * The API key typed into the form, or null when the user left it blank.
   * This is the same secret `connect` carries and travels under the same rule - plaintext once, on the way in, never echoed back on a row.
   */
  key: z.string().min(1).nullable().default(null),
  /**
   * Environment variable NAMES the block's key may be read from.
   * Absent must NOT mean clear, and that is the whole reason for the shape.
   */
  env: z.array(z.string().min(1)).nullable().default(null),
};

export const modelProviderAuthActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("connect"),
    modelProviderId: z.string().min(1),
    methodIndex: z.number().int().nonnegative().nullable(),
    /** The pasted secret. Upstream's `ApiAuth.key`, not a key NAME. */
    key: z.string().min(1),
    inputs: modelProviderAuthInputsSchema,
  }),
  z.object({
    action: z.literal("startOauth"),
    modelProviderId: z.string().min(1),
    methodIndex: z.number().int().nonnegative(),
    inputs: modelProviderAuthInputsSchema,
  }),
  z.object({
    action: z.literal("submitCode"),
    modelProviderId: z.string().min(1),
    attemptId: z.string().min(1),
    code: z.string().min(1),
  }),
  z.object({
    action: z.literal("disconnect"),
    modelProviderId: z.string().min(1),
  }),
  z.object({
    action: z.literal("createCustom"),
    modelProviderId: newCustomProviderIdSchema,
    ...customProviderShape,
  }),
  z.object({
    action: z.literal("updateCustom"),
    modelProviderId: existingCustomProviderIdSchema,
    ...customProviderShape,
  }),
]);
export type ModelProviderAuthAction = z.infer<
  typeof modelProviderAuthActionSchema
>;

/**
 * Bounded status-poll context.
 * Never a long poll - the host's pending-auth registry owns concurrency and this returns whatever the attempt's state is right now, exactly like `providers.awaitMcpAuth`.
 */
export const modelProviderAuthPollContextSchema = z.object({
  modelProviderId: z.string().min(1),
  attemptId: z.string().min(1),
});
export type ModelProviderAuthPollContext = z.infer<
  typeof modelProviderAuthPollContextSchema
>;

/** Cancel context - the same addressing as the poll. */
export const modelProviderAuthCancelContextSchema = z.object({
  modelProviderId: z.string().min(1),
  attemptId: z.string().min(1),
});
export type ModelProviderAuthCancelContext = z.infer<
  typeof modelProviderAuthCancelContextSchema
>;

/**
 * Result variants, mirroring `nativeAuthResultSchema`
 * An arm nothing can emit is a promise to clients that cannot be kept.
 */
export const modelProviderAuthResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("authorizationUrl"),
    attemptId: z.string().min(1),
    authorizationUrl: z.string(),
    method: z.enum(["auto", "code"]),
    instructions: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("pending"),
  }),
  z.object({
    kind: z.literal("done"),
  }),
  z.object({
    kind: z.literal("unsupported"),
    reason: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("error"),
    code: modelProviderAuthErrorCodeSchema,
    detail: z.string().nullable(),
  }),
]);
export type ModelProviderAuthResult = z.infer<
  typeof modelProviderAuthResultSchema
>;

// ── v7.0 pre-image native payloads ─────────────────────────────────────────
// So every closed enum reachable from the descriptor is copied, and any projection down from the live descriptor must STRIP that growth rather than let a reparse hit the trap.

export const providerNativeScopeSchemaV70 = z.enum(["global", "project"]);
export type ProviderNativeScopeV70 = z.infer<
  typeof providerNativeScopeSchemaV70
>;

export const providerEnvOverrideScopeSchemaV70 = z.enum([
  "harness-and-native-config",
  "native-config-only",
]);

export const providerSettingsTabSchemaV70Preimage = z.enum([
  "general",
  "env",
  "usage",
  "mcp",
  "plugins",
  "skills",
  // `modelProviders` is NOT here.
]);
export type ProviderSettingsTabV70Preimage = z.infer<
  typeof providerSettingsTabSchemaV70Preimage
>;

export const providerMcpTransportSchemaV70 = z.enum(["stdio", "http", "sse"]);
export const providerMcpAuthTypeSchemaV70 = z.enum([
  "none",
  "header",
  "env",
  "oauth",
]);
export const providerMcpAuthActionSchemaV70 = z.enum([
  "login",
  "submitCode",
  "logout",
  "clearAuth",
  "forceReauth",
]);
export const providerMcpPerToolBackingSchemaV70 = z.enum([
  "native",
  "store",
  "degraded-server-level",
  "none",
]);
export const providerMcpDataSourceSchemaV70 = z.enum([
  "native",
  "probe",
  "none",
]);
export const providerMcpWritePathSchemaV70 = z.enum(["cli", "patch", "none"]);
export const providerMcpOauthFieldSchemaV70 = z.enum(["clientId", "resource"]);

export const providerMcpCapabilitiesSchemaV70 = z.object({
  transports: z.array(providerMcpTransportSchemaV70),
  authTypes: z.array(providerMcpAuthTypeSchemaV70),
  authActions: z.array(providerMcpAuthActionSchemaV70),
  actionScopes: z.object({
    list: z.array(providerNativeScopeSchemaV70),
    add: z.array(providerNativeScopeSchemaV70),
    update: z.array(providerNativeScopeSchemaV70),
    remove: z.array(providerNativeScopeSchemaV70),
    toggleServer: z.array(providerNativeScopeSchemaV70),
    toggleTool: z.array(providerNativeScopeSchemaV70),
    discover: z.array(providerNativeScopeSchemaV70),
    auth: z.array(providerNativeScopeSchemaV70),
  }),
  addServer: providerMcpWritePathSchemaV70,
  removeServer: providerMcpWritePathSchemaV70,
  updateServer: providerMcpWritePathSchemaV70,
  supportsMultipleHeaders: z.boolean().default(false).optional(),
  oauthFields: z.array(providerMcpOauthFieldSchemaV70).default([]).optional(),
  perToolBacking: providerMcpPerToolBackingSchemaV70,
  statusSource: providerMcpDataSourceSchemaV70,
  toolsSource: providerMcpDataSourceSchemaV70,
  schemasSource: providerMcpDataSourceSchemaV70,
  instructionsSource: z.enum(["probe", "none"]),
  traycerSessionsOnlyEnforcement: z.boolean(),
  stdioDegradeNotice: z.boolean(),
  oauthDegradesToConfigOnly: z.boolean(),
});

export const providerPluginsAddModeSchemaV70 = z.enum([
  "cli-source",
  "marketplace",
  "file-drop",
  "patch",
  "read-only",
]);

export const providerPluginsCapabilitiesSchemaV70 = z.object({
  addModes: z.array(providerPluginsAddModeSchemaV70),
  marketplaceBrowse: z.boolean(),
  actionScopes: z.object({
    list: z.array(providerNativeScopeSchemaV70),
    add: z.array(providerNativeScopeSchemaV70),
    remove: z.array(providerNativeScopeSchemaV70),
    setEnabled: z.array(providerNativeScopeSchemaV70),
  }),
  traycerSessionToolsNotice: z.boolean(),
});

export const providerSkillsCapabilitiesSchemaV70Preimage = z.object({
  actionScopes: z.object({
    list: z.array(providerNativeScopeSchemaV70),
    add: z.array(providerNativeScopeSchemaV70),
    create: z.array(providerNativeScopeSchemaV70),
    import: z.array(providerNativeScopeSchemaV70),
    remove: z.array(providerNativeScopeSchemaV70),
  }),
});
export type ProviderSkillsCapabilitiesV70Preimage = z.infer<
  typeof providerSkillsCapabilitiesSchemaV70Preimage
>;

/**
 * Frozen capability descriptor as shipped on the `providers.list@7.0` line.
 * `mcp`/`plugins`/`skills` point at the frozen copies above rather than the live trees.
 */
export const providerNativeCapabilitiesSchemaV70Preimage = z.object({
  supportedTabs: z.array(providerSettingsTabSchemaV70Preimage),
  envOverrideScope: providerEnvOverrideScopeSchemaV70.optional(),
  mcp: providerMcpCapabilitiesSchemaV70.nullable(),
  plugins: providerPluginsCapabilitiesSchemaV70.nullable(),
  skills: providerSkillsCapabilitiesSchemaV70Preimage.nullable(),
});
export type ProviderNativeCapabilitiesV70Preimage = z.infer<
  typeof providerNativeCapabilitiesSchemaV70Preimage
>;

export const DEFAULT_PROVIDER_NATIVE_CAPABILITIES_V70_PREIMAGE: ProviderNativeCapabilitiesV70Preimage =
  {
    supportedTabs: ["general", "env", "usage"],
    mcp: null,
    plugins: null,
    skills: null,
  };

// A `projectNativeCapabilitiesToV70Preimage` used to sit here, feeding the v8->v7 response bridge.
// FILTER `supportedTabs` before the parse; never reparse it.
