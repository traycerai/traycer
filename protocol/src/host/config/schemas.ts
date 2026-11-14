import { z } from "zod";
import { LOG_LEVELS } from "@traycer/protocol/config/log-level";
import { AGENT_WORKTREE_CREATE_POLICIES } from "@traycer/protocol/config/schema";
import { SESSION_NAME_TEMPLATE_MAX_LENGTH } from "@traycer/protocol/config/session-name-template";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { executableWriteGrantSchema } from "@traycer/protocol/host/executable-write-grant";

/**
 * RPC payloads for the machine-user-global CLI config store.
 *
 * The store lives at `~/.traycer/cli/config.json`, outside a host slot. Shell,
 * environment, and CLI/host log-level changes therefore apply to every Traycer
 * host environment run by this OS user. Writes are intentionally last-writer-
 * wins and use the store's atomic-write path; these contracts add no per-host
 * state or locking layer.
 */

const emptyRequestSchema = lazySchema(() => z.object({}));
const shellArgsSchema = lazySchema(() => z.array(z.string()).nullable());
const shellPathSchema = lazySchema(() => z.string().min(1));
const envKeySchema = lazySchema(() =>
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
);

export const configShellGetRequestSchema = emptyRequestSchema;
export type ConfigShellGetRequest = z.infer<typeof configShellGetRequestSchema>;

export const configShellGetResponseSchema = lazySchema(() =>
  z.object({
    path: shellPathSchema,
    args: z.array(z.string()),
    synthesised: z.boolean(),
  }),
);
export type ConfigShellGetResponse = z.infer<
  typeof configShellGetResponseSchema
>;

/**
 * v1.1 adds `entries`: the shells this computer has configured, each with the
 * arguments it remembers for it. `args: null` means none are remembered and
 * the default applies, so an app states a shell save's selection with one
 * rule: the remembered arguments when present, otherwise
 * `defaultShellArgs(path)` (`@traycer/protocol/config/shell-family`).
 */
export const configShellGetResponseSchemaV11 = lazySchema(() =>
  configShellGetResponseSchema.extend({
    entries: z.array(configShellEntrySchema),
  }),
);
export type ConfigShellGetResponseV11 = z.infer<
  typeof configShellGetResponseSchemaV11
>;

/**
 * What the app states the `shell` item will be once a shell save is made, so
 * it can remember its edit and recognise its hold among the environment's
 * held changes (`settingsSaveItemEdit`):
 * - `shell`: this path with these arguments is selected;
 * - `system_default`: no shell is selected, and the item is deleted;
 * - `not_stated`: the caller predates this field (the upgrade from 1.1 fills
 *   it); the app expects no proposal.
 *
 * The host never writes it over what it computes from its own config. That
 * computation is the truth and is what the host proposes; when the two
 * differ, the app's remembered value matches no hold and the change waits in
 * the review list. No error is raised for it.
 */
export const configShellSelectionSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("shell"),
      path: shellPathSchema,
      args: z.array(z.string()),
    }),
    z.object({ kind: z.literal("system_default") }),
    z.object({ kind: z.literal("not_stated") }),
  ]),
);
export type ConfigShellSelection = z.infer<typeof configShellSelectionSchema>;

// A shell-set operation must change either the selected program or its args;
// accepting `{ path: null, args: null }` would turn an RPC typo into a silent
// config-file rewrite instead of matching the CLI command's validation.
//
// The v1.0 request, FROZEN as released (`host-v1.5.1`). v1.1 below adds the
// executable-write grant; a hand copy, so the next field cannot reach it.
export const configShellSetRequestSchemaV10 = lazySchema(() =>
  z.union([
    z.object({ path: shellPathSchema, args: shellArgsSchema }),
    z.object({ path: z.null(), args: z.array(z.string()) }),
  ]),
);

/**
 * v1.1: the shell path and args select what starts, so the write reaches an
 * execution sink and carries the executable-write grant. Each arm
 * carries it; a v1.0 caller's request is upgraded with `null`.
 */
export const configShellSetRequestSchema = lazySchema(() =>
  z.union([
    z.object({
      path: shellPathSchema,
      args: shellArgsSchema,
      executableWriteGrant: executableWriteGrantSchema,
    }),
    z.object({
      path: z.null(),
      args: z.array(z.string()),
      executableWriteGrant: executableWriteGrantSchema,
    }),
  ]),
);
export type ConfigShellSetRequest = z.infer<typeof configShellSetRequestSchema>;

/**
 * v1.2 adds `selection`. A switch that names no arguments takes the shell's
 * remembered ones (`config.shell.get@1.1`'s `entries`), else
 * `defaultShellArgs(path)`; "System default" is `system_default`.
 */
export const configShellSetRequestSchemaV12 = lazySchema(() =>
  z.union([
    z.object({
      path: shellPathSchema,
      args: shellArgsSchema,
      executableWriteGrant: executableWriteGrantSchema,
      selection: configShellSelectionSchema,
    }),
    z.object({
      path: z.null(),
      args: z.array(z.string()),
      executableWriteGrant: executableWriteGrantSchema,
      selection: configShellSelectionSchema,
    }),
  ]),
);
export type ConfigShellSetRequestV12 = z.infer<
  typeof configShellSetRequestSchemaV12
>;
/**
 * The shell choice itself, without the transport's grant: what the Settings
 * editor produces and what the desktop's local CLI bridge writes.
 */
export type ConfigShellSetRequestV10 = z.infer<
  typeof configShellSetRequestSchemaV10
>;

export const configShellSetResponseSchema = lazySchema(() =>
  z.object({
    path: shellPathSchema.nullable(),
    args: shellArgsSchema,
  }),
);
export type ConfigShellSetResponse = z.infer<
  typeof configShellSetResponseSchema
>;

/** The v1.0 request, FROZEN as released: empty. */
export const configShellResetRequestSchemaV10 = emptyRequestSchema;

/** v1.1: resetting the shell changes what starts, so it carries the grant. */
export const configShellResetRequestSchema = lazySchema(() =>
  z.object({ executableWriteGrant: executableWriteGrantSchema }),
);
export type ConfigShellResetRequest = z.infer<
  typeof configShellResetRequestSchema
>;

export const configShellResetResponseSchema = lazySchema(() =>
  z.object({
    reset: z.literal(true),
  }),
);
export type ConfigShellResetResponse = z.infer<
  typeof configShellResetResponseSchema
>;

/** The v1.0 request, FROZEN as released. */
export const configShellAddRequestSchemaV10 = lazySchema(() =>
  z.object({ path: shellPathSchema }),
);

/** v1.1: adds the executable-write grant. */
export const configShellAddRequestSchema = lazySchema(() =>
  z.object({
    path: shellPathSchema,
    executableWriteGrant: executableWriteGrantSchema,
  }),
);
export type ConfigShellAddRequest = z.infer<typeof configShellAddRequestSchema>;

/**
 * v1.2 adds `selection`. Add selects the shell it adds, so the app states
 * `{ path, args: defaultShellArgs(path) }`.
 */
export const configShellAddRequestSchemaV12 = lazySchema(() =>
  configShellAddRequestSchema.extend({ selection: configShellSelectionSchema }),
);
export type ConfigShellAddRequestV12 = z.infer<
  typeof configShellAddRequestSchemaV12
>;

export const configShellEntrySchema = lazySchema(() =>
  z.object({
    path: shellPathSchema,
    args: shellArgsSchema,
  }),
);
export type ConfigShellEntry = z.infer<typeof configShellEntrySchema>;

export const configShellAddResponseSchema = lazySchema(() =>
  z.object({
    path: shellPathSchema,
    entries: z.array(configShellEntrySchema),
  }),
);
export type ConfigShellAddResponse = z.infer<
  typeof configShellAddResponseSchema
>;

/** The v1.0 request, FROZEN as released. */
export const configShellRemoveRequestSchemaV10 = lazySchema(() =>
  z.object({
    path: shellPathSchema,
  }),
);

/** v1.1: adds the executable-write grant. */
export const configShellRemoveRequestSchema = lazySchema(() =>
  z.object({
    path: shellPathSchema,
    executableWriteGrant: executableWriteGrantSchema,
  }),
);
export type ConfigShellRemoveRequest = z.infer<
  typeof configShellRemoveRequestSchema
>;

/**
 * v1.2 adds `selection`: `system_default` when `path` is the current shell
 * (`config.shell.get`), else the current selection unchanged. Removing a
 * shell that is not the current one changes no item: the host answers
 * `proposal: null`, and the app remembers nothing.
 */
export const configShellRemoveRequestSchemaV12 = lazySchema(() =>
  configShellRemoveRequestSchema.extend({
    selection: configShellSelectionSchema,
  }),
);
export type ConfigShellRemoveRequestV12 = z.infer<
  typeof configShellRemoveRequestSchemaV12
>;

export const configShellRemoveResponseSchema = lazySchema(() =>
  z.object({
    removed: z.boolean(),
    path: shellPathSchema.nullable(),
  }),
);
export type ConfigShellRemoveResponse = z.infer<
  typeof configShellRemoveResponseSchema
>;

/** The v1.0 request, FROZEN as released. */
export const configShellRevertArgsRequestSchemaV10 = lazySchema(() =>
  z.object({
    path: shellPathSchema,
  }),
);

/** v1.1: adds the executable-write grant. */
export const configShellRevertArgsRequestSchema = lazySchema(() =>
  z.object({
    path: shellPathSchema,
    executableWriteGrant: executableWriteGrantSchema,
  }),
);
export type ConfigShellRevertArgsRequest = z.infer<
  typeof configShellRevertArgsRequestSchema
>;

/**
 * v1.2 adds `selection`: `{ path, args: defaultShellArgs(path) }` when `path`
 * is the current shell, else the current selection unchanged. Reverting a
 * shell that is not the current one changes no item: the host answers
 * `proposal: null`, and the app remembers nothing.
 */
export const configShellRevertArgsRequestSchemaV12 = lazySchema(() =>
  configShellRevertArgsRequestSchema.extend({
    selection: configShellSelectionSchema,
  }),
);
export type ConfigShellRevertArgsRequestV12 = z.infer<
  typeof configShellRevertArgsRequestSchemaV12
>;

export const configShellRevertArgsResponseSchema = lazySchema(() =>
  z.object({
    path: shellPathSchema,
    reverted: z.boolean(),
  }),
);
export type ConfigShellRevertArgsResponse = z.infer<
  typeof configShellRevertArgsResponseSchema
>;

export const configShellListDetectedRequestSchema = emptyRequestSchema;
export type ConfigShellListDetectedRequest = z.infer<
  typeof configShellListDetectedRequestSchema
>;

/**
 * The v1.0 row, FROZEN as released (cli-v1.2.0 shipped this shape). Adding a
 * key here - even an optional one - changes the wire schema at a released
 * version, which the protocol-compat gate rightly blocks; growth happens at
 * v1.1 below instead.
 */
export const configDetectedShellSchemaV10 = lazySchema(() =>
  z.object({
    name: z.string(),
    path: shellPathSchema,
    isDefault: z.boolean(),
    source: z.enum(["detected", "added"]),
    missing: z.boolean(),
  }),
);

/**
 * v1.1 adds `wslHealth`: optional both ways - absent from hosts predating the
 * probe, and absent on every healthy or non-WSL row. See
 * `DetectedShell.wslHealth`. This unversioned name stays the canonical row
 * shape clients import.
 */
export const configDetectedShellSchema = lazySchema(() =>
  configDetectedShellSchemaV10.extend({
    wslHealth: z.enum(["not-installed", "no-distro"]).optional(),
  }),
);
export type ConfigDetectedShell = z.infer<typeof configDetectedShellSchema>;

export const configShellListDetectedResponseSchemaV10 = lazySchema(() =>
  z.object({
    shells: z.array(configDetectedShellSchemaV10),
  }),
);

export const configShellListDetectedResponseSchema = lazySchema(() =>
  z.object({
    shells: z.array(configDetectedShellSchema),
  }),
);
export type ConfigShellListDetectedResponse = z.infer<
  typeof configShellListDetectedResponseSchema
>;

export const configShellProbeRequestSchema = lazySchema(() =>
  z.object({
    path: shellPathSchema,
  }),
);
export type ConfigShellProbeRequest = z.infer<
  typeof configShellProbeRequestSchema
>;

export const configShellProbeResponseSchema = lazySchema(() =>
  z.object({
    exists: z.boolean(),
    executable: z.boolean(),
  }),
);
export type ConfigShellProbeResponse = z.infer<
  typeof configShellProbeResponseSchema
>;

export const configEnvListRequestSchema = emptyRequestSchema;
export type ConfigEnvListRequest = z.infer<typeof configEnvListRequestSchema>;

export const configEnvEntrySchema = lazySchema(() =>
  z.object({
    // Hand-edited legacy config can contain a key the CLI would no longer let a
    // user create. Listing it must still work so it can be inspected or removed.
    key: z.string(),
    value: z.string().nullable(),
  }),
);
export type ConfigEnvEntry = z.infer<typeof configEnvEntrySchema>;

export const configEnvListResponseSchema = lazySchema(() =>
  z.object({
    entries: z.array(configEnvEntrySchema),
  }),
);
export type ConfigEnvListResponse = z.infer<typeof configEnvListResponseSchema>;

/** The v1.0 request, FROZEN as released. */
export const configEnvSetRequestSchemaV10 = lazySchema(() =>
  z.object({
    key: envKeySchema,
    value: z.string().nullable(),
  }),
);

/**
 * v1.1: a host-process variable can select what starts (a launch-sensitive
 * name), so the write carries the executable-write grant; whether a given key
 * reaches a sink is the host's decision, not the client's.
 */
export const configEnvSetRequestSchema = lazySchema(() =>
  z.object({
    key: envKeySchema,
    value: z.string().nullable(),
    executableWriteGrant: executableWriteGrantSchema,
  }),
);
export type ConfigEnvSetRequest = z.infer<typeof configEnvSetRequestSchema>;

export const configEnvSetResponseSchema = lazySchema(() =>
  z.object({
    key: envKeySchema,
    value: z.string().nullable(),
  }),
);
export type ConfigEnvSetResponse = z.infer<typeof configEnvSetResponseSchema>;

export const configEnvDeleteRequestSchema = lazySchema(() =>
  z.object({
    key: z.string().min(1),
  }),
);
export type ConfigEnvDeleteRequest = z.infer<
  typeof configEnvDeleteRequestSchema
>;

export const configEnvDeleteResponseSchema = lazySchema(() =>
  z.object({
    key: z.string(),
    deleted: z.literal(true),
  }),
);
export type ConfigEnvDeleteResponse = z.infer<
  typeof configEnvDeleteResponseSchema
>;

/** The only remote-configurable scopes. `desktop` stays window-local. */
export const configLogLevelScopeSchema = lazySchema(() =>
  z.enum(["cli", "host"]),
);
export type ConfigLogLevelScope = z.infer<typeof configLogLevelScopeSchema>;

export const configLogLevelSchema = lazySchema(() => z.enum(LOG_LEVELS));
export type ConfigLogLevel = z.infer<typeof configLogLevelSchema>;

/**
 * Reads the machine-user-global CLI and host thresholds. They are deliberately
 * not keyed by host id or deploy slot.
 */
export const configLogLevelsGetRequestSchema = emptyRequestSchema;
export type ConfigLogLevelsGetRequest = z.infer<
  typeof configLogLevelsGetRequestSchema
>;

export const configLogLevelsResponseSchema = lazySchema(() =>
  z.object({
    cliLogLevel: configLogLevelSchema,
    hostLogLevel: configLogLevelSchema,
  }),
);
export type ConfigLogLevelsResponse = z.infer<
  typeof configLogLevelsResponseSchema
>;

/**
 * Changes one machine-user-global threshold. There is no `desktop` scope on
 * the host wire: that threshold belongs to the local Electron window.
 */
export const configLogLevelsSetRequestSchema = lazySchema(() =>
  z.object({
    scope: configLogLevelScopeSchema,
    level: configLogLevelSchema,
  }),
);
export type ConfigLogLevelsSetRequest = z.infer<
  typeof configLogLevelsSetRequestSchema
>;

export const configLogLevelsSetResponseSchema = configLogLevelsResponseSchema;
export type ConfigLogLevelsSetResponse = z.infer<
  typeof configLogLevelsSetResponseSchema
>;

/**
 * Reads the machine-user-global switch for agent access to the in-app browser.
 * Like the log thresholds it is not keyed by host id or deploy slot: the file
 * is one per OS user, so the answer covers every host environment that user
 * runs on this machine.
 */
export const configBrowserGetRequestSchema = emptyRequestSchema;
export type ConfigBrowserGetRequest = z.infer<
  typeof configBrowserGetRequestSchema
>;

export const configBrowserResponseSchema = lazySchema(() =>
  z.object({
    agentAccess: z.boolean(),
  }),
);
export type ConfigBrowserResponse = z.infer<typeof configBrowserResponseSchema>;

/** Flips the machine-user-global agent browser-access switch. */
export const configBrowserSetRequestSchema = lazySchema(() =>
  z.object({
    agentAccess: z.boolean(),
  }),
);
export type ConfigBrowserSetRequest = z.infer<
  typeof configBrowserSetRequestSchema
>;

export const configBrowserSetResponseSchema = configBrowserResponseSchema;
export type ConfigBrowserSetResponse = z.infer<
  typeof configBrowserSetResponseSchema
>;

/**
 * Reads whether the configuration this host runs lets its agents take part in
 * its shared memories. Unlike the switches above this is not machine-global:
 * it belongs to the configuration, so the answer is about the one the host
 * serves now, and a host serving none answers `false`.
 */
export const configAgentMemoriesGetRequestSchema = emptyRequestSchema;
export type ConfigAgentMemoriesGetRequest = z.infer<
  typeof configAgentMemoriesGetRequestSchema
>;

/**
 * `revision` is the configuration revision this answer was read AT - how far
 * the host's projection has got, not the item's own. A caller that has just
 * written compares it with the revision its write was saved as: an `enabled`
 * read below that revision is some earlier revision's answer, and matching
 * what was asked for does not make it this write's. `null` before the host's
 * first read of the configuration, and for a host serving none.
 */
export const configAgentMemoriesResponseSchema = lazySchema(() =>
  z.object({
    enabled: z.boolean(),
    revision: z.number().int().nonnegative().nullable(),
    /**
     * The configuration the two above are ABOUT, read in the same snapshot
     * as them. A host can rebind from one configuration to another
     * without changing its id, so a caller comparing a read against its own
     * write has to compare this too: a later configuration's revision and
     * value say nothing about a write addressed to the one before it.
     * `null` on a host serving none.
     */
    environmentId: z.string().min(1).nullable(),
  }),
);
export type ConfigAgentMemoriesResponse = z.infer<
  typeof configAgentMemoriesResponseSchema
>;

/**
 * Turns shared memories for the configuration's agents on or off. The write
 * goes to the configuration, which authorizes it; a refusal, a stale row or a
 * held edit is an error, never a response.
 */
export const configAgentMemoriesSetRequestSchema = lazySchema(() =>
  z.object({
    enabled: z.boolean(),
  }),
);
export type ConfigAgentMemoriesSetRequest = z.infer<
  typeof configAgentMemoriesSetRequestSchema
>;

/**
 * What the host reads back for the configuration the write was addressed to.
 *
 * `enabled` is that configuration's setting as this host reads it, never
 * another's: a host that has moved to a different configuration answers
 * `false`, the behaviour its agents have.
 *
 * `state` says how far the change has got, which the caller needs told apart
 * because the three are different promises to the person:
 *
 * - `applied` - the configuration holds this change and this host has
 *   received it, so `enabled` is this write's own state and the
 *   configuration's agents behave accordingly.
 * - `saved` - the configuration holds it; this host has not received it yet,
 *   so `enabled` is still the state from before. It arrives on its own, and
 *   the caller reads back rather than treating it as in force here.
 * - `queued` - this computer is holding the edit to send, with no connection
 *   to the configuration: it is not saved anywhere yet and in force nowhere.
 *
 * `applied` is a claim about what this host READS, not a receipt for the
 * write, and it is made only of the revision the configuration saved THIS
 * write as: a host that reads the asked-for value at an older revision has
 * not received this change and answers `saved`, because a later revision it
 * has not received can still overturn what it reads. A host that has moved to
 * another configuration answers `saved` too, rather than claiming a state it
 * cannot see.
 *
 * `revision` is the configuration revision this write was saved as, for the
 * caller to recognise it in a later read's `revision`. `null` when the write
 * is only `queued`, which has been saved nowhere and so is no revision, and
 * when the configuration's answer named none this host could read. A `null`
 * revision is therefore not confirmable by a later read: the caller may say
 * the change is waiting, and must not later claim it arrived.
 */
export const configAgentMemoriesSetResponseSchema = lazySchema(() =>
  z.object({
    enabled: z.boolean(),
    state: z.enum(["applied", "saved", "queued"]),
    revision: z.number().int().nonnegative().nullable(),
    /**
     * The configuration this write was ADDRESSED to, named before it was
     * sent. Part of the correspondence, not decoration: a host can rebind
     * without changing its id, so a caller must match this against the
     * `environmentId` of the read it later compares, or a new
     * configuration's answer would resolve a write made to the old one.
     */
    environmentId: z.string().min(1),
    /**
     * The id this edit carries while it is held, so a caller can recognise it
     * later in `environment.status` - as a refusal in `pendingUploads`, or as
     * an `acceptedUploads` receipt naming the revision the configuration
     * eventually saved it as. Only a `queued` write has one: a write already
     * `saved` or `applied` carries its revision here instead, and nothing is
     * waiting to be recognised.
     */
    uploadId: z.string().min(1).nullable(),
  }),
);
export type ConfigAgentMemoriesSetResponse = z.infer<
  typeof configAgentMemoriesSetResponseSchema
>;

/**
 * Reads the machine-user-global policy for worktrees agents create. Like the
 * browser switch it is not keyed by host id or deploy slot: the file is one per
 * OS user, so the answer covers every host environment that user runs on this
 * machine, and it governs the agents running there.
 */
export const configWorktreesGetRequestSchema = emptyRequestSchema;
export type ConfigWorktreesGetRequest = z.infer<
  typeof configWorktreesGetRequestSchema
>;

export const configWorktreesResponseSchema = lazySchema(() =>
  z.object({
    agentCreate: z.enum(AGENT_WORKTREE_CREATE_POLICIES),
  }),
);
export type ConfigWorktreesResponse = z.infer<
  typeof configWorktreesResponseSchema
>;

/** Sets the machine-user-global policy for worktrees agents create. */
export const configWorktreesSetRequestSchema = lazySchema(() =>
  z.object({
    agentCreate: z.enum(AGENT_WORKTREE_CREATE_POLICIES),
  }),
);
export type ConfigWorktreesSetRequest = z.infer<
  typeof configWorktreesSetRequestSchema
>;

export const configWorktreesSetResponseSchema = configWorktreesResponseSchema;
export type ConfigWorktreesSetResponse = z.infer<
  typeof configWorktreesSetResponseSchema
>;

/**
 * Reads whether agents get the page tools (`visualization.agentPages`).
 * Machine-user-global like the browser switch, and read at agent launch, so a
 * change applies to agents started after it.
 */
export const configVisualizationGetRequestSchema = emptyRequestSchema;
export type ConfigVisualizationGetRequest = z.infer<
  typeof configVisualizationGetRequestSchema
>;

export const configVisualizationResponseSchema = lazySchema(() =>
  z.object({
    agentPages: z.boolean(),
  }),
);
export type ConfigVisualizationResponse = z.infer<
  typeof configVisualizationResponseSchema
>;

/** Turns the page tools on or off for agents launched from now on. */
export const configVisualizationSetRequestSchema = lazySchema(() =>
  z.object({
    agentPages: z.boolean(),
  }),
);
export type ConfigVisualizationSetRequest = z.infer<
  typeof configVisualizationSetRequestSchema
>;

export const configVisualizationSetResponseSchema =
  configVisualizationResponseSchema;
export type ConfigVisualizationSetResponse = z.infer<
  typeof configVisualizationSetResponseSchema
>;

/**
 * Reads the template the host renders into the name of a Claude Code session
 * it starts on the Terminal interface (`sessionNames.claudeTemplate`), with the
 * default and the placeholders THIS host knows, so the Settings field offers
 * and accepts only what the host renders. Read at the launch that creates the
 * session, so a change applies to sessions started after it.
 */
export const configSessionNamesGetRequestSchema = emptyRequestSchema;
export type ConfigSessionNamesGetRequest = z.infer<
  typeof configSessionNamesGetRequestSchema
>;

export const configSessionNamesResponseSchema = lazySchema(() =>
  z.object({
    claudeTemplate: z.string(),
    defaultClaudeTemplate: z.string(),
    placeholders: z.array(z.string()),
  }),
);
export type ConfigSessionNamesResponse = z.infer<
  typeof configSessionNamesResponseSchema
>;

/**
 * Writes the Claude session name template. The host refuses a template that
 * names a placeholder it does not know.
 */
export const configSessionNamesSetRequestSchema = lazySchema(() =>
  z.object({
    claudeTemplate: z.string().max(SESSION_NAME_TEMPLATE_MAX_LENGTH),
  }),
);
export type ConfigSessionNamesSetRequest = z.infer<
  typeof configSessionNamesSetRequestSchema
>;

export const configSessionNamesSetResponseSchema =
  configSessionNamesResponseSchema;
export type ConfigSessionNamesSetResponse = z.infer<
  typeof configSessionNamesSetResponseSchema
>;

/**
 * Reads the machine-wide catalog probe timeout: how long the host waits for a
 * provider to list its models or commands. Like the worktrees policy it is not
 * keyed by host id or deploy slot: the file is one per OS user.
 */
export const configCatalogGetRequestSchema = emptyRequestSchema;
export type ConfigCatalogGetRequest = z.infer<
  typeof configCatalogGetRequestSchema
>;

/**
 * The host-enforced range, sent so the GUI's control cannot offer a value the
 * host will refuse. Bounds are host constants, not user policy - they travel
 * as data so they can move without a protocol change.
 */
export const configCatalogBoundsSchema = lazySchema(() =>
  z.object({
    minSeconds: z.number().int().positive(),
    maxSeconds: z.number().int().positive(),
  }),
);
export type ConfigCatalogBounds = z.infer<typeof configCatalogBoundsSchema>;

/**
 * The 1.0 response: the shared timeout and its bounds. Frozen - 1.1 adds the
 * providers' own values beside it.
 */
export const configCatalogResponseSchemaV10 = lazySchema(() =>
  z.object({
    // Whole seconds, already clamped into `bounds` by the host.
    probeTimeoutSeconds: z.number().int().positive(),
    bounds: configCatalogBoundsSchema,
  }),
);
export type ConfigCatalogResponseV10 = z.infer<
  typeof configCatalogResponseSchemaV10
>;

/**
 * The 1.1 response. `probeTimeoutSeconds` is the value every provider shares;
 * `overrides` maps a harness id to that provider's own value, for each
 * provider whose "Same for all providers" switch is off. A provider absent
 * from it follows the shared value. Keys are open strings, so a harness this
 * schema predates still decodes; every value is clamped into `bounds`.
 */
export const configCatalogResponseSchema = lazySchema(() =>
  z.object({
    probeTimeoutSeconds: z.number().int().positive(),
    overrides: z.record(z.string().min(1), z.number().int().positive()),
    bounds: configCatalogBoundsSchema,
  }),
);
export type ConfigCatalogResponse = z.infer<typeof configCatalogResponseSchema>;

/**
 * The 1.0 request: sets the shared timeout. The schema proves only a positive
 * whole number: the host refuses a value outside its bounds, so a schema-level
 * range would freeze an implementation constant into the wire. Frozen; a 1.0
 * body reaches a 1.1 host as `{ scope: "all" }` through the registry's upgrade.
 */
export const configCatalogSetRequestSchemaV10 = lazySchema(() =>
  z.object({
    probeTimeoutSeconds: z.number().int().positive(),
  }),
);
export type ConfigCatalogSetRequestV10 = z.infer<
  typeof configCatalogSetRequestSchemaV10
>;

/**
 * The 1.1 request, one of two writes:
 *
 * - `scope: "all"` sets the shared value. It leaves every provider's own value
 *   alone: a provider whose switch is off keeps its value.
 * - `scope: "harness"` sets one provider's own value, or clears it with `null`
 *   so the provider follows the shared value again. `harnessId` is an open
 *   string, like the response's keys; the host refuses an id it does not know.
 *
 * Bounds are the host's to enforce, for both scopes, as in 1.0.
 */
export const configCatalogSetRequestSchema = lazySchema(() =>
  z.discriminatedUnion("scope", [
    z.object({
      scope: z.literal("all"),
      probeTimeoutSeconds: z.number().int().positive(),
    }),
    z.object({
      scope: z.literal("harness"),
      harnessId: z.string().min(1),
      probeTimeoutSeconds: z.number().int().positive().nullable(),
    }),
  ]),
);
export type ConfigCatalogSetRequest = z.infer<
  typeof configCatalogSetRequestSchema
>;

export const configCatalogSetResponseSchemaV10 = configCatalogResponseSchemaV10;
export type ConfigCatalogSetResponseV10 = z.infer<
  typeof configCatalogSetResponseSchemaV10
>;

export const configCatalogSetResponseSchema = configCatalogResponseSchema;
export type ConfigCatalogSetResponse = z.infer<
  typeof configCatalogSetResponseSchema
>;
