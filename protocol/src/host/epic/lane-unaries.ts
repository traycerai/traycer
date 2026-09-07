/**
 * The two unary reads that complete the epic lane surface: `epic.getWorkspaceContext@1.0` and `epic.retryMigration@1.0`.
 */
import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { earlyMetaEpicSchema } from "@traycer/protocol/host/epic/snapshot-meta";

/**
 * `epic.getWorkspaceContext@1.0` - the workspace context a tab needs before any lane can answer.
 * A naive unary port silently drops that, and the symptom is a stale repo chip and a stale permission gate that nothing ever corrects.
 */
export const getWorkspaceContextRequestSchema = z.object({
  epicId: z.string().min(1),
});
export type GetWorkspaceContextRequest = z.infer<
  typeof getWorkspaceContextRequestSchema
>;

/**
 * `epic.subscribe@1.0` - The context, wrapped rather than spread across the response's top level.
 * The wrapper is not ceremony: `earlyMetaEpicSchema` is SHARED with the frozen `earlyMeta` frame on `epic.subscribe@1.0`-`@1.3`, so growing it grows four released lines at once.
 */
export const getWorkspaceContextResponseSchema = z.object({
  context: earlyMetaEpicSchema,
});
export type GetWorkspaceContextResponse = z.infer<
  typeof getWorkspaceContextResponseSchema
>;

export const epicGetWorkspaceContextV10 = defineRpcContract({
  method: "epic.getWorkspaceContext",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: getWorkspaceContextRequestSchema,
  responseSchema: getWorkspaceContextResponseSchema,
});

/**
 * `epic.retryMigration@1.0` - re-run a major migration that failed.
 * `degrade: { kind: "unsupported" }`, off the released floor, same as the read above.
 */
export const retryMigrationRequestSchema = z.object({
  epicId: z.string().min(1),
});
export type RetryMigrationRequest = z.infer<typeof retryMigrationRequestSchema>;

export const retryMigrationResponseSchema = z.object({ ok: z.literal(true) });
export type RetryMigrationResponse = z.infer<
  typeof retryMigrationResponseSchema
>;

export const epicRetryMigrationV10 = defineRpcContract({
  method: "epic.retryMigration",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: retryMigrationRequestSchema,
  responseSchema: retryMigrationResponseSchema,
});
