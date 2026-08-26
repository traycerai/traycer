import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { agentModeSchema } from "@traycer/protocol/persistence/epic/schemas";
import { worktreeBindingWorkspaceModeSchema } from "@traycer/protocol/host/worktree-schemas";

/**
 * `epic.listTuiAgents@1.0` - the terminal-agent RECORD read, the TUI sibling
 * of `epic.listChatRecords`.
 *
 * ## Why a sibling method and not a `kind` on the chat rows
 *
 * The chat row is deliberately small ("the harness id and only the harness
 * id, because that is all the row holds"); a terminal-agent row is the
 * OPPOSITE - its resume metadata IS the record (session id, workspace
 * folders, launch overrides, model tuple), there are a handful of them per
 * epic, and the renderer's terminal slice consumes all of it. Folding nine
 * TUI-only nullable fields onto every chat row to share a method would trade
 * one registry read for a permanently muddier shape - and `epic.listChatRecords`
 * is released, so widening its response is a new major, while a sibling
 * OPTIONAL method is exactly what the protocol's evolution rules provide for.
 *
 * ## Scope: the CALLER'S OWN rows, always
 *
 * Terminal agents are ALWAYS private to their owner (user ruling 2026-08-12).
 * The serving host's registry may hold other users' rows (a shared epic on a
 * multi-slot dev host); they are never serialized here. The
 * enumeration-oracle property holds: an epic with no terminal agents and an
 * epic whose terminal agents all belong to someone else answer identically.
 *
 * ## Optional, with a degrade story
 *
 * Registered `degrade: { kind: "unsupported" }` and never on the released
 * floor. A host predating this method answers `E_HOST_UNSUPPORTED`, and the
 * client's contract is DOC-ONLY MODE: that host still writes and serves the
 * epic doc's `tuiAgents` map, which is precisely the projection the renderer
 * already has. The two sources never overlap for one record: a host new
 * enough to serve this method has stopped writing the map and swept its own
 * entries.
 */
export const listTuiAgentsRequestSchema = z.object({
  epicId: z.string().min(1),
});
export type ListTuiAgentsRequest = z.infer<typeof listTuiAgentsRequestSchema>;

/**
 * One terminal agent, as the serving host's registry knows it.
 *
 * Field-for-field what the renderer's terminal slice renders plus the launch
 * fields it forwards - i.e. the persisted record MINUS the host-internal
 * bookkeeping that must never reach a client (`pinnedUserProviderHandle`,
 * `lastDeliveredRolesDigest`, `pendingForkSourceHarnessSessionId`).
 *
 * `archived` / `archivedAt` ship as the same pair the chat row carries and
 * for the same reason: the boolean is the rendering-authoritative field every
 * plane can answer; the timestamp is display metadata.
 *
 * `revision` is the row's per-record monotonic staleness test (the registry
 * head seq), exactly as on `chatRecordSummarySchema`: a consumer applies an
 * upsert only when its revision strictly exceeds the one held.
 */
export const tuiAgentRecordSummarySchema = z.object({
  tuiAgentId: z.string().min(1),
  /** IDENTITY-BEARING, as on the chat row - never render, always key. */
  ownerUserId: z.string().min(1),
  /**
   * The BINDING host - the record is bound to it for life. Non-empty like the
   * owner: a row with no binding could not be addressed by any affordance.
   */
  hostId: z.string().min(1),
  /**
   * The harness discriminator, an OPEN string on the wire so a newer host's
   * vendor still parses; clients narrow through their own harness catalog
   * and drop what they cannot dispatch.
   */
  harnessId: z.string().min(1),
  harnessSessionId: z.string().nullable(),
  parentId: z.string().nullable(),
  title: z.string(),
  isTitleEditedByUser: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  archived: z.boolean(),
  archivedAt: z.number().int().nonnegative().nullable(),
  workspaceFolders: z.array(z.string()),
  workspaceMode: worktreeBindingWorkspaceModeSchema.nullable(),
  model: z.string().nullable(),
  reasoningEffort: z.string().nullable(),
  agentMode: agentModeSchema,
  profileId: z.string().nullable(),
  terminalAgentArgs: z.string().nullable(),
  terminalShellCommand: z.string().nullable(),
  terminalShellArgs: z.array(z.string()).nullable(),
  revision: z.number().int().nonnegative(),
});
export type TuiAgentRecordSummary = z.infer<typeof tuiAgentRecordSummarySchema>;

export const listTuiAgentsResponseSchema = z.object({
  tuiAgents: z.array(tuiAgentRecordSummarySchema),
});
export type ListTuiAgentsResponse = z.infer<typeof listTuiAgentsResponseSchema>;

export const epicListTuiAgentsV10 = defineRpcContract({
  method: "epic.listTuiAgents",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: listTuiAgentsRequestSchema,
  responseSchema: listTuiAgentsResponseSchema,
});
