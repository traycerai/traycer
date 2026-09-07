/**
 * `sessionImport.status@1.0` - the unary read of import state.
 * It is null on a host that has never imported.
 */
import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { sessionImportRunCountsSchema } from "@traycer/protocol/host/session-import/run";

export const sessionImportStatusRequestSchema = z.object({});
export type SessionImportStatusRequest = z.infer<
  typeof sessionImportStatusRequestSchema
>;

export const sessionImportStatusResponseSchema = z.object({
  active: z
    .object({
      runId: z.string().min(1),
      done: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    })
    .nullable(),
  lastCompleted: z
    .object({
      runId: z.string().min(1),
      counts: sessionImportRunCountsSchema,
      at: z.number(),
    })
    .nullable(),
});
export type SessionImportStatusResponse = z.infer<
  typeof sessionImportStatusResponseSchema
>;

export const sessionImportStatusV10 = defineRpcContract({
  method: "sessionImport.status",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: sessionImportStatusRequestSchema,
  responseSchema: sessionImportStatusResponseSchema,
});

// The feature's whole wire surface, re-exported so a caller takes one import
// for the three contracts that only ever ship together.
export * from "@traycer/protocol/host/session-import/candidate";
export * from "@traycer/protocol/host/session-import/scan";
export * from "@traycer/protocol/host/session-import/run";
