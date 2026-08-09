/**
 * Payload schemas for provider-native MCP / plugins / skills settings.
 * These ride released carriers (`providers.list`, `providers.setEnabled`,
 * `providers.startLogin` / `awaitLogin` / `cancelLogin`) as additive fields —
 * this module does NOT define RPC contracts.
 *
 * Content is computed host-side from the contract registry (ticket R04) — no
 * probing at `providers.list` time. Enums encode every verification-gate
 * branch so a later gate outcome does not force another protocol PR.
 */
import { z } from "zod";
import { providerIdSchema, providerIdSchemaV70 } from "./provider-ids";

// ── Scope tuple (shared by every native verb) ──────────────────────────────

/** Wire scope is `global | project` only (tech-plan Decision 5). Provider
 * cwd-local files (e.g. kimi-code `.kimi-code/mcp.json`) are host path-contract
 * details, not a third wire scope. */
export const providerNativeScopeSchema = z.enum(["global", "project"]);
export type ProviderNativeScope = z.infer<typeof providerNativeScopeSchema>;

/**
 * Base object for the scope tuple — kept unrefined so request schemas can
 * `.extend()` it. Apply {@link withProviderNativeScopeInvariant} to each
 * final request schema so the wire enforces:
 * - `scope: "project"` → non-empty `workspaceRoot`
 * - `scope: "global"` → `workspaceRoot: null`
 */
export const providerNativeScopeTupleBaseSchema = z.object({
  providerId: providerIdSchema,
  scope: providerNativeScopeSchema,
  workspaceRoot: z.string().nullable(),
});

/**
 * Shared scope/workspaceRoot invariant used by every nested native context
 * (list query, mutation, auth action/poll/cancel). Wire rule:
 * - `scope: "project"` → non-empty `workspaceRoot`
 * - `scope: "global"` → `workspaceRoot: null`
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

/**
 * Refine any object schema that includes the scope-tuple fields. Applied to
 * final object schemas (and re-used via {@link refineProviderNativeScope} on
 * discriminated unions) so every nested native context rejects invalid
 * scope/workspaceRoot combos at the wire boundary.
 */
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
  // The provider's own config could not be READ or PARSED - a malformed
  // `config.yaml`/`config.toml`/`mcp.json`, or an unreadable one.
  //
  // This is a LIST-side failure, unlike every code above it, and it exists
  // because the alternative is worse in both directions. Swallowing the
  // failure into an empty list tells the user "this provider has no MCP
  // servers", which is indistinguishable from the truth and sends them
  // looking for the wrong bug. Letting it reject instead takes down the whole
  // `providers.list` response - native results ride on that call, so one
  // malformed file would empty the entire provider catalog on every poll.
  //
  // A typed result is the only option that scopes the failure to the provider
  // it belongs to. `detail` carries a REDACTED parser message (see
  // `ConfigParseError`, which redacts at construction): parse errors quote the
  // offending source line, which is routinely a credential.
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

/**
 * Which provider operations receive Settings → Providers environment
 * overrides. Most harnesses receive them for both their chat process and
 * native configuration operations; an in-process harness can only use them
 * for the latter.
 */
export const providerEnvOverrideScopeSchema = z.enum([
  "harness-and-native-config",
  "native-config-only",
]);
export type ProviderEnvOverrideScope = z.infer<
  typeof providerEnvOverrideScopeSchema
>;

export const providerMcpTransportSchema = z.enum(["stdio", "http", "sse"]);
export type ProviderMcpTransport = z.infer<typeof providerMcpTransportSchema>;

export const providerMcpAuthTypeSchema = z.enum(["none", "header", "env", "oauth"]);
export type ProviderMcpAuthType = z.infer<typeof providerMcpAuthTypeSchema>;

/**
 * Auth actions the UI may render for this provider. Descriptor-driven so
 * config-only providers never show a fake login button.
 * - `login` / `submitCode` / `logout` / `clearAuth` — standard flows
 * - `forceReauth` — copilot-style "logout" (no clean logout; re-auth only)
 */
export const providerMcpAuthActionSchema = z.enum([
  "login",
  "submitCode",
  "logout",
  "clearAuth",
  "forceReauth",
]);
export type ProviderMcpAuthAction = z.infer<typeof providerMcpAuthActionSchema>;

/**
 * Mutation verbs the host will accept for this provider. Cursor has no
 * cli-add/remove (patch + enable/disable only); opencode has CLI add but no
 * remove; kimi is patch-only; etc.
 */
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

/**
 * How per-tool toggles are persisted.
 * - `native` — provider config fields (opencode tools map, droid lists, kiro
 *   disabledTools, copilot `tools[]` allowlist, kilocode permissions, …)
 * - `store` — Traycer-owned store + session injection (amp, codex; also
 *   grok/kimi when V1 per-tool identity is confirmed)
 * - `degraded-server-level` — V1 fallback: server enable/disable only, tools
 *   grid read-only (grok/kimi until request_permission identity is proven)
 * - `none` — no per-tool control in v1
 */
export const providerMcpPerToolBackingSchema = z.enum([
  "native",
  "store",
  "degraded-server-level",
  "none",
]);
export type ProviderMcpPerToolBacking = z.infer<
  typeof providerMcpPerToolBackingSchema
>;

/**
 * Where live server status / tool names / schemas come from.
 * - `native` — provider CLI/RPC
 * - `probe` — Traycer MCP client (no-auth / API-key servers only)
 * - `none` — capability unavailable
 */
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

/**
 * OAuth fields to capture on Add when `authTypes` includes `"oauth"`.
 * Declarative per-provider metadata — the renderer shows exactly these
 * fields and no more, replacing a renderer-side provider allowlist.
 */
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
   * True when the provider's write path genuinely serializes more than one
   * header row (installed-CLI-confirmed repeatable flag, or a config-file
   * headers map). False (default) — the renderer shows exactly one header
   * row with no "Add header" affordance, so no captured row is ever
   * silently dropped by the host.
   */
  supportsMultipleHeaders: z.boolean().default(false).optional(),
  /**
   * OAuth fields to render on Add when `authTypes` includes `"oauth"`.
   * Empty (default) — the provider has no Add-time OAuth field capture
   * (e.g. OAuth completes entirely via a separate login action).
   */
  oauthFields: z.array(providerMcpOauthFieldSchema).default([]).optional(),
  perToolBacking: providerMcpPerToolBackingSchema,
  /**
   * Status dot source. UI labels probe results as connectivity checks, never
   * as "provider CLI is logged in."
   */
  statusSource: providerMcpDataSourceSchema,
  toolsSource: providerMcpDataSourceSchema,
  /**
   * Tool input schemas. Always `probe` or `none` today (universal native
   * negative for instructions; schemas follow the same rule except droid /
   * codex / amp / opencode-family native paths).
   */
  schemasSource: providerMcpDataSourceSchema,
  /** `initialize.instructions` — probe-only for every provider. */
  instructionsSource: z.enum(["probe", "none"]),
  /**
   * True when store-backed enforcement only applies inside Traycer-launched
   * sessions (codex `-c enabled_tools`, amp SDK `enabledTools`). UI shows
   * the "Traycer sessions only" note.
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

/**
 * Plugins add modes.
 * - `cli-source` — install by source string / package ref via CLI
 * - `marketplace` — machine-readable marketplace browse + install
 * - `file-drop` — copy into plugins dir (amp)
 * - `patch` — edit config plugin array (opencode family)
 * - `read-only` — list only; no install button
 */
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
   * (text-only) — UI offers add-by-source instead of browse.
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
]);
export type ProviderSkillsCapabilityAction = z.infer<
  typeof providerSkillsCapabilityActionSchema
>;

export const providerSkillsCapabilitiesSchema = z.object({
  /**
   * Action → supported scopes table. Empty array means the action is not
   * offered for any scope.
   */
  actionScopes: z.object({
    list: z.array(providerNativeScopeSchema),
    add: z.array(providerNativeScopeSchema),
    create: z.array(providerNativeScopeSchema),
    import: z.array(providerNativeScopeSchema),
    remove: z.array(providerNativeScopeSchema),
  }),
});
export type ProviderSkillsCapabilities = z.infer<
  typeof providerSkillsCapabilitiesSchema
>;

/**
 * Actions the Model Providers tab may offer for a provider's UPSTREAM LLM
 * credentials (OpenCode's `opencode auth login` surface, rendered visually).
 *
 * - `connect` — write a credential (plain API key, or the prompted fields an
 *   advertised method asks for)
 * - `oauth` — run an advertised OAuth method (authorize → callback)
 * - `disconnect` — stop using this provider. Not "delete the API key": for a
 *   config-declared custom provider there may be no stored credential at all,
 *   and the host disables the provider in its config instead. One verb because
 *   it is one user intention; which mechanism serves it is the host's to know.
 * - `createCustom` / `updateCustom` — declare or edit an OpenAI-compatible
 *   provider block (name, base URL, model ids) in the user's OpenCode config.
 *   There is no `removeCustom`: removing one IS disconnecting it, and a second
 *   verb would have let a client remove the block while leaving the provider
 *   enabled.
 *
 * There is deliberately no `list` member and no action→scope table (the shape
 * `mcp`/`plugins`/`skills` use). Listing is what a non-null capability block
 * MEANS - a block that cannot list has nothing to render - and upstream
 * credentials are per-user, so `global`/`project` has no referent here (see
 * the plan's "Scope selector" decision). An action→scope table would have to
 * answer `["global"]` for everything, which reads as a real choice and is not.
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

/**
 * Model Providers tab facts. A non-null block means the provider can LIST its
 * upstream provider catalog; `actions` says which mutations the host will
 * accept on top of that.
 *
 * `actions` is a closed list rather than booleans so the set can grow (a
 * device-code variant, a console-account link) without another field per
 * verb - the same reason `providerMcpCapabilitiesSchema` carries
 * `authActions`. An empty array is a legal, honest state: a read-only catalog
 * (e.g. the CLI version gate allows the list endpoints but not the write
 * ones).
 */
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
   * Omitted by older hosts and ordinary contracts, which retain the existing
   * harness-and-native-config behaviour. A non-default value lets the client
   * make the Env tab honest without a provider-id special case.
   */
  envOverrideScope: providerEnvOverrideScopeSchema.optional(),
  mcp: providerMcpCapabilitiesSchema.nullable(),
  plugins: providerPluginsCapabilitiesSchema.nullable(),
  skills: providerSkillsCapabilitiesSchema.nullable(),
  /**
   * Upstream LLM credential management - see
   * `providerModelProvidersCapabilitiesSchema`. Null for every provider that
   * is not the `opencode` module.
   *
   * Required-and-nullable, exactly like its three siblings, rather than
   * `.optional()`: this field rides `providers.list@8.0` and every hop that
   * lands on the live shape fills it explicitly
   * (`upgradeNativeCapabilitiesFromV70`). Making it optional would let a
   * missing fill pass type-checking and reach the wire as an absent key, which
   * the whole-object `.catch()` on `providerCliStateSchema` then turns into a
   * silent collapse of the entire capability object - the failure mode this
   * block's own version bridge exists to prevent.
   */
  modelProviders: providerModelProvidersCapabilitiesSchema.nullable(),
});
export type ProviderNativeCapabilities = z.infer<
  typeof providerNativeCapabilitiesSchema
>;

/**
 * Default descriptor for old-host responses / `.catch()` on wire parse.
 * Empty tabs → UI shows only the pre-existing General/Env/Usage surfaces
 * that do not depend on this field.
 */
export const DEFAULT_PROVIDER_NATIVE_CAPABILITIES: ProviderNativeCapabilities = {
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
export type ProviderMcpSecretWrite = z.infer<typeof providerMcpSecretWriteSchema>;

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
    /**
     * Extra repeatable header rows beyond `name`/`value` (the first row).
     * Additive: providers that only serialize one header (most CLIs) ignore
     * it; providers with repeatable `--header` support (Qwen) consume it.
     * Defaults to `[]` so older payloads/providers parse unchanged.
     */
    additionalHeaders: z.array(providerMcpSecretWriteSchema).default([]).optional(),
  }),
  z.object({
    type: z.literal("env"),
    name: z.string().min(1),
    value: z.string(),
  }),
  z.object({
    type: z.literal("oauth"),
    /**
     * Provider-specific OAuth client identity (Codex `--oauth-client-id`).
     * Additive/optional: null when the provider has no client-id concept or
     * the user left it blank.
     */
    oauthClientId: z.string().nullable().default(null).optional(),
    /**
     * Provider-specific OAuth resource indicator (Codex `--oauth-resource`).
     */
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
 * argv on the wire — command/url identity only, secrets masked.
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

/**
 * Claude (and future multi-file) deny provenance for a tool row.
 * - `user` — ~/.claude/settings.json
 * - `shared` — <workspace>/.claude/settings.json
 * - `local` — <workspace>/.claude/settings.local.json
 * Empty when the tool is not denied. Inherited (user/shared) denies lock the
 * row so the UI does not present a no-op local enable toggle.
 */
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
   * True when the tool row is display-only (degraded-server-level backing or
   * OAuth-degraded probe), or when a deny is inherited from a non-local source
   * that a local toggle cannot clear.
   */
  readOnly: z.boolean(),
  /**
   * Sources that currently deny this tool (union). Omitted or empty when the
   * provider has no multi-source deny provenance (Claude is the first consumer).
   * Wire parse defaults missing values to [] via Zod `.default`.
   */
  denySources: z.array(providerMcpToolDenySourceSchema).default([]).optional(),
});
/**
 * Inferred type keeps `denySources` optional so host constructors that do not
 * set Claude provenance need not pass an empty array. Wire parse still
 * materializes `[]` when the field is absent.
 */
export type ProviderMcpTool = z.infer<typeof providerMcpToolSchema>;

export const providerMcpServerSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
  transport: providerMcpServerTransportReadSchema,
  status: providerMcpServerStatusSchema,
  /**
   * Which plane produced `status` — UI labels probe vs native differently.
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
   * Human-facing name from the provider's own manifest ("PDF", "Default
   * templates") where `name` is the install id ("pdf", "openai-templates").
   * Additive; renderers fall back to `name`.
   */
  displayName: z.string().nullable().default(null).optional(),
  /**
   * The provider ships artwork for this plugin AND the file is present on
   * disk. A presence flag, not the image: icons are fetched one at a time
   * through the `pluginIcon` list arm, because the rows carry megabytes of
   * PNG in aggregate and this listing is re-fetched on a 30s staleTime.
   * Renderers that see `false` skip the round trip and draw their fallback.
   */
  hasIcon: z.boolean().default(false).optional(),
  /**
   * The provider ships a SEPARATE dark-theme asset for this plugin.
   *
   * Rare (3 of 13 on a stock Codex install). It exists so renderers only vary
   * their icon request by theme where the answer actually differs: without it,
   * flipping theme would miss the cache for every row and re-fetch the whole
   * ~900 KB set to receive identical bytes.
   */
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

/**
 * One plugin's artwork, inlined as a `data:` URI.
 *
 * A data URI rather than a path or a `file://` URL because BOTH of the other
 * shapes are unreachable from the renderer: desktop CSP is
 * `img-src 'self' data: blob: https:` (no `file:`), the `app://` handler is
 * sealed to the renderer bundle, and a host-local path renders nothing at all
 * against a REMOTE host - which is a shipped, paid mode here. Bytes over the
 * existing websocket work identically for local and remote.
 */
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
});
export type ProviderSkill = z.infer<typeof providerSkillSchema>;

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

export const providersSkillsMutateActionSchema = z.discriminatedUnion(
  "action",
  [
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
      /**
       * When true, write under the provider-native root; otherwise the shared
       * `~/.agents/skills` root. Copilot CLI install is used only when
       * provider-scoped (its store is inherently provider-native).
       */
      providerScoped: z.boolean(),
    }),
    z.object({
      action: z.literal("remove"),
      name: z.string().min(1),
      path: z.string().min(1),
    }),
  ],
);
export type ProvidersSkillsMutateAction = z.infer<
  typeof providersSkillsMutateActionSchema
>;

// ── Carrier payloads: list (providers.list@3.1) ────────────────────────────

/**
 * Native list query folded onto `providers.list@3.1` as `native`.
 * Nested discriminant is fine; the top-level request stays an object.
 * Scope/workspaceRoot invariant applied via shared refinement (union arms
 * cannot individually be ZodEffects under discriminatedUnion).
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
    /**
     * One plugin's artwork, addressed BY ID rather than by a path taken from
     * the `plugins` row. The host re-resolves the file from its own walk, so
     * no client-supplied filesystem path is ever opened - the same reason
     * `assertRemovableSkill` re-lists instead of trusting the row it was
     * handed. Split off `plugins` so the megabyte-scale bytes are not re-sent
     * on that list's 30s refetch.
     */
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

// ── Carrier payloads: mutate (providers.setEnabled@2.1) ────────────────────

/**
 * Native mutation folded onto `providers.setEnabled@2.1` as `native`.
 * Runtime XOR with classic `enabled` is enforced on the request envelope.
 * Scope/workspaceRoot invariant via shared refinement.
 */
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
  .superRefine(refineProviderNativeScope);
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
]);

export const nativeMutationResultSchema = z.union([
  nativeMutationSuccessResultSchema,
  providerNativeErrorResultSchema,
]);
export type NativeMutationResult = z.infer<typeof nativeMutationResultSchema>;

// ── Carrier payloads: MCP auth (startLogin / awaitLogin / cancelLogin) ─────

/**
 * Full MCP auth action set. Rides `providers.startLogin@1.1` as `mcpAuth`.
 * Server context uses `workspaceRoot` (same scope-tuple field as list/mutate).
 * Scope/workspaceRoot invariant via shared refinement.
 */
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
 * Never a long poll — host pending-auth registry (R02) owns concurrency;
 * this schema only supports repeated bounded polls returning a status.
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
 * Login (and forceReauth) result variants:
 * - `authorizationUrl` — open in browser, then poll awaitLogin
 * - `pendingInstruction` — show user-facing text (e.g. kimi log-tail path)
 * - `pending` — auth still in flight (bounded poll status)
 * - `done` — completed synchronously (or logout/clear/submitCode success)
 * - `unsupported` — provider/server cannot perform this action
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
//
// The payloads behind the `modelProviders` tab: the visual layer of
// `opencode auth login`. These ride the four dedicated
// `providers.*ModelProvider*` methods on the optional-capability channel (see
// `provider-schemas.ts`), never a released carrier.
//
// Everything below is a FROZEN COPY of the shape the upstream server
// advertises, not a re-export of the vendored SDK's generated types. The wire
// contract has to stay put across SDK pin bumps: a regenerated type that
// renames a field or widens a union would otherwise silently redefine what
// released clients decode. The host adapts SDK → these schemas at its own
// boundary, and an SDK shape this contract cannot express is a deliberate
// protocol change, not an automatic one.

/**
 * Conditional display rule for a prompt: show it only while the answer
 * already captured under `key` satisfies `op` against `value`. Upstream
 * evaluates nothing here - the renderer does, over the answers it is
 * collecting in the same form.
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
 * One field an auth method asks for beyond the credential itself (a region, an
 * account id, a deployment name). Two kinds only - free text and a closed
 * choice - which is exactly what upstream advertises.
 *
 * `placeholder` / `hint` / `when` are REQUIRED-and-nullable rather than
 * `.optional()`, even though upstream marks them optional. These schemas are
 * brand new on a brand-new method, so there is no released peer whose omitted
 * key must keep parsing; required-nullable makes the host's adaptation total
 * (every field is answered, explicitly, with `null` for "upstream did not say")
 * instead of letting an unmapped SDK field pass as an absent key.
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
 *
 * Methods are addressed BY INDEX into an entry's `methods` array (see
 * `methodIndex` on the auth actions) because upstream gives them no id and
 * `label` is display copy that may repeat. The index is only meaningful
 * against the catalog the client is currently showing, which is why the host
 * re-reads the method set for every action rather than trusting the caller's
 * description of it.
 *
 * `prompts` is a required array (empty, never absent) - "this method asks for
 * nothing extra" is a fact worth stating, and an absent key would make every
 * consumer write the same `?? []`.
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
 * Where the credential this provider is CURRENTLY using comes from, as the
 * server reports it: `env` a variable in the host's environment, `config` a
 * provider block in an OpenCode config file, `custom` a plugin/loader, `api` a
 * credential stored in OpenCode's own auth store. Null when the provider is
 * not authenticated at all.
 *
 * Deliberately the EFFECTIVE origin rather than a stored/not-stored flag:
 * upstream exposes no way to read its auth store, so anything stronger would
 * have to be inferred. See the plan's "Credential source display" decision for
 * the consequence that was accepted (a stored key shadowed by an env var
 * reports `env` and reads as read-only).
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
 *
 * `connected` is the server's own verdict about whether this provider is
 * usable right now. It is not derivable from `source`, and a renderer must not
 * try.
 *
 * `hasStoredCredential` and `canDisconnect` are separate fields because they
 * answer different questions: "does Traycer hold a credential for this?"
 * versus "will Disconnect actually change something?" Those come apart in both
 * directions. A provider can be usable with nothing in the auth store to
 * delete - declared in a config file, or autoloaded by a plugin - and
 * disconnecting it still means something, because the host disables it in
 * config instead. And a provider whose credential lives in the environment has
 * nothing this tab can do at all: the value is not ours to remove, so no
 * affordance should be drawn.
 *
 * So a renderer gates its disconnect affordance on `canDisconnect` ALONE -
 * never on `connected`, never on `source`, and never on
 * `hasStoredCredential`. This schema fixes what each field MEANS and leaves
 * the rule that computes them to the host, which is the only side that can see
 * the auth store, the config files and the loader set. That rule has already
 * widened once during this feature; nothing here had to change with it, which
 * is the property the split is for.
 *
 * No secret ever appears here. Credentials are write-only on this surface
 * (`connect` carries plaintext once), and the read side reports presence and
 * origin only - the same convention the MCP secret write/mask pair follows.
 */
const modelProviderEntryBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  source: modelProviderSourceSchema.nullable(),
  hasStoredCredential: z.boolean(),
  canDisconnect: z.boolean(),
  connected: z.boolean(),
  methods: z.array(modelProviderAuthMethodSchema),
  /**
   * This provider is declared in the user's own OpenCode config AS an
   * OpenAI-compatible custom provider - upstream's `T(id)` predicate: a
   * `provider[id]` block whose `npm` is `@ai-sdk/openai-compatible` with a
   * non-empty model map.
   *
   * It exists to split one badge into two. `source: "config"` covers both a
   * provider the user hand-wrote as a custom endpoint and one a config file
   * merely supplies a key for; upstream shows those as "Custom" and "Config"
   * respectively, and the difference is not recoverable from `source` alone.
   *
   * It is also what tells a client the row is EDITABLE: `updateCustom` applies
   * to exactly the rows this flag is true for, because those are the ones
   * whose name / base URL / model ids Traycer wrote and can rewrite.
   *
   * The predicate is upstream's and stays host-side - a client that re-derived
   * it from a config file would be guessing at `npm` strings and model-map
   * emptiness, and would drift the first time upstream tightened either.
   */
  configDeclaredCustom: z.boolean(),
  /**
   * The values this provider is DECLARED with, when it is a config-declared
   * custom one. Non-null exactly when `configDeclaredCustom` is true - an
   * invariant this schema enforces rather than describes (see the refinement
   * below).
   *
   * Edit needs it, and needs it to be real. `updateCustom` carries the whole
   * block, so a dialog opened with nothing to prefill would submit blanks over
   * a working declaration - the user would "edit the name" and silently lose
   * their base URL and model list. Sending the current values is what makes
   * the round trip lossless.
   *
   * It also keeps the verb set closed. Re-enabling a disconnected custom
   * provider is `updateCustom` with the row's own values - no `enable` verb,
   * no `setDisabled` toggle, and nothing that could disagree with disconnect
   * about what "off" means.
   *
   * Read-side constraints are LOOSER than the write side on purpose. A user
   * can hand-edit `opencode.json`, so a declared base URL may be malformed and
   * a model list may be junk; `createCustom`/`updateCustom` reject those, but
   * refusing to REPORT them would fail the row's parse and vanish the one
   * provider whose declaration needs fixing - with Edit, the only surface that
   * could fix it, gone with it. Validate what we accept; report what we find.
   */
  custom: z
    .object({
      baseUrl: z.string(),
      modelIds: z.array(z.string()),
    })
    .nullable(),
});

/**
 * `configDeclaredCustom` and `custom` are one fact in two fields, so the wire
 * enforces that they agree rather than trusting every producer to.
 *
 * Both halves matter and they fail differently. A row claiming custom with no
 * values gives Edit nothing to prefill, which is the blank-overwrite this
 * field exists to prevent. A row carrying values while denying it is custom
 * gives the client an Edit affordance the host will refuse - or worse, one it
 * accepts, quietly converting a provider the user never declared.
 *
 * Refined, not merely tested, on the same reasoning as
 * `refineProviderNativeScope` above: a state nothing downstream can act on
 * should be unrepresentable, not just unasserted.
 */
export const modelProviderEntrySchema = modelProviderEntryBaseSchema.superRefine(
  (entry, ctx) => {
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
  },
);
export type ModelProviderEntry = z.infer<typeof modelProviderEntrySchema>;

/**
 * Failure vocabulary for this surface. Deliberately its OWN enums rather than
 * `providerNativeErrorCodeSchema`.
 *
 * That enum describes editing provider CONFIG FILES - `duplicate_name`,
 * `external_drift`, `rollback_failed`, `no_change_detected`. None of it
 * describes an OAuth attempt, and this surface's settled semantics (attempts
 * are single-flight per `(providerId, modelProviderId)`, a new attempt
 * supersedes the pending one, stale attempt ids are discarded, attempts expire
 * server-side) have no member there at all. Reusing it would force the host to
 * report "your attempt was superseded" as `external_drift` - a code whose
 * meaning is already spoken for, in a union released clients decode. Widening
 * the shared enum was the other option and is not available: it rides released
 * carriers, so a new member is a value already-shipped peers reject.
 *
 * Split in TWO, per context, because most of the vocabulary is impossible in
 * one of them. Listing the catalog has no attempt to supersede and no code to
 * reject; the auth methods report the gated-off case through their
 * `unsupported` RESULT ARM, so a `capability_unavailable` CODE there would be
 * a second spelling of the same fact. A single wide enum would type-check both
 * mistakes and leave the impossibility to a comment.
 *
 * Listing failures - both are about REACHING the catalog, never about a
 * credential:
 * - `capability_unavailable` — the surface is not offered here (not the
 *   `opencode` module, or the CLI is below the version gate). Nothing to
 *   retry. This is the list result's counterpart of the auth methods'
 *   `unsupported` arm.
 * - `server_unavailable` — the managed server could not be started or leased.
 */
export const modelProviderListErrorCodeSchema = z.enum([
  "capability_unavailable",
  "server_unavailable",
]);
export type ModelProviderListErrorCode = z.infer<
  typeof modelProviderListErrorCodeSchema
>;

/**
 * Auth failures. Each member exists because a client does something DIFFERENT
 * about it - that is the test for whether a code earns its place here:
 * - `server_unavailable` — managed server could not be started or leased.
 *   Nothing is wrong with the credential; retry later.
 * - `provider_not_found` — the named upstream provider is not in the catalog
 *   (stale client-side list). Re-list.
 * - `attempt_not_found` — no attempt with that id: it completed, was
 *   cancelled, or was never minted. Start a fresh flow.
 * - `attempt_superseded` — a newer attempt for the same pair replaced this
 *   one. Do NOT restart: drop this attempt's UI, the newer one owns the
 *   surface.
 * - `attempt_expired` — the attempt timed out in the pending-auth registry.
 *   Start a fresh flow.
 * - `code_rejected` — the pasted code was refused, and the attempt is STILL
 *   LIVE. Re-prompt for a code; restarting would throw away a usable attempt.
 * - `invalid_input` — the submitted prompt answers failed the provider's own
 *   validation. Re-show the form with the detail.
 * - `provider_auth_failed` — the provider refused the credential, or the OAuth
 *   callback failed. Show the detail; retrying is the user's call.
 *
 * No `capability_unavailable`: the auth result carries an `unsupported` arm
 * for exactly that condition, and two ways to say one thing is how consumers
 * end up handling only one of them.
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

/**
 * `providers.listModelProviders` payload. Success or a typed error, the same
 * union shape `nativeListResultSchema` uses - a capability that is gated off,
 * or a managed server that would not start, is a result rather than a
 * transport failure.
 */
export const modelProvidersListResultSchema = z.union([
  modelProvidersListSuccessResultSchema,
  modelProviderListErrorResultSchema,
]);
export type ModelProvidersListResult = z.infer<
  typeof modelProvidersListResultSchema
>;

/**
 * Prompt answers, keyed by each prompt's `key` - the shape upstream stores as
 * `ApiAuth.metadata`. A map rather than a list of `{key, value}` pairs because
 * a prompt key answered twice is not a state anything downstream can act on,
 * and a map makes it unrepresentable instead of merely wrong.
 *
 * Values are plaintext and travel exactly once, on the way in: nothing reads
 * them back (see `modelProviderEntrySchema`).
 */
export const modelProviderAuthInputsSchema = z.record(z.string(), z.string());
export type ModelProviderAuthInputs = z.infer<
  typeof modelProviderAuthInputsSchema
>;

/**
 * The Model Providers auth action set.
 *
 * `modelProviderId` is the UPSTREAM provider (`anthropic`, `openai`, …); the
 * Traycer provider whose settings tab is open rides the request envelope as
 * `providerId`. Two different namespaces that would be very easy to collapse
 * into one field and impossible to separate afterwards.
 *
 * `connect` carries the credential itself and nothing that names it. `key` is
 * the SECRET VALUE the user pasted - it lands in upstream's `ApiAuth.key` - and
 * `inputs` are the answers to that method's prompts, which land in
 * `ApiAuth.metadata`. The name is upstream's and it reads like an identifier,
 * which it is not; nothing on this wire identifies a credential by name.
 *
 * An earlier shape carried the models.dev `env[]` member the value should be
 * stored under, because the host validated the submitted key against that
 * array. Upstream does no such thing: when `/provider/auth` offers no methods
 * it SYNTHESIZES a generic API-key method and submits the value alone. The
 * name was validated and then discarded, so it is gone from the wire entirely
 * - and a plain-key connect is now legal for every provider rather than only
 * those whose env member the host could resolve.
 *
 * `methodIndex: null` therefore means "the client chose no advertised method",
 * which the host serves with that same synthesized generic method. A host that
 * surfaces the synthesized method in `methods[]` is addressed by index like
 * any other - one rule, not a special case. `startOauth` requires an index
 * because an OAuth flow only ever exists as an advertised method.
 *
 * `createCustom` / `updateCustom` declare and edit an OpenAI-compatible
 * provider block in the user's config. There is deliberately no `removeCustom`
 * arm: removing a custom provider IS disconnecting it (upstream's disconnect
 * for a config-declared custom disables the block rather than deleting a
 * credential it may not have), and a separate verb would have let a client
 * delete the declaration while leaving the provider enabled - two ways to
 * reach one state, one of which nothing would clean up.
 *
 * `submitCode` carries `attemptId` rather than re-identifying the flow by
 * provider: attempts are single-flight per `(providerId, modelProviderId)` and
 * a new one SUPERSEDES the pending one, so a code arriving for a superseded
 * attempt has to be discardable. Without the id it would be applied to
 * whatever attempt happens to be pending.
 */
/**
 * The declarable half of a custom provider. Shared by `createCustom` and
 * `updateCustom` because the two differ only in whether the block already
 * exists - upstream's own dialog is the same form either way, and letting the
 * shapes drift would be a bug the type system could not see.
 *
 * `npm` is NOT here. Every provider this surface can declare is an
 * OpenAI-compatible endpoint (`@ai-sdk/openai-compatible`), the host writes
 * that constant, and putting it on the wire would offer a choice the rest of
 * the feature cannot honour - upstream's `T(id)` only recognizes that one
 * value, so any other would produce a block this tab could never edit again.
 */
const customProviderShape = {
  /** Config key for the block, and the id every other action addresses it by. */
  modelProviderId: z.string().min(1),
  /** Display name. Upstream's `provider[id].name`. */
  name: z.string().min(1),
  /**
   * `options.baseURL`. Parsed as a URL at the boundary rather than left to the
   * host: a scheme-less host is the paste people actually make, it is
   * objectively wrong, and catching it here turns a provider that silently
   * never works into a form error next to the field.
   */
  baseUrl: z.url(),
  /**
   * Model ids for the block's model map. NON-EMPTY, and that is upstream's
   * constraint rather than tidiness: `T(id)` requires a non-empty model map,
   * so a custom provider declared with none would not be recognized as custom
   * by the very predicate that decides whether this row is editable - it would
   * be created and then immediately unreachable.
   *
   * Order is the user's. Duplicates are the host's to collapse, since it owns
   * the map this becomes.
   */
  modelIds: z.array(z.string().min(1)).min(1),
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
    ...customProviderShape,
  }),
  z.object({
    action: z.literal("updateCustom"),
    ...customProviderShape,
  }),
]);
export type ModelProviderAuthAction = z.infer<
  typeof modelProviderAuthActionSchema
>;

/**
 * Bounded status-poll context. Never a long poll - the host's pending-auth
 * registry owns concurrency and this returns whatever the attempt's state is
 * right now, exactly like `providers.awaitMcpAuth`.
 *
 * The `attemptId` is what makes a stale poll answerable: a caller holding the
 * id of a superseded attempt is told so (`error`), rather than being handed
 * the live attempt's status under the impression it is its own.
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
 * Result variants, mirroring `nativeAuthResultSchema`:
 *
 * - `authorizationUrl` — an OAuth attempt is live. Carries the host-minted
 *   `attemptId` every later call in the flow is addressed by, the url to open,
 *   and `method`: `auto` completes on the server's own loopback (poll until
 *   done), `code` needs the user to paste what the provider shows
 *   (`submitCode`). `instructions` is the provider's own wording for that
 *   step, shown verbatim rather than paraphrased - it is the only honest copy
 *   for a flow Traycer does not otherwise understand.
 * - `pending` — bounded-poll status: the attempt is still in flight.
 * - `done` — the credential is written (connect / successful OAuth /
 *   disconnect).
 * - `unsupported` — the action is not available (capability gated off, CLI
 *   below the version gate, the provider advertises no such method). Never
 *   faked into a `done`.
 * - `error` — a typed failure from `modelProviderAuthErrorCodeSchema`, this
 *   surface's OWN vocabulary. The shared native error enum cannot express an
 *   attempt lifecycle at all - see that schema's comment - and the settled
 *   attempt semantics (supersede, expiry, stale ids) are exactly what a poll
 *   or a late `submitCode` has to report. `capability_unavailable` is NOT a
 *   member: that condition is the `unsupported` arm above.
 *
 * `nativeAuthResultSchema`'s `pendingInstruction` arm has no counterpart:
 * upstream carries its instruction text ON the authorization response, so a
 * separate instruction-only arm would never be produced. An arm nothing can
 * emit is a promise to clients that cannot be kept.
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

// ── Frozen v7.0 native payloads ────────────────────────────────────────────
//
// Everything `providers.list@7.0` carries in its `native` request/response and
// its `nativeCapabilities` descriptor, hand-copied as that line stood when
// v8.0 opened. `provider-schemas.ts` wires the v7.0 request/response and the
// v7.0 state to THESE and nothing above them.
//
// WHEN this line was frozen matters, because v7.0 is NOT yet released - no
// non-RC `host-v*`/`cli-v*`/`desktop-v*` tag carries a major-7 contract. The
// cut point is the v8.0 integration, not a release, and it is early on
// purpose: v5.0 and v6.0 were each still pointing at the live schemas on the
// day a release shipped them, and both grew a released line before anyone
// noticed. Freezing at the integration cut costs nothing and removes that
// window.
//
// Two consequences follow, and they pull in opposite directions:
//
//  - Until the first non-RC release ships 7.0, there is no peer in the field
//    decoding these shapes, so a genuine v7.0-line addition on `main` may be
//    mirrored here rather than projected away. `config_unreadable` is the
//    worked example - see `providerNativeErrorCodeSchemaV70`.
//  - From that release onward, the rule hardens: an addition to a live
//    counterpart must NOT be mirrored here, and the v8→v7 projection has to
//    say explicitly what a v7.0 peer sees instead.
//
// Either way the copies stay hand-written. Naming a schema `...V70` while it
// still points into the live tree is not a freeze - it is a freeze-shaped
// alias. Every closed enum and every discriminated union reachable from the
// v7.0 wire is copied below, because those are the shapes whose growth is
// FATAL rather than additive to a peer that decodes them: one unknown member
// fails its array, then its object, and (for `nativeCapabilities`) hits the
// whole-object `.catch()` that serves the empty default. Object fields added
// to the live tree would merely be dropped by these plain `z.object` parses;
// enum and union members would not.
//
// The frozen-catalog snapshot is an alarm, not this boundary. It can be
// regenerated by anyone; these schemas cannot be widened without editing a
// file whose every comment says not to - and the live-vs-frozen equality guard
// in `provider-model-providers-compat.test.ts` is what forces the choice above
// to be made deliberately, whichever side of the release it falls on.

export const providerNativeScopeSchemaV70 = z.enum(["global", "project"]);
export type ProviderNativeScopeV70 = z.infer<
  typeof providerNativeScopeSchemaV70
>;

/**
 * `config_unreadable` IS on this frozen copy, and the reason is worth writing
 * down because the equality tripwire above fired to force the decision.
 *
 * It was added to the live enum on `main` (PR #1050) after this branch cut,
 * and the reflex answer - "the frozen copy predates it, so project it away on
 * the v8→v7 bridge" - would have been wrong. No released tag ships
 * `providers.list@7.0` at all: `host-v1.1.11` and every earlier
 * `host-v*`/`cli-v*`/`desktop-v*` top out below it. v7.0 is UNRELEASED, so
 * #1050 grew it legitimately, exactly as `providerManagedInstallStateSchema`
 * grew v6.0 while no release shipped it, and exactly as
 * `providersSetEnabledRequestSchemaV21` widens an unreleased minor in place.
 *
 * Versions exist to protect peers in the field. There is no peer that
 * negotiated v7.0 and cannot decode `config_unreadable` - the release that
 * first ships v7.0 will ship it too. Projecting it away would mint a bridge
 * protecting nobody, and would leave this snapshot describing a v7.0 that
 * never existed.
 *
 * The freeze still stands: v7.0 is pinned as of the moment v8.0 opened, and
 * that moment now includes #1050. What does NOT follow is that later growth is
 * free - once a NON-RC release ships a major-7 contract, this line has peers
 * in the field and an addition to the live enum must be projected on the v8→v7
 * bridge instead of mirrored here. Same activation point the section header
 * above describes.
 */
export const providerNativeErrorCodeSchemaV70 = z.enum([
  "duplicate_name",
  "unsupported_scope",
  "unsupported_action",
  "no_change_detected",
  "external_drift",
  "store_version_unsupported",
  "rollback_failed",
  "config_unreadable",
]);
export type ProviderNativeErrorCodeV70 = z.infer<
  typeof providerNativeErrorCodeSchemaV70
>;

export const providerNativeErrorResultSchemaV70 = z.object({
  ok: z.literal(false),
  code: providerNativeErrorCodeSchemaV70,
  detail: z.string().nullable(),
});

export const providerEnvOverrideScopeSchemaV70 = z.enum([
  "harness-and-native-config",
  "native-config-only",
]);

export const providerSettingsTabSchemaV70 = z.enum([
  "general",
  "env",
  "usage",
  "mcp",
  "plugins",
  "skills",
]);
export type ProviderSettingsTabV70 = z.infer<
  typeof providerSettingsTabSchemaV70
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

export const providerSkillsCapabilitiesSchemaV70 = z.object({
  actionScopes: z.object({
    list: z.array(providerNativeScopeSchemaV70),
    add: z.array(providerNativeScopeSchemaV70),
    create: z.array(providerNativeScopeSchemaV70),
    import: z.array(providerNativeScopeSchemaV70),
    remove: z.array(providerNativeScopeSchemaV70),
  }),
});

export const providerMcpSecretMaskSchemaV70 = z.object({
  name: z.string().min(1),
  hasValue: z.boolean(),
});

export const providerMcpAuthReadSchemaV70 = z.discriminatedUnion("type", [
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

export const providerMcpServerTransportReadSchemaV70 = z.discriminatedUnion(
  "type",
  [
    z.object({
      type: z.literal("stdio"),
      command: z.string(),
      env: z.array(providerMcpSecretMaskSchemaV70).nullable(),
    }),
    z.object({
      type: z.literal("http"),
      url: z.string(),
      auth: providerMcpAuthReadSchemaV70.nullable(),
    }),
    z.object({
      type: z.literal("sse"),
      url: z.string(),
      auth: providerMcpAuthReadSchemaV70.nullable(),
    }),
  ],
);

export const providerMcpServerStatusSchemaV70 = z.enum([
  "connected",
  "disconnected",
  "connecting",
  "needs_auth",
  "error",
  "unknown",
  "config_only",
]);

export const providerMcpToolDenySourceSchemaV70 = z.enum([
  "user",
  "shared",
  "local",
]);

export const providerMcpToolSchemaV70 = z.object({
  name: z.string(),
  description: z.string().nullable(),
  inputSchema: z.record(z.string(), z.unknown()).nullable(),
  enabled: z.boolean(),
  readOnly: z.boolean(),
  denySources: z
    .array(providerMcpToolDenySourceSchemaV70)
    .default([])
    .optional(),
});

export const providerMcpServerSchemaV70 = z.object({
  name: z.string(),
  enabled: z.boolean(),
  transport: providerMcpServerTransportReadSchemaV70,
  status: providerMcpServerStatusSchemaV70,
  statusSource: providerMcpDataSourceSchemaV70,
  statusDetail: z.string().nullable(),
  tools: z.array(providerMcpToolSchemaV70),
  discoveryPending: z.boolean(),
  instructions: z.string().nullable(),
  configOnly: z.boolean(),
  stdioDegraded: z.boolean(),
});

export const providerPluginSchemaV70 = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string().nullable(),
  enabled: z.boolean(),
  source: z.string().nullable(),
  readOnly: z.boolean(),
  description: z.string().nullable().default(null).optional(),
  displayName: z.string().nullable().default(null).optional(),
  hasIcon: z.boolean().default(false).optional(),
  hasDarkIcon: z.boolean().default(false).optional(),
});

export const providerPluginIconThemeSchemaV70 = z.enum(["light", "dark"]);

export const providerPluginIconSchemaV70 = z.object({
  dataUri: z.string().nullable(),
  error: z.string().nullable(),
});

export const providerSkillSourceBadgeSchemaV70 = z.enum([
  "shared",
  "provider",
  "plugin",
  "managed",
]);

export const providerSkillSchemaV70 = z.object({
  name: z.string(),
  description: z.string().nullable(),
  path: z.string(),
  source: providerSkillSourceBadgeSchemaV70,
});

/**
 * The `native` query as `providers.list@7.0` accepts it. A discriminated union
 * on `kind`, so a v8.0 caller inventing a sixth arm is a value a v7.0 host
 * rejects outright - which is why the v8→v7 request bridge parses through this
 * rather than passing the live value along.
 */
export const nativeListQuerySchemaV70 = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("mcp"),
      providerId: providerIdSchemaV70,
      scope: providerNativeScopeSchemaV70,
      workspaceRoot: z.string().nullable(),
    }),
    z.object({
      kind: z.literal("plugins"),
      providerId: providerIdSchemaV70,
      scope: providerNativeScopeSchemaV70,
      workspaceRoot: z.string().nullable(),
    }),
    z.object({
      kind: z.literal("skills"),
      providerId: providerIdSchemaV70,
      scope: providerNativeScopeSchemaV70,
      workspaceRoot: z.string().nullable(),
    }),
    z.object({
      kind: z.literal("mcpDiscover"),
      providerId: providerIdSchemaV70,
      scope: providerNativeScopeSchemaV70,
      workspaceRoot: z.string().nullable(),
      serverName: z.string().min(1),
      forceRefresh: z.boolean(),
    }),
    z.object({
      kind: z.literal("pluginIcon"),
      providerId: providerIdSchemaV70,
      scope: providerNativeScopeSchemaV70,
      workspaceRoot: z.string().nullable(),
      pluginId: z.string().min(1),
      theme: providerPluginIconThemeSchemaV70,
    }),
  ])
  .superRefine(refineProviderNativeScope);
export type NativeListQueryV70 = z.infer<typeof nativeListQuerySchemaV70>;

const nativeListSuccessResultSchemaV70 = z.discriminatedUnion("kind", [
  z.object({
    ok: z.literal(true),
    kind: z.literal("mcp"),
    servers: z.array(providerMcpServerSchemaV70),
  }),
  z.object({
    ok: z.literal(true),
    kind: z.literal("plugins"),
    plugins: z.array(providerPluginSchemaV70),
  }),
  z.object({
    ok: z.literal(true),
    kind: z.literal("skills"),
    skills: z.array(providerSkillSchemaV70),
  }),
  z.object({
    ok: z.literal(true),
    kind: z.literal("mcpDiscover"),
    server: providerMcpServerSchemaV70,
  }),
  z.object({
    ok: z.literal(true),
    kind: z.literal("pluginIcon"),
    icon: providerPluginIconSchemaV70,
  }),
]);

export const nativeListResultSchemaV70 = z.union([
  nativeListSuccessResultSchemaV70,
  providerNativeErrorResultSchemaV70,
]);
export type NativeListResultV70 = z.infer<typeof nativeListResultSchemaV70>;

/**
 * Frozen capability descriptor as shipped on the `providers.list@7.0` line.
 *
 * A hand-copy, NOT `.omit()` on the live schema - the same discipline
 * `providerLoginCapabilitySchemaV40` documents, and for the same reason: a
 * field added to the live capability object must not appear on an already-
 * negotiated line just because the frozen schema was derived from it.
 *
 * `mcp`/`plugins`/`skills` point at the frozen copies above rather than the
 * live trees. Pointing them at the live trees would have pinned the OUTER
 * object while leaving every enum inside it free to grow - and this descriptor
 * is the one place where growth is not merely leaked but fatal, because
 * `providerCliStateSchemaV70` reads the whole thing through one `.catch()`.
 */
export const providerNativeCapabilitiesSchemaV70 = z.object({
  supportedTabs: z.array(providerSettingsTabSchemaV70),
  envOverrideScope: providerEnvOverrideScopeSchemaV70.optional(),
  mcp: providerMcpCapabilitiesSchemaV70.nullable(),
  plugins: providerPluginsCapabilitiesSchemaV70.nullable(),
  skills: providerSkillsCapabilitiesSchemaV70.nullable(),
});
export type ProviderNativeCapabilitiesV70 = z.infer<
  typeof providerNativeCapabilitiesSchemaV70
>;

/**
 * The v7.0-shaped counterpart of {@link DEFAULT_PROVIDER_NATIVE_CAPABILITIES},
 * used by the frozen v7.0 state's own `.catch()` so that line keeps decoding
 * exactly as it does today.
 */
export const DEFAULT_PROVIDER_NATIVE_CAPABILITIES_V70: ProviderNativeCapabilitiesV70 =
  {
    supportedTabs: ["general", "env", "usage"],
    mcp: null,
    plugins: null,
    skills: null,
  };

/**
 * The v7.0-shaped input both projections parse. Shared so the strict and
 * degrading forms below cannot drift into disagreeing about what the cut IS.
 *
 * Two cuts, and they are made in different ways on purpose:
 *
 * 1. `modelProviders` is dropped. A plain (non-strict) reparse would do this
 *    on its own, but the drop is written out so the projection reads as the
 *    contract it is.
 * 2. `supportedTabs` is FILTERED before the parse. This is the cut a reparse
 *    cannot make: `z.array(enum)` rejects the whole array on one unknown
 *    member, the object parse fails with it, and `providerCliStateSchemaV70`'s
 *    whole-object `.catch()` then serves the empty default - so a v7.0 client
 *    would lose MCP, Plugins AND Skills for that provider, not just the tab it
 *    never knew about.
 *
 * Everything else is parsed through the frozen tree unchanged. `supportedTabs`
 * is the one field known to grow and its projection is written down; a member
 * added to any other frozen enum has no agreed answer for a v7.0 caller, and
 * inventing one here - dropping it, or collapsing to the default - would ship
 * that guess silently. So neither form below invents one: the strict form
 * throws, the degrading form returns null, and the decision is routed to
 * whoever grew the enum by a red test rather than a field incident.
 */
/**
 * One tab's projection onto v7.0: itself, or `null` when v7.0 has no such tab.
 *
 * An exhaustive switch, deliberately, rather than the filter this replaces.
 * That filter narrowed with `(tab): tab is ProviderSettingsTabV70 => tab !==
 * "modelProviders"` - an ASSERTING predicate whose body only happened to be
 * true. Add a second live-only tab and it keeps compiling while quietly
 * promising v7.0 a tab id it cannot decode, which is the whole failure this
 * transition exists to prevent, reintroduced by the projection itself.
 *
 * A switch over the live union has no such slack: a new member fails to
 * compile until someone writes down which side of the cut it falls on. The
 * frozen enum is not consulted here, so the two could in principle disagree -
 * `provider-model-providers-compat.test.ts` pins them against each other.
 */
function projectTabToV70(
  tab: ProviderSettingsTab,
): ProviderSettingsTabV70 | null {
  switch (tab) {
    case "general":
    case "env":
    case "usage":
    case "mcp":
    case "plugins":
    case "skills":
      return tab;
    case "modelProviders":
      return null;
  }
}

function v70CapabilityInput(capabilities: ProviderNativeCapabilities): unknown {
  const { modelProviders: _modelProviders, ...rest } = capabilities;
  return {
    ...rest,
    supportedTabs: capabilities.supportedTabs.flatMap((tab) => {
      const projected = projectTabToV70(tab);
      return projected === null ? [] : [projected];
    }),
  };
}

/**
 * Strict projection: throws when the descriptor cannot be represented on v7.0.
 *
 * The loud form, for callers that have no row to degrade and would rather stop
 * than guess. The `providers.list` bridge does NOT use it - see
 * {@link tryProjectProviderNativeCapabilitiesToV70} for why, and for which
 * contract wins at runtime.
 */
export function projectProviderNativeCapabilitiesToV70(
  capabilities: ProviderNativeCapabilities,
): ProviderNativeCapabilitiesV70 {
  return providerNativeCapabilitiesSchemaV70.parse(
    v70CapabilityInput(capabilities),
  );
}

/**
 * Degrading projection: `null` when the descriptor cannot be represented on
 * v7.0, so a caller that owns a per-ROW contract can honour it.
 *
 * This is what `downgradeProviderCliStateToV70` uses, and the split exists
 * because the two concerns were quietly in conflict: the projection was
 * written to fail closed, and the bridge that calls it documents a
 * `| null`-per-row contract. Calling the strict form inside the row's
 * `safeParse` argument list let the throw escape PAST that contract, so one
 * unrepresentable provider took down the entire `providers.list` response for
 * that peer - every other provider with it.
 *
 * At runtime the row contract wins. Losing one provider row is a bounded,
 * visible failure; losing the whole catalog turns a settings page into an
 * error for a defect in a single entry.
 *
 * Failing closed is NOT abandoned - it moves to build time, where it belongs.
 * `provider-model-providers-compat.test.ts` pins live-vs-frozen agreement for
 * every frozen subtree, so a live enum that grows without a projection
 * decision goes red in CI (it already has, once, for `config_unreadable`).
 * That is the loudness mechanism; a production throw was never going to reach
 * the person who grew the enum.
 */
export function tryProjectProviderNativeCapabilitiesToV70(
  capabilities: ProviderNativeCapabilities,
): ProviderNativeCapabilitiesV70 | null {
  const parsed = providerNativeCapabilitiesSchemaV70.safeParse(
    v70CapabilityInput(capabilities),
  );
  return parsed.success ? parsed.data : null;
}

/**
 * Lift a frozen v7.0 capability descriptor onto the live shape. A v7.0 host
 * predates the Model Providers surface entirely, so `null` ("this provider
 * cannot manage upstream credentials") is the honest projection - the same
 * "old host never had this feature" reading as the `profiles: []` fill on the
 * v3→v4 hop.
 *
 * Spelled out here rather than left to a live reparse because
 * `upgradeResponseToVersion` chains bridge callbacks by cast, with no parse
 * step in between: an unfilled key stays absent all the way to the consumer.
 */
export function upgradeNativeCapabilitiesFromV70(
  capabilities: ProviderNativeCapabilitiesV70,
): ProviderNativeCapabilities {
  return { ...capabilities, modelProviders: null };
}
