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
import { providerIdSchema } from "./provider-ids";

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
]);
export type ProviderSettingsTab = z.infer<typeof providerSettingsTabSchema>;

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
 * Per-capability facts the UI renders tabs/modals from. Null domain objects
 * mean the tab is unsupported (also reflected in `supportedTabs`).
 */
export const providerNativeCapabilitiesSchema = z.object({
  supportedTabs: z.array(providerSettingsTabSchema),
  mcp: providerMcpCapabilitiesSchema.nullable(),
  plugins: providerPluginsCapabilitiesSchema.nullable(),
  skills: providerSkillsCapabilitiesSchema.nullable(),
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
});
export type ProviderPlugin = z.infer<typeof providerPluginSchema>;

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
