import { z } from "zod";
import { LOG_LEVELS } from "@traycer/protocol/config/log-level";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

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

// A shell-set operation must change either the selected program or its args;
// accepting `{ path: null, args: null }` would turn an RPC typo into a silent
// config-file rewrite instead of matching the CLI command's validation.
export const configShellSetRequestSchema = lazySchema(() =>
  z.union([
    z.object({ path: shellPathSchema, args: shellArgsSchema }),
    z.object({ path: z.null(), args: z.array(z.string()) }),
  ]),
);
export type ConfigShellSetRequest = z.infer<typeof configShellSetRequestSchema>;

export const configShellSetResponseSchema = lazySchema(() =>
  z.object({
    path: shellPathSchema.nullable(),
    args: shellArgsSchema,
  }),
);
export type ConfigShellSetResponse = z.infer<
  typeof configShellSetResponseSchema
>;

export const configShellResetRequestSchema = emptyRequestSchema;
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

export const configShellAddRequestSchema = lazySchema(() =>
  z.object({ path: shellPathSchema }),
);
export type ConfigShellAddRequest = z.infer<typeof configShellAddRequestSchema>;

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

export const configShellRemoveRequestSchema = lazySchema(() =>
  z.object({
    path: shellPathSchema,
  }),
);
export type ConfigShellRemoveRequest = z.infer<
  typeof configShellRemoveRequestSchema
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

export const configShellRevertArgsRequestSchema = lazySchema(() =>
  z.object({
    path: shellPathSchema,
  }),
);
export type ConfigShellRevertArgsRequest = z.infer<
  typeof configShellRevertArgsRequestSchema
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

export const configEnvSetRequestSchema = lazySchema(() =>
  z.object({
    key: envKeySchema,
    value: z.string().nullable(),
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
