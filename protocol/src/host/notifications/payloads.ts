/**
 * Semantic payload schemas for `HostNotifications.json_data` — the single
 * source of truth for what host producers write into a notification row's
 * payload and what consumers (renderer presentation/navigation, webhook
 * projection, retitle convergence) may rely on.
 *
 * These schemas are a SECOND-STAGE parse, never a transport gate. The wire
 * entry (`hostNotificationEntrySchema`) and SQLite persistence keep the
 * payload an open record on purpose: rows outlive code in both directions
 * (upgrades read old rows, downgrades read future rows), so the
 * compatibility boundary must accept unknown shapes and let consumers
 * degrade per row instead of dropping or failing a frame.
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
      return "provider_connection_failed";
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
    agentName: z.string(),
    taskTitle: z.string(),
    outcome: hostNotificationOutcomeSchema,
    code: z.string().optional(),
    message: z.string().optional(),
    reason: z.string().optional(),
    providerId: z.string().optional(),
  })
  .catchall(z.unknown());
export type HostNotificationChatStoppedPayload = z.infer<
  typeof hostNotificationChatStoppedPayloadSchema
>;

/**
 * TUI `agent.stopped` payload: the "epic" shape. `agentName` is the
 * terminal-agent name — NOT a chat title; these rows carry no chat binding.
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

export const hostNotificationKnownPayloadSchema = z.discriminatedUnion("kind", [
  hostNotificationChatStoppedPayloadSchema,
  hostNotificationEpicStoppedPayloadSchema,
  hostNotificationAgentStalledPayloadSchema,
  hostNotificationWorkspaceOperationFailedPayloadSchema,
  hostNotificationApprovalPayloadSchema,
  hostNotificationInterviewPayloadSchema,
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
  }
}

/**
 * The chat-title capability map, as an exhaustive function shared by payload
 * producers and the retitle convergence write: for each known payload kind,
 * returns the payload with its chat-title-bearing field replaced, or `null`
 * when the payload carries no chat title ("epic" rows name a terminal
 * agent) or already holds the given title (a no-op the caller must not
 * persist or emit). Adding a payload kind fails compilation here until the
 * new kind declares whether it carries a chat title.
 */
export function hostNotificationPayloadWithChatTitle(
  payload: HostNotificationKnownPayload,
  chatTitle: string,
): HostNotificationKnownPayload | null {
  switch (payload.kind) {
    case "approval":
    case "interview":
    case "workspace_operation_failed":
      return payload.chatTitle === chatTitle ? null : { ...payload, chatTitle };
    case "chat":
    case "agent_stalled":
      return payload.agentName === chatTitle
        ? null
        : { ...payload, agentName: chatTitle };
    case "epic":
      return null;
  }
}
