/**
 * `sessionImport.scan@1.0` - versioned streaming-RPC contract for discovering the native CLI sessions a user could bring into Traycer.
 * Reads are metadata-only and strictly read-only: a scan never writes, moves, or deletes anything the vendor owns.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import { guiHarnessIdSchema } from "@traycer/protocol/persistence/epic/foundation";
import {
  sessionImportFailureReasonSchema,
  sessionImportGroupSchema,
} from "@traycer/protocol/host/session-import/candidate";

/** `providers: null` scans every provider the host has a reader for - the wizard's default. */
export const sessionImportScanOpenRequestSchema = z.object({
  // `null` means every provider; a list narrows it and must name at least one, because an empty list is a scan that can only ever return nothing - which is a client bug, not a request worth serving.
  providers: z.array(guiHarnessIdSchema).min(1).nullable(),
  // Epoch ms; sessions last active before this are not scanned at all.
  // The wizard's scan-window control ("Last 2 weeks") lives here rather than as a client-side filter so the host never pays to enumerate work the user is not being shown.
  updatedAfter: z.number().nullable(),
});
export type SessionImportScanOpenRequest = z.infer<
  typeof sessionImportScanOpenRequestSchema
>;

const sessionImportScanTotalsSchema = z.object({
  groups: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
  importable: z.number().int().nonnegative(),
  alreadyInTraycer: z.number().int().nonnegative(),
  unreadable: z.number().int().nonnegative(),
});
export type SessionImportScanTotals = z.infer<
  typeof sessionImportScanTotalsSchema
>;

export const sessionImportScanServerFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("started"),
    providers: z.array(guiHarnessIdSchema),
    hasBinaryPayload: z.literal(false),
  }),
  z.object({
    kind: z.literal("group"),
    group: sessionImportGroupSchema,
    hasBinaryPayload: z.literal(false),
  }),
  z.object({
    kind: z.literal("providerFailed"),
    harness: guiHarnessIdSchema,
    reason: sessionImportFailureReasonSchema,
    detail: z.string(),
    hasBinaryPayload: z.literal(false),
  }),
  z.object({
    kind: z.literal("complete"),
    totals: sessionImportScanTotalsSchema,
    hasBinaryPayload: z.literal(false),
  }),
  z.object({
    kind: z.literal("pong"),
    hasBinaryPayload: z.literal(false),
  }),
]);
export type SessionImportScanServerFrame = z.infer<
  typeof sessionImportScanServerFrameSchema
>;

export const sessionImportScanClientFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ping"),
    hasBinaryPayload: z.literal(false),
  }),
]);
export type SessionImportScanClientFrame = z.infer<
  typeof sessionImportScanClientFrameSchema
>;

export const sessionImportScanV10 = defineStreamRpcContract({
  method: "sessionImport.scan",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: sessionImportScanOpenRequestSchema,
  serverFrameSchema: sessionImportScanServerFrameSchema,
  clientFrameSchema: sessionImportScanClientFrameSchema,
});
