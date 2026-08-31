/**
 * `sessionImport.scan@1.0` - versioned streaming-RPC contract for discovering
 * the native CLI sessions a user could bring into Traycer.
 *
 * Subscribing makes the host read the vendors' own session directories
 * (`~/.claude/projects`, `~/.codex/sessions`, …) - the ONLY moment it ever
 * does; there is no background scanning. Reads are metadata-only and strictly
 * read-only: a scan never writes, moves, or deletes anything the vendor owns.
 *
 * Groups are emitted AFTER the walk, one frame per folder, rather than as one
 * list. They cannot stream during the walk: a folder's membership spans
 * providers, so "this folder is complete" is not knowable until every provider
 * has been walked. The frame that genuinely arrives early is `providerFailed`,
 * which is sent the moment a provider gives up - which is what lets the wizard
 * grey that provider out while the rest of the scan is still running.
 *
 * Server frames:
 *
 * - `started`        - emitted once, before any directory is opened.
 * - `group`          - one repo folder's worth of candidates, complete. Sent
 *                      after every provider has been walked.
 * - `providerFailed` - one provider could not be scanned at all; the others
 *                      keep walking. The one frame that is live: it is sent
 *                      during the walk rather than as a field on `complete`, so
 *                      the wizard can grey that provider's section out WHILE
 *                      the scan is still running, which is exactly when the
 *                      user is looking at it.
 * - `complete`       - terminal frame; carries the totals the header shows.
 * - `pong`           - heartbeat response.
 *
 * Client frames:
 *
 * - `ping` - heartbeat. No application client frames.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import { guiHarnessIdSchema } from "@traycer/protocol/persistence/epic/foundation";
import {
  sessionImportFailureReasonSchema,
  sessionImportGroupSchema,
} from "@traycer/protocol/host/session-import/candidate";

/**
 * `providers: null` scans every provider the host has a reader for - the
 * wizard's default. A non-empty list narrows it, which is what the per-
 * provider filter inside the wizard submits.
 */
export const sessionImportScanOpenRequestSchema = z.object({
  // `null` means every provider; a list narrows it and must name at least one,
  // because an empty list is a scan that can only ever return nothing - which
  // is a client bug, not a request worth serving.
  providers: z.array(guiHarnessIdSchema).min(1).nullable(),
  // Epoch ms; sessions last active before this are not scanned at all. The
  // wizard's scan-window control ("Last 2 weeks") lives here rather than as a
  // client-side filter so the host never pays to enumerate work the user is
  // not being shown. `null` scans everything.
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
