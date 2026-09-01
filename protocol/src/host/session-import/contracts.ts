/**
 * `sessionImport.status@1.0` - the unary read of import state.
 *
 * Exists because the run outlives the socket that started it (see `run.ts`):
 * a Settings pane that opens after the wizard was closed, or after a restart,
 * needs to know whether something is still in flight WITHOUT subscribing to
 * `sessionImport.run` and thereby attaching to - or worse, starting - a run.
 * So this is the only safe "is anything happening" question, and the surface
 * that renders the in-flight state (D15) polls it.
 *
 * `lastCompleted` is what the Settings entry shows once nothing is running -
 * the summary from the most recent run this host performed. It is null on a
 * host that has never imported.
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
      // Which run the summary is of, so a client that watched a run can tell
      // "this is the run I just saw finish" from "an older one, and mine is
      // still going somewhere I am not attached to".
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
