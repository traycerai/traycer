import { z } from "zod";
import {
  agentModeSchema,
  tuiHarnessIdSchema,
} from "@traycer/protocol/host/agent/shared";
import { GENERATE_TITLE_SOURCE_TEXT_MAX_CHARS } from "@traycer/protocol/host/epic/unary-schemas";
import {
  worktreeBindingWorkspaceModeSchema,
  worktreeIntentSchema,
} from "@traycer/protocol/host/worktree-schemas";

// ─── Catalog rows (per-surface) ───────────────────────────────────────────
// The id is narrowed to the surface's enum so the renderer never has to widen.

export const tuiHarnessOptionSchema = z.object({
  id: tuiHarnessIdSchema,
  label: z.string(),
  // Controls whether the harness is included in downstream filtering and shown in the CLI.
  enabled: z.boolean().default(true),
  available: z.boolean(),
  error: z.string().nullable(),
  // True while the host's availability probe for this harness is still running in the background (mirrors `guiHarnessOptionSchema`).
  // A pending row carries the last settled verdict for `available` - `false` only when the host has never settled one; a TUI consumer should re-fetch until it flips false rather than treat the harness as unavailable.
  availabilityPending: z.boolean().catch(false),
});
export type TuiHarnessOption = z.infer<typeof tuiHarnessOptionSchema>;

// ─── `agent.tui.listHarnesses` ───────────────────────────────────────────

export const listTuiHarnessesRequestSchema = z.object({});
export type ListTuiHarnessesRequest = z.infer<
  typeof listTuiHarnessesRequestSchema
>;

export const listTuiHarnessesResponseSchema = z.object({
  harnesses: z.array(tuiHarnessOptionSchema),
});
export type ListTuiHarnessesResponse = z.infer<
  typeof listTuiHarnessesResponseSchema
>;

// ─── `agent.tui.prepareLaunch@1.0` - prepare a TUI-agent launch ───────────
export const prepareTuiLaunchRequestSchema = z.object({
  harnessId: tuiHarnessIdSchema,
  epicId: z.string(),
  model: z.string().nullable(),
  reasoningEffort: z.string().nullable().default(null),
  agentMode: agentModeSchema,
  tuiAgentId: z.string().nullable(),
  harnessSessionId: z.string().nullable(),
  // Launch-time override for the extra CLI args appended to the spawned argv.
  terminalAgentArgs: z.string().nullable().default(null),
  workspaceMode: worktreeBindingWorkspaceModeSchema.optional(),
  // When non-null, prepare a fork from this upstream provider session and return/open the newly forked session.
  // This is distinct from `harnessSessionId`: the source id must not be persisted on the new agent.
  forkSourceHarnessSessionId: z.string().nullable().default(null),
  // Which of the harness's logged-in profiles (subscriptions) to spawn this launch's adapter with.
  profileId: z.string().nullable().default(null),
});
export type PrepareTuiLaunchRequest = z.infer<
  typeof prepareTuiLaunchRequestSchema
>;

// ─── `agent.tui.prepareLaunch@1.1` - + stable fork-source agent id ────────
// `null` - the v1.0-upgraded default - keeps that strict-scan fallback for old clients; never the fail-open missing⇒ambient shape.
export const prepareTuiLaunchRequestSchemaV11 =
  prepareTuiLaunchRequestSchema.extend({
    forkSourceTuiAgentId: z.string().nullable().default(null),
  });
export type PrepareTuiLaunchRequestV11 = z.infer<
  typeof prepareTuiLaunchRequestSchemaV11
>;

export const prepareTuiLaunchResponseSchema = z.object({
  harnessId: tuiHarnessIdSchema,
  // `null` when the harness hasn't allocated a CLI-resumable id yet (Codex
  // first launch - back-filled async). Always non-null for Claude/OpenCode.
  harnessSessionId: z.string().nullable(),
  terminalShellCommand: z.string().nullable(),
  terminalShellArgs: z.array(z.string()).nullable(),
  hostId: z.string(),
  workingDirectory: z.string(),
  workspaceFolders: z.array(z.string()),
  // Concrete worktree paths the harness will hold open for the lifetime of the visible PTY.
  worktreeBusyPaths: z.array(z.string()),
});
export type PrepareTuiLaunchResponse = z.infer<
  typeof prepareTuiLaunchResponseSchema
>;

// ─── `agent.tui.validateForkProfile@1.0` - preflight fork-profile admission ─
export const validateTuiForkProfileRequestSchema = z.object({
  epicId: z.string(),
  sourceTuiAgentId: z.string(),
  targetProfileIds: z.array(z.string().nullable()).min(1),
});
export type ValidateTuiForkProfileRequest = z.infer<
  typeof validateTuiForkProfileRequestSchema
>;

// Mirrors `TuiForkScopeGuardSubcode` in the host's `tui-fork-scope-guard.ts` (kept as an independent literal union here - the wire schema must not import host domain code), plus `TARGET_PROFILE_UNAVAILABLE` for a.
export const tuiForkProfileAdmissionSubcodeSchema = z.enum([
  "SCOPE_MISMATCH",
  "FORK_SOURCE_NOT_FOUND",
  "FORK_SOURCE_AMBIGUOUS",
  "TARGET_PROFILE_UNAVAILABLE",
  "SOURCE_NOT_READY",
]);
export type TuiForkProfileAdmissionSubcode = z.infer<
  typeof tuiForkProfileAdmissionSubcodeSchema
>;

// One verdict per requested `targetProfileId`, same order as the request.
export const tuiForkProfileAdmissionVerdictSchema = z.object({
  targetProfileId: z.string().nullable(),
  admitted: z.boolean(),
  subcode: tuiForkProfileAdmissionSubcodeSchema.nullable(),
  message: z.string().nullable(),
});
export type TuiForkProfileAdmissionVerdict = z.infer<
  typeof tuiForkProfileAdmissionVerdictSchema
>;

export const validateTuiForkProfileResponseSchema = z.object({
  verdicts: z.array(tuiForkProfileAdmissionVerdictSchema),
});
export type ValidateTuiForkProfileResponse = z.infer<
  typeof validateTuiForkProfileResponseSchema
>;

// ─── `agent.tui.generateTitle@1.0` - hook-driven title generation ──────────

export const generateTuiAgentTitleRequestSchema = z.object({
  epicId: z.string().nullable().default(null),
  tuiAgentId: z.string().nullable().default(null),
  harnessSessionId: z.string().nullable().default(null),
  harnessId: tuiHarnessIdSchema,
  promptText: z.string().min(1).max(GENERATE_TITLE_SOURCE_TEXT_MAX_CHARS),
});
export type GenerateTuiAgentTitleRequest = z.infer<
  typeof generateTuiAgentTitleRequestSchema
>;

export const generateTuiAgentTitleResponseSchema = z.object({
  accepted: z.boolean(),
});
export type GenerateTuiAgentTitleResponse = z.infer<
  typeof generateTuiAgentTitleResponseSchema
>;

// ─── `agent.tui.turnEnded@1.0` - Stop-hook turn-completion signal ─────────

export const tuiAgentTurnEndedRequestSchema = z.object({
  epicId: z.string(),
  tuiAgentId: z.string(),
  harnessId: tuiHarnessIdSchema,
});
export type TuiAgentTurnEndedRequest = z.infer<
  typeof tuiAgentTurnEndedRequestSchema
>;

export const tuiAgentTurnEndedResponseSchema = z.object({
  // `accepted` is true when the resolver recorded the turn-end edge; false for a benign no-op (record missing, ownership/harness mismatch, broker unavailable).
  accepted: z.boolean(),
});
export type TuiAgentTurnEndedResponse = z.infer<
  typeof tuiAgentTurnEndedResponseSchema
>;

// ─── `agent.tui.recordActivity@1.0` - hook-driven activity edges ──────────

export const recordTuiAgentActivityRequestSchema = z.object({
  epicId: z.string().nullable().default(null),
  tuiAgentId: z.string().nullable().default(null),
  harnessSessionId: z.string().nullable().default(null),
  harnessId: tuiHarnessIdSchema,
  event: z.enum(["start", "stop"]),
});
export type RecordTuiAgentActivityRequest = z.infer<
  typeof recordTuiAgentActivityRequestSchema
>;

export const recordTuiAgentActivityResponseSchema = z.object({
  accepted: z.boolean(),
});
export type RecordTuiAgentActivityResponse = z.infer<
  typeof recordTuiAgentActivityResponseSchema
>;

// ─── `agent.tui.recordActivity@1.1` - + observed session-id resync ────────
// This is DISTINCT from the existing `harnessSessionId` request field, which stays an OpenCode match-or-reject identity guard - never overloaded here.

export const recordTuiAgentActivityRequestSchemaV11 =
  recordTuiAgentActivityRequestSchema.extend({
    event: z.enum(["start", "stop", "resync"]),
    observedHarnessSessionId: z.string().nullable().default(null),
  });
export type RecordTuiAgentActivityRequestV11 = z.infer<
  typeof recordTuiAgentActivityRequestSchemaV11
>;

// ─── `agent.tui.promptSubmitted@1.0` - prompt-submit activity + roles pull ─

export const tuiAgentPromptSubmittedRequestSchema = z.object({
  epicId: z.string().nullable().default(null),
  tuiAgentId: z.string().nullable().default(null),
  harnessSessionId: z.string().nullable().default(null),
  harnessId: tuiHarnessIdSchema,
  observedHarnessSessionId: z.string().nullable().default(null),
});
export type TuiAgentPromptSubmittedRequest = z.infer<
  typeof tuiAgentPromptSubmittedRequestSchema
>;

/**
 * `agent.tui.promptSubmitted@1.1` - optional submit-time workspace-binding intent, same `worktreeIntent` shape the rebind mutations (`worktree.create` folder intents) already use and that `chat.subscribe` `send` /.
 */
export const tuiAgentPromptSubmittedRequestSchemaV11 =
  tuiAgentPromptSubmittedRequestSchema.extend({
    // Optional (not defaulted) so a 1.0-shaped constructor - the CLI hook that predates this field - remains assignable to the latest request type.
    worktreeIntent: worktreeIntentSchema.nullable().optional(),
  });
export type TuiAgentPromptSubmittedRequestV11 = z.infer<
  typeof tuiAgentPromptSubmittedRequestSchemaV11
>;

export const tuiAgentPromptSubmittedResponseSchema = z.object({
  accepted: z.boolean(),
  pendingPromptContext: z.string().nullable(),
});
export type TuiAgentPromptSubmittedResponse = z.infer<
  typeof tuiAgentPromptSubmittedResponseSchema
>;
