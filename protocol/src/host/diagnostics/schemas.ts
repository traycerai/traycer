import { z } from "zod";

const emptyRequestSchema = z.object({});

/** Host-owned logs only: desktop logging remains a local Electron concern. */
export const diagnosticsLogTargetSchema = z.enum(["host", "cli"]);
export type DiagnosticsLogTarget = z.infer<typeof diagnosticsLogTargetSchema>;

export const diagnosticsLogDescriptorSchema = z.object({
  target: diagnosticsLogTargetSchema,
  label: z.string(),
  path: z.string().min(1),
});
export type DiagnosticsLogDescriptor = z.infer<
  typeof diagnosticsLogDescriptorSchema
>;

export const diagnosticsLogsListRequestSchema = emptyRequestSchema;
export type DiagnosticsLogsListRequest = z.infer<
  typeof diagnosticsLogsListRequestSchema
>;

export const diagnosticsLogsListResponseSchema = z.object({
  logs: z.array(diagnosticsLogDescriptorSchema),
});
export type DiagnosticsLogsListResponse = z.infer<
  typeof diagnosticsLogsListResponseSchema
>;

// The host clamps this finite value to the desktop-established 1..500 range.
// Keeping the request wider makes the server-side safety guarantee real rather
// than relying on a conforming renderer.
export const diagnosticsLogsTailRequestSchema = z.object({
  target: diagnosticsLogTargetSchema,
  tailLines: z.number().finite(),
});
export type DiagnosticsLogsTailRequest = z.infer<
  typeof diagnosticsLogsTailRequestSchema
>;

const diagnosticsLogsTailAvailableResponseSchema = z.object({
  status: z.literal("available"),
  target: diagnosticsLogTargetSchema,
  path: z.string().min(1),
  lines: z.array(z.string()),
  truncated: z.boolean(),
});
/**
 * CLI-only, and the narrow `target` literal is the point rather than an
 * oversight.
 *
 * The two targets fail differently. The CLI log is written by a separate
 * process that may never have run on this machine, so "there is no such file"
 * is a real answer about a real absence. The host log belongs to the process
 * answering this very call: it is running, so an unwritten file means "nothing
 * logged yet", which is an EMPTY tail, not an unavailable one. Widening this
 * to `diagnosticsLogTargetSchema` would let a host report its own logs
 * missing, and the panel would tell the user their connected host has no log
 * file while that host is talking to them.
 */
const diagnosticsLogsTailUnavailableResponseSchema = z.object({
  status: z.literal("unavailable"),
  target: z.literal("cli"),
  reason: z.literal("missing"),
});
export const diagnosticsLogsTailResponseSchema = z.union([
  diagnosticsLogsTailAvailableResponseSchema,
  diagnosticsLogsTailUnavailableResponseSchema,
]);
export type DiagnosticsLogsTailResponse = z.infer<
  typeof diagnosticsLogsTailResponseSchema
>;
