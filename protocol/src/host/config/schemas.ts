import { z } from "zod";
import { LOG_LEVELS } from "@traycer/protocol/config/log-level";

/**
 * RPC payloads for the machine-user-global CLI config store.
 *
 * The store lives at `~/.traycer/cli/config.json`, outside a host slot. Shell,
 * environment, and CLI/host log-level changes therefore apply to every Traycer
 * host environment run by this OS user. Writes are intentionally last-writer-
 * wins and use the store's atomic-write path; these contracts add no per-host
 * state or locking layer.
 */

const emptyRequestSchema = z.object({});
const shellArgsSchema = z.array(z.string()).nullable();
const shellPathSchema = z.string().min(1);
const envKeySchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const configShellGetRequestSchema = emptyRequestSchema;
export type ConfigShellGetRequest = z.infer<typeof configShellGetRequestSchema>;

export const configShellGetResponseSchema = z.object({
  path: shellPathSchema,
  args: z.array(z.string()),
  synthesised: z.boolean(),
});
export type ConfigShellGetResponse = z.infer<
  typeof configShellGetResponseSchema
>;

// A shell-set operation must change either the selected program or its args;
// accepting `{ path: null, args: null }` would turn an RPC typo into a silent
// config-file rewrite instead of matching the CLI command's validation.
export const configShellSetRequestSchema = z.union([
  z.object({ path: shellPathSchema, args: shellArgsSchema }),
  z.object({ path: z.null(), args: z.array(z.string()) }),
]);
export type ConfigShellSetRequest = z.infer<typeof configShellSetRequestSchema>;

export const configShellSetResponseSchema = z.object({
  path: shellPathSchema.nullable(),
  args: shellArgsSchema,
});
export type ConfigShellSetResponse = z.infer<
  typeof configShellSetResponseSchema
>;

export const configShellResetRequestSchema = emptyRequestSchema;
export type ConfigShellResetRequest = z.infer<
  typeof configShellResetRequestSchema
>;

export const configShellResetResponseSchema = z.object({
  reset: z.literal(true),
});
export type ConfigShellResetResponse = z.infer<
  typeof configShellResetResponseSchema
>;

export const configShellAddRequestSchema = z.object({ path: shellPathSchema });
export type ConfigShellAddRequest = z.infer<typeof configShellAddRequestSchema>;

export const configShellEntrySchema = z.object({
  path: shellPathSchema,
  args: shellArgsSchema,
});
export type ConfigShellEntry = z.infer<typeof configShellEntrySchema>;

export const configShellAddResponseSchema = z.object({
  path: shellPathSchema,
  entries: z.array(configShellEntrySchema),
});
export type ConfigShellAddResponse = z.infer<
  typeof configShellAddResponseSchema
>;

export const configShellRemoveRequestSchema = z.object({
  path: shellPathSchema,
});
export type ConfigShellRemoveRequest = z.infer<
  typeof configShellRemoveRequestSchema
>;

export const configShellRemoveResponseSchema = z.object({
  removed: z.boolean(),
  path: shellPathSchema.nullable(),
});
export type ConfigShellRemoveResponse = z.infer<
  typeof configShellRemoveResponseSchema
>;

export const configShellRevertArgsRequestSchema = z.object({
  path: shellPathSchema,
});
export type ConfigShellRevertArgsRequest = z.infer<
  typeof configShellRevertArgsRequestSchema
>;

export const configShellRevertArgsResponseSchema = z.object({
  path: shellPathSchema,
  reverted: z.boolean(),
});
export type ConfigShellRevertArgsResponse = z.infer<
  typeof configShellRevertArgsResponseSchema
>;

export const configShellListDetectedRequestSchema = emptyRequestSchema;
export type ConfigShellListDetectedRequest = z.infer<
  typeof configShellListDetectedRequestSchema
>;

export const configDetectedShellSchema = z.object({
  name: z.string(),
  path: shellPathSchema,
  isDefault: z.boolean(),
  source: z.enum(["detected", "added"]),
  missing: z.boolean(),
});
export type ConfigDetectedShell = z.infer<typeof configDetectedShellSchema>;

export const configShellListDetectedResponseSchema = z.object({
  shells: z.array(configDetectedShellSchema),
});
export type ConfigShellListDetectedResponse = z.infer<
  typeof configShellListDetectedResponseSchema
>;

export const configShellProbeRequestSchema = z.object({
  path: shellPathSchema,
});
export type ConfigShellProbeRequest = z.infer<
  typeof configShellProbeRequestSchema
>;

export const configShellProbeResponseSchema = z.object({
  exists: z.boolean(),
  executable: z.boolean(),
});
export type ConfigShellProbeResponse = z.infer<
  typeof configShellProbeResponseSchema
>;

export const configEnvListRequestSchema = emptyRequestSchema;
export type ConfigEnvListRequest = z.infer<typeof configEnvListRequestSchema>;

export const configEnvEntrySchema = z.object({
  // Hand-edited legacy config can contain a key the CLI would no longer let a
  // user create. Listing it must still work so it can be inspected or removed.
  key: z.string(),
  value: z.string().nullable(),
});
export type ConfigEnvEntry = z.infer<typeof configEnvEntrySchema>;

export const configEnvListResponseSchema = z.object({
  entries: z.array(configEnvEntrySchema),
});
export type ConfigEnvListResponse = z.infer<typeof configEnvListResponseSchema>;

export const configEnvSetRequestSchema = z.object({
  key: envKeySchema,
  value: z.string().nullable(),
});
export type ConfigEnvSetRequest = z.infer<typeof configEnvSetRequestSchema>;

export const configEnvSetResponseSchema = z.object({
  key: envKeySchema,
  value: z.string().nullable(),
});
export type ConfigEnvSetResponse = z.infer<typeof configEnvSetResponseSchema>;

export const configEnvDeleteRequestSchema = z.object({
  key: z.string().min(1),
});
export type ConfigEnvDeleteRequest = z.infer<
  typeof configEnvDeleteRequestSchema
>;

export const configEnvDeleteResponseSchema = z.object({
  key: z.string(),
  deleted: z.literal(true),
});
export type ConfigEnvDeleteResponse = z.infer<
  typeof configEnvDeleteResponseSchema
>;

/** The only remote-configurable scopes. `desktop` stays window-local. */
export const configLogLevelScopeSchema = z.enum(["cli", "host"]);
export type ConfigLogLevelScope = z.infer<typeof configLogLevelScopeSchema>;

export const configLogLevelSchema = z.enum(LOG_LEVELS);
export type ConfigLogLevel = z.infer<typeof configLogLevelSchema>;

/**
 * Reads the machine-user-global CLI and host thresholds. They are deliberately
 * not keyed by host id or deploy slot.
 */
export const configLogLevelsGetRequestSchema = emptyRequestSchema;
export type ConfigLogLevelsGetRequest = z.infer<
  typeof configLogLevelsGetRequestSchema
>;

export const configLogLevelsResponseSchema = z.object({
  cliLogLevel: configLogLevelSchema,
  hostLogLevel: configLogLevelSchema,
});
export type ConfigLogLevelsResponse = z.infer<
  typeof configLogLevelsResponseSchema
>;

/**
 * Changes one machine-user-global threshold. There is no `desktop` scope on
 * the host wire: that threshold belongs to the local Electron window.
 */
export const configLogLevelsSetRequestSchema = z.object({
  scope: configLogLevelScopeSchema,
  level: configLogLevelSchema,
});
export type ConfigLogLevelsSetRequest = z.infer<
  typeof configLogLevelsSetRequestSchema
>;

export const configLogLevelsSetResponseSchema = configLogLevelsResponseSchema;
export type ConfigLogLevelsSetResponse = z.infer<
  typeof configLogLevelsSetResponseSchema
>;
