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

export const hostNotificationKnownPayloadSchema = z.discriminatedUnion(
  "kind",
  [
    hostNotificationChatStoppedPayloadSchema,
    hostNotificationEpicStoppedPayloadSchema,
    hostNotificationAgentStalledPayloadSchema,
    hostNotificationApprovalPayloadSchema,
    hostNotificationInterviewPayloadSchema,
  ],
);
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
