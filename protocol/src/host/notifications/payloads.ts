/**
 * Semantic payload schemas for `HostNotifications.json_data` — the single
 * source of truth for what consumers (renderer presentation/navigation,
 * webhook projection) may rely on once a row's payload is complete.
 *
 * These schemas describe the POST-ENRICHMENT consumer contract, not the
 * persisted shape: a host may persist an ID-only partial (titles omitted,
 * joined in from a host-local title index at read time) and enrich it into
 * one of these shapes before it reaches a strict consumer. They are a
 * SECOND-STAGE parse, never a transport gate — the wire entry
 * (`hostNotificationEntrySchema`) and SQLite persistence keep the payload an
 * open record on purpose: rows outlive code in both directions (upgrades
 * read old rows, downgrades read future rows), so the compatibility
 * boundary must accept unknown shapes and let consumers degrade per row
 * instead of dropping or failing a frame.
 *
 * EVOLUTION RULE (additive-only):
 *   - never rename or retype an existing field;
 *   - new fields must be optional;
 *   - a new shape is a NEW payload `kind` — consumers that don't know it
 *     degrade to generic rendering, they do not error.
 * A breaking reshape requires a deliberate compatibility window
 * (dual-write / read-new-fallback-old), not an in-place redefinition.
 */
import { z } from "zod";
import {
  hostNotificationOutcomeSchema,
  type HostNotificationKind,
} from "@traycer/protocol/host/notifications/host-notifications";

/** Identifier fields must be non-empty: an empty id is a malformed row, and
 * letting it through would mint an unusable deep-link instead of degrading. */
const idSchema = z.string().min(1);

export const HOST_NOTIFICATION_STOPPED_REASONS = [
  "auth",
  "rate_limit",
  "billing",
  "model_unavailable",
  "provider_unavailable",
  "provider_connection_failed",
  "context_exhausted",
  "request_rejected",
  "turn_start_timeout",
  "missing_terminal_event",
  "background_work_failed",
] as const;
export type HostNotificationStoppedReason =
  (typeof HOST_NOTIFICATION_STOPPED_REASONS)[number];

/**
 * Central normalization for the stable runtime codes that are safe to explain
 * in a durable notification. Unknown, ambiguous, configuration, and
 * provider-controlled errors deliberately return `null`: consumers must use
 * generic failure copy rather than infer semantics from raw text.
 *
 * New rows persist the result at the host notification boundary. Consumers may
 * also call this only as a compatibility fallback for rows minted before the
 * additive `reason` field existed.
 */
export function deriveHostNotificationStoppedReason(
  code: string | null,
): HostNotificationStoppedReason | null {
  const normalized = code?.trim().toLowerCase() ?? null;
  switch (normalized) {
    case "auth":
      return "auth";
    case "rate_limit":
    case "usage_limit_exceeded":
    case "session_budget_exceeded":
      return "rate_limit";
    case "billing_error":
      return "billing";
    case "model_not_found":
      return "model_unavailable";
    case "overloaded":
    case "server_error":
      return "provider_unavailable";
    case "claude_code_transport":
    case "connection_failed":
      return "provider_connection_failed";
    case "context_window_exceeded":
      return "context_exhausted";
    case "invalid_request":
      return "request_rejected";
    case "turn_start_timeout":
      return "turn_start_timeout";
    case "missing_terminal_event":
      return "missing_terminal_event";
    case "background_work_died":
      return "background_work_failed";
    case null:
    default:
      return null;
  }
}

/**
 * GUI `agent.stopped` payload: the "chat" shape. `agentName` carries the
 * chat title (the GUI agent IS the chat).
 */
export const hostNotificationChatStoppedPayloadSchema = z
  .object({
    kind: z.literal("chat"),
    epicId: idSchema,
    chatId: idSchema.nullable(),
    hostId: idSchema.optional(),
    agentName: z.string(),
    taskTitle: z.string(),
    outcome: hostNotificationOutcomeSchema,
    code: z.string().optional(),
    message: z.string().optional(),
    reason: z.string().optional(),
    providerId: z.string().optional(),
    occurrenceId: idSchema.optional(),
    messageId: idSchema.optional(),
    eventId: idSchema.optional(),
    backgroundWorkRunning: z.boolean().optional(),
    automaticRecovery: z.literal(true).optional(),
  })
  .catchall(z.unknown());
export type HostNotificationChatStoppedPayload = z.infer<
  typeof hostNotificationChatStoppedPayloadSchema
>;

/**
 * TUI `agent.stopped` payload: the "epic" shape. `agentName` is the
 * terminal-agent name — NOT a chat title. The row itself is chat-scoped to
 * `tuiAgentId` (hosts minted these rows without a chat binding before that
 * change, so entries from older rows may still carry a null `chatId`).
 */
export const hostNotificationEpicStoppedPayloadSchema = z
  .object({
    kind: z.literal("epic"),
    epicId: idSchema,
    tuiAgentId: idSchema,
    agentName: z.string(),
    taskTitle: z.string(),
    outcome: hostNotificationOutcomeSchema,
    code: z.string().optional(),
    message: z.string().optional(),
    reason: z.string().optional(),
    providerId: z.string().optional(),
    occurrenceId: idSchema.optional(),
    backgroundWorkRunning: z.boolean().optional(),
    automaticRecovery: z.literal(true).optional(),
  })
  .catchall(z.unknown());
export type HostNotificationEpicStoppedPayload = z.infer<
  typeof hostNotificationEpicStoppedPayloadSchema
>;

/**
 * `agent.stalled` payload. `agentName` carries the chat title. `reason` is
 * deliberately an open string (not a closed enum) so a future stall reason
 * degrades to generic copy instead of failing the parse.
 */
export const hostNotificationAgentStalledPayloadSchema = z
  .object({
    kind: z.literal("agent_stalled"),
    epicId: idSchema,
    chatId: idSchema,
    agentId: idSchema,
    agentName: z.string(),
    taskTitle: z.string(),
    reason: z.string(),
    title: z.string(),
    message: z.string().optional(),
    outcome: hostNotificationOutcomeSchema,
  })
  .catchall(z.unknown());
export type HostNotificationAgentStalledPayload = z.infer<
  typeof hostNotificationAgentStalledPayloadSchema
>;

/**
 * `workspace.operation.failed` payload. `operation` stays open so a newer host
 * can add workspace lifecycle operations without making an older renderer drop
 * the row's typed chat navigation and generic failure presentation.
 */
export const hostNotificationWorkspaceOperationFailedPayloadSchema = z
  .object({
    kind: z.literal("workspace_operation_failed"),
    epicId: idSchema,
    chatId: idSchema,
    chatTitle: z.string(),
    taskTitle: z.string(),
    operation: idSchema,
    title: z.string(),
    message: z.string(),
    workspacePath: z.string().optional(),
    worktreePath: z.string().optional(),
    branch: z.string().optional(),
    setupExitCode: z.number().int().nullable().optional(),
    terminalSessionId: z.string().optional(),
    outcome: z.literal("errored"),
  })
  .catchall(z.unknown());
export type HostNotificationWorkspaceOperationFailedPayload = z.infer<
  typeof hostNotificationWorkspaceOperationFailedPayloadSchema
>;

/** `approval.requested` payload. `chatTitle` carries the chat title. */
export const hostNotificationApprovalPayloadSchema = z
  .object({
    kind: z.literal("approval"),
    epicId: idSchema,
    chatId: idSchema,
    chatTitle: z.string(),
    taskTitle: z.string(),
    approvalId: idSchema,
  })
  .catchall(z.unknown());
export type HostNotificationApprovalPayload = z.infer<
  typeof hostNotificationApprovalPayloadSchema
>;

/** `interview.requested` payload. `chatTitle` carries the chat title. */
export const hostNotificationInterviewPayloadSchema = z
  .object({
    kind: z.literal("interview"),
    epicId: idSchema,
    chatId: idSchema,
    chatTitle: z.string(),
    taskTitle: z.string(),
    interviewBlockId: idSchema,
  })
  .catchall(z.unknown());
export type HostNotificationInterviewPayload = z.infer<
  typeof hostNotificationInterviewPayloadSchema
>;

/**
 * The common field convention EVERY `host.operation.finished` payload arm
 * must satisfy, read leniently as an open record.
 *
 * This is the middle degradation tier, and the whole reason the outer arm can
 * stay frozen while operations keep being added: a client that knows
 * `host.operation.finished` but not the newest operation's payload arm still
 * gets host-composed, display-safe copy instead of "a host operation
 * finished". `operation` is an open identifier (first value
 * `worktree.deletion`), never a closed enum - the precedent is
 * `workspace_operation_failed.operation`.
 *
 * Deliberately NOT a member of `hostNotificationKnownPayloadSchema`: this is a
 * shape every arm conforms to, not an arm of its own, so it must never win a
 * discriminated-union match against a real operation payload.
 */
export const hostOperationCommonPayloadSchema = z
  .object({
    operation: idSchema,
    title: z.string().min(1),
    message: z.string().min(1),
  })
  .catchall(z.unknown());
export type HostOperationCommonPayload = z.infer<
  typeof hostOperationCommonPayloadSchema
>;

/**
 * Total lenient parse of the common fields, or `null` when the payload does
 * not carry them. `null` means "fall through to generic copy" - never an
 * error, since rows outlive code in both directions.
 */
export function parseHostOperationCommonPayload(
  value: unknown,
): HostOperationCommonPayload | null {
  const parsed = hostOperationCommonPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The stable `operation` identifier of the first (and so far only)
 * `host.operation.finished` producer.
 *
 * Deliberately NOT the `worktree.delete` RPC method name: this names a
 * user-authorized deletion COMMAND over N targets, which is a different thing
 * from the released single-target endpoint, and a durable row must not read
 * as if it were an RPC trace.
 */
export const HOST_OPERATION_WORKTREE_DELETION = "worktree.deletion";

/**
 * `host.operation.finished` payload for a worktree-deletion command - the
 * first operation arm, and the template for every later one.
 *
 * Carries the common `operation`/`title`/`message` convention (so a client
 * that knows the outer kind but not this arm still renders host-composed
 * copy) plus exactly the structured fields presentation and routing need:
 * the command's identity, where the user started it, and the aggregate
 * counts.
 *
 * What it deliberately EXCLUDES is as much of the contract as what it
 * carries: no worktree paths, no teardown output, no raw command text, no
 * arbitrary error strings. A notification row is durable, is delivered to
 * email and webhooks, and outlives the filesystem it describes - a path in it
 * is both a leak and a lie. It is also why no retry action exists: a safe
 * retry would need exactly the paths this must not persist.
 */
export const hostNotificationWorktreeDeletionPayloadSchema = z
  .object({
    kind: z.literal("worktree_deletion"),
    operation: z.literal(HOST_OPERATION_WORKTREE_DELETION),
    title: z.string().min(1),
    message: z.string().min(1),
    commandId: idSchema,
    /** Open string, not the wire enum: a row minted by a newer host with a
     * source this build has never heard of must still render and route. */
    source: idSchema,
    requestedCount: z.number().int().nonnegative(),
    deletedCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
  })
  .catchall(z.unknown());
export type HostNotificationWorktreeDeletionPayload = z.infer<
  typeof hostNotificationWorktreeDeletionPayloadSchema
>;

export const hostNotificationKnownPayloadSchema = z.discriminatedUnion("kind", [
  hostNotificationChatStoppedPayloadSchema,
  hostNotificationEpicStoppedPayloadSchema,
  hostNotificationAgentStalledPayloadSchema,
  hostNotificationWorkspaceOperationFailedPayloadSchema,
  hostNotificationApprovalPayloadSchema,
  hostNotificationInterviewPayloadSchema,
  hostNotificationWorktreeDeletionPayloadSchema,
]);
export type HostNotificationKnownPayload = z.infer<
  typeof hostNotificationKnownPayloadSchema
>;
export type HostNotificationKnownPayloadKind =
  HostNotificationKnownPayload["kind"];

/**
 * Total second-stage parse: a known, well-formed payload or `null`.
 * `null` means "degrade to generic rendering" — it is never an error.
 */
export function parseKnownHostNotificationPayload(
  value: unknown,
): HostNotificationKnownPayload | null {
  const parsed = hostNotificationKnownPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Kind-coupled second-stage parse: a payload is trusted only when its shape
 * matches the enclosing notification kind (`agent.stopped` → chat | epic,
 * `agent.stalled` → agent_stalled, approval/interview → their own arm). A
 * cross-kind payload is malformed row data - it must take the generic/null
 * degradation path, not mint contradictory presentation, navigation, or
 * webhook output. Semantic consumers that know the row kind should use this
 * over `parseKnownHostNotificationPayload`.
 */
export function parseKnownHostNotificationPayloadForKind(
  notificationKind: HostNotificationKind,
  value: unknown,
): HostNotificationKnownPayload | null {
  const payload = parseKnownHostNotificationPayload(value);
  if (payload === null) {
    return null;
  }
  return payloadKindMatchesNotificationKind(notificationKind, payload.kind)
    ? payload
    : null;
}

function payloadKindMatchesNotificationKind(
  notificationKind: HostNotificationKind,
  payloadKind: HostNotificationKnownPayloadKind,
): boolean {
  switch (notificationKind) {
    case "agent.stopped":
      return payloadKind === "chat" || payloadKind === "epic";
    case "agent.stalled":
      return payloadKind === "agent_stalled";
    case "workspace.operation.failed":
      return payloadKind === "workspace_operation_failed";
    case "approval.requested":
      return payloadKind === "approval";
    case "interview.requested":
      return payloadKind === "interview";
    // One operation arm exists so far. A FUTURE operation adds its arm above
    // and its kind to this list; until a client learns that kind, its rows
    // degrade to the common-field tier rather than failing - which is the
    // property the whole payload tier exists to provide.
    case "host.operation.finished":
      return payloadKind === "worktree_deletion";
  }
}
