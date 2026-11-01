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
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/** Identifier fields must be non-empty: an empty id is a malformed row, and
 * letting it through would mint an unusable deep-link instead of degrading. */
const idSchema = lazySchema(() => z.string().min(1));

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
  "session_budget",
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
      return "rate_limit";
    // Its own reason rather than joining the two above, and it is worth saying
    // why each of the three neighbouring answers is wrong.
    //
    // Codex emits it with "Start a new session or compact the conversation,
    // then try again" - a SESSION-local stop, whose remedy is a fresh session
    // on the SAME account. Calling it `rate_limit` made it fallback-eligible
    // (`REASON_ELIGIBLE_RUNGS.rate_limit` admits profile, tier and wait), so a
    // budget stop could automatically relaunch the turn on a DIFFERENT account
    // that was never the problem - and the rate-limit branch of
    // `buildTurnFailurePayload` reads an existing gauge, so it could also hand
    // this failure an unrelated window's `resetsAt` and offer a wait on it.
    //
    // It is not `context_exhausted` either: "budget" is ambiguous between spend
    // and context, and we have not established which Codex means. The name here
    // deliberately claims neither - it repeats the provider's own noun, scoped
    // to the session it is about.
    //
    // And it is not `null`. Declining to classify does stop the switching, but
    // a turn with no typed failure gets no failed-attempt envelope
    // (`preserveFallbackFailedAttemptEnvelope` returns at an absent `failure`).
    // Its error card still offers `retry` and `switch` - and a fresh session is
    // exactly what `retry` performs - but it loses `wait_once` (its wait
    // disposition is `attempt_unavailable`) and names no `failedTuple`, the
    // replay facts the envelope carries. Classifying it is what gives this
    // failure its envelope, so the wait and those facts exist. What actually
    // stops the automatic traversal is `EXCLUDED_FALLBACK_REASONS`, which this
    // reason is in.
    case "session_budget_exceeded":
      return "session_budget";
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
export const hostNotificationChatStoppedPayloadSchema = lazySchema(() =>
  z
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
      /** Present only on a completed turn the provider paused before verification. */
      unverified: z.literal(true).optional(),
    })
    .catchall(z.unknown()),
);
export type HostNotificationChatStoppedPayload = z.infer<
  typeof hostNotificationChatStoppedPayloadSchema
>;

/**
 * TUI `agent.stopped` payload: the "epic" shape. `agentName` is the
 * terminal-agent name — NOT a chat title. The row itself is chat-scoped to
 * `tuiAgentId` (hosts minted these rows without a chat binding before that
 * change, so entries from older rows may still carry a null `chatId`).
 */
export const hostNotificationEpicStoppedPayloadSchema = lazySchema(() =>
  z
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
    .catchall(z.unknown()),
);
export type HostNotificationEpicStoppedPayload = z.infer<
  typeof hostNotificationEpicStoppedPayloadSchema
>;

/**
 * `agent.stalled` payload. `agentName` carries the chat title. `reason` is
 * deliberately an open string (not a closed enum) so a future stall reason
 * degrades to generic copy instead of failing the parse.
 */
export const hostNotificationAgentStalledPayloadSchema = lazySchema(() =>
  z
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
    .catchall(z.unknown()),
);
export type HostNotificationAgentStalledPayload = z.infer<
  typeof hostNotificationAgentStalledPayloadSchema
>;

/**
 * `workspace.operation.failed` payload. `operation` stays open so a newer host
 * can add workspace lifecycle operations without making an older renderer drop
 * the row's typed chat navigation and generic failure presentation.
 */
export const hostNotificationWorkspaceOperationFailedPayloadSchema = lazySchema(
  () =>
    z
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
      .catchall(z.unknown()),
);
export type HostNotificationWorkspaceOperationFailedPayload = z.infer<
  typeof hostNotificationWorkspaceOperationFailedPayloadSchema
>;

/** `approval.requested` payload. `chatTitle` carries the chat title. */
export const hostNotificationApprovalPayloadSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal("approval"),
      epicId: idSchema,
      chatId: idSchema,
      chatTitle: z.string(),
      taskTitle: z.string(),
      approvalId: idSchema,
    })
    .catchall(z.unknown()),
);
export type HostNotificationApprovalPayload = z.infer<
  typeof hostNotificationApprovalPayloadSchema
>;

/** `interview.requested` payload. `chatTitle` carries the chat title. */
export const hostNotificationInterviewPayloadSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal("interview"),
      epicId: idSchema,
      chatId: idSchema,
      chatTitle: z.string(),
      taskTitle: z.string(),
      interviewBlockId: idSchema,
    })
    .catchall(z.unknown()),
);
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
export const hostOperationCommonPayloadSchema = lazySchema(() =>
  z
    .object({
      operation: idSchema,
      title: z.string().min(1),
      message: z.string().min(1),
    })
    .catchall(z.unknown()),
);
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
 * The `operation` identifier of a bot's answer to a person's post, minted
 * once per participant. An unread one needs the person's attention: it is the
 * answer they asked for, so it counts in the bell's number beside prompts and
 * failures, as its own class after both.
 */
export const HOST_OPERATION_BOT_THREAD_VERDICT = "bot.thread.verdict";

/**
 * Whether a notification is a bot's answer: a `host.operation.finished` row
 * whose payload names {@link HOST_OPERATION_BOT_THREAD_VERDICT}. Reads the
 * payload as the open record it is on the wire, so a row of any version
 * answers the same way.
 */
export function isBotThreadVerdictNotification(entry: {
  readonly kind: string;
  readonly payload: unknown;
}): boolean {
  const payload = entry.payload;
  return (
    entry.kind === "host.operation.finished" &&
    typeof payload === "object" &&
    payload !== null &&
    "operation" in payload &&
    payload.operation === HOST_OPERATION_BOT_THREAD_VERDICT
  );
}

/** The `operation` of a reply in a bot's thread. */
export const HOST_OPERATION_BOT_REPLY = "bot.reply";

/** The payload `kind` of a row a bot's conversation wrote to a person's mailbox. */
export const BOT_CONVERSATION_NOTIFICATION_PAYLOAD_KIND = "bot_conversation";

/**
 * The rest of a bot's rows that need the person's attention (decision 138):
 * a reply in a bot's thread they follow, and a row that mentions them,
 * whatever its level. Both are minted `done`, so no severity admits them;
 * they count in the bell's number and list with the bot's answers. A post or
 * announcement that names no one does not count. Reads the payload as the
 * open record it is on the wire, as {@link isBotThreadVerdictNotification}
 * does; whether the row is unread is the caller's, as it is there.
 */
export function isBotConversationAttention(entry: {
  readonly kind: string;
  readonly payload: unknown;
}): boolean {
  const payload = entry.payload;
  if (
    entry.kind !== "host.operation.finished" ||
    typeof payload !== "object" ||
    payload === null
  ) {
    return false;
  }
  if (
    "operation" in payload &&
    payload.operation === HOST_OPERATION_BOT_REPLY
  ) {
    return true;
  }
  return (
    "kind" in payload &&
    payload.kind === BOT_CONVERSATION_NOTIFICATION_PAYLOAD_KIND &&
    "mention" in payload &&
    payload.mention === true
  );
}

/**
 * `host.operation.finished` payload of a bot's answer as a host writes it
 * to each participant (T78): opens the bot's thread on the answer. Its copy
 * is the common `title`/`message`, which the bell already reads.
 */
export const hostNotificationBotThreadVerdictPayloadSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal("bot_thread_verdict"),
      operation: z.literal(HOST_OPERATION_BOT_THREAD_VERDICT),
      title: z.string(),
      message: z.string(),
      botId: idSchema,
      threadId: idSchema,
      replyMessageId: idSchema,
    })
    .catchall(z.unknown()),
);
export type HostNotificationBotThreadVerdictPayload = z.infer<
  typeof hostNotificationBotThreadVerdictPayloadSchema
>;

/**
 * `host.operation.finished` payload of a row a bot's conversation wrote to
 * a person's mailbox (decision 136): a post, reply, answer, question or
 * mention, which opens the bot's channel or thread on that row. Its copy is
 * the common `title`/`message`.
 */
export const hostNotificationBotConversationPayloadSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal(BOT_CONVERSATION_NOTIFICATION_PAYLOAD_KIND),
      event: z.string().min(1),
      operation: z.string().min(1),
      title: z.string(),
      message: z.string(),
      botId: idSchema,
      conversationId: idSchema,
      threadId: idSchema.nullable(),
      messageId: idSchema,
      authorUserId: idSchema.nullable(),
      mention: z.boolean(),
    })
    .catchall(z.unknown()),
);
export type HostNotificationBotConversationPayload = z.infer<
  typeof hostNotificationBotConversationPayloadSchema
>;

export const HOST_NOTIFICATION_WORKTREE_DELETION_FAILURE_KINDS = [
  "busy",
  "not_managed",
  "teardown_failed",
  "removal_failed",
] as const;
export const hostNotificationWorktreeDeletionFailureKindSchema = lazySchema(
  () => z.enum(HOST_NOTIFICATION_WORKTREE_DELETION_FAILURE_KINDS),
);
export type HostNotificationWorktreeDeletionFailureKind = z.infer<
  typeof hostNotificationWorktreeDeletionFailureKindSchema
>;

const hostNotificationWorktreeDeletionFailureCountSchema = lazySchema(() =>
  z.number().int().positive(),
);

/**
 * Known failure counts, represented as an object with optional known keys
 * instead of an enum-keyed `z.record`. Besides making partial aggregates
 * natural, `z.object` strips unknown keys by default: a future host can add a
 * category without making an older client reject the entire durable payload.
 */
export const hostNotificationWorktreeDeletionFailureKindsSchema = lazySchema(
  () =>
    z.object({
      busy: hostNotificationWorktreeDeletionFailureCountSchema.optional(),
      not_managed:
        hostNotificationWorktreeDeletionFailureCountSchema.optional(),
      teardown_failed:
        hostNotificationWorktreeDeletionFailureCountSchema.optional(),
      removal_failed:
        hostNotificationWorktreeDeletionFailureCountSchema.optional(),
    }),
);
export type HostNotificationWorktreeDeletionFailureKinds = z.infer<
  typeof hostNotificationWorktreeDeletionFailureKindsSchema
>;

/**
 * `host.operation.finished` for a worktree deletion: The host no longer writes this operation; readers drop it.
 */
export const hostNotificationWorktreeDeletionPayloadSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal("worktree_deletion"),
      operation: z.literal(HOST_OPERATION_WORKTREE_DELETION),
      title: z.string().min(1),
      message: z.string().min(1),
      commandId: idSchema,
      /** Open string, not the wire enum: a row minted by a newer host with a
       * source this build has never heard of must still render and route. */
      source: idSchema,
      /** Task that initiated a single-Task sweep. */
      epicId: idSchema.optional(),
      /** Read-time title for a single-Task sweep. */
      taskTitle: z.string().optional(),
      requestedCount: z.number().int().nonnegative(),
      deletedCount: z.number().int().nonnegative(),
      failedCount: z.number().int().nonnegative(),
      /** Optional for rows minted before failure categorization existed. */
      failureKinds:
        hostNotificationWorktreeDeletionFailureKindsSchema.optional(),
    })
    .catchall(z.unknown()),
);
export type HostNotificationWorktreeDeletionPayload = z.infer<
  typeof hostNotificationWorktreeDeletionPayloadSchema
>;

/**
 * The `operation` identifier of the automatic worktree-cleanup scheduler.
 *
 * Distinct from `worktree.deletion` on purpose: that operation is a deletion
 * the user asked for and is waiting on, this one is an unattended background
 * pass they authorized once. They differ in severity (this arm is always
 * informational, including for failures - the detail lives in cleanup history),
 * in addressing (per RUN, not per command), and in cadence, so collapsing them
 * into one operation would make both harder to reason about.
 */
export const HOST_OPERATION_WORKTREE_AUTO_CLEANUP = "worktree.autoCleanup";

/**
 * `host.operation.finished` for an automatic cleanup run: The host no longer writes this operation; readers drop it.
 */
export const hostNotificationWorktreeAutoCleanupPayloadSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal("worktree_auto_cleanup"),
      operation: z.literal(HOST_OPERATION_WORKTREE_AUTO_CLEANUP),
      title: z.string().min(1),
      message: z.string().min(1),
      runId: idSchema,
      hostId: idSchema,
      deletedCount: z.number().int().nonnegative(),
      skippedCount: z.number().int().nonnegative(),
      failedCount: z.number().int().nonnegative(),
      interruptedCount: z.number().int().nonnegative(),
    })
    .catchall(z.unknown()),
);
export type HostNotificationWorktreeAutoCleanupPayload = z.infer<
  typeof hostNotificationWorktreeAutoCleanupPayloadSchema
>;

/**
 * The `operation` identifier of a shell-output delivery the host parked
 * because the chat could not start a turn to receive it.
 */
export const HOST_OPERATION_MANAGED_COMMAND_DELIVERY =
  "managed-command.delivery";

/**
 * `host.operation.finished` payload for a parked shell-output delivery.
 *
 * Chat-scoped: the chat's queue is paused and the remedy lives in that chat,
 * so `epicId`/`chatId` are what the row routes to. Rows minted before these
 * fields existed fail this arm and keep the common-field tier - host copy,
 * no deep link.
 */
export const hostNotificationManagedCommandDeliveryParkedPayloadSchema =
  lazySchema(() =>
    z
      .object({
        kind: z.literal("managed_command_delivery_parked"),
        operation: z.literal(HOST_OPERATION_MANAGED_COMMAND_DELIVERY),
        title: z.string().min(1),
        message: z.string().min(1),
        commandId: idSchema,
        epicId: idSchema,
        chatId: idSchema,
      })
      .catchall(z.unknown()),
  );
export type HostNotificationManagedCommandDeliveryParkedPayload = z.infer<
  typeof hostNotificationManagedCommandDeliveryParkedPayloadSchema
>;

/**
 * `browser.human.needed` payload: the parked session's tile plus the agent's
 * own reason for parking.
 *
 * `reason` is model-authored prose and is the only copy this row has, so it is
 * rendered as the body and never as a title or an identifier. `sessionId` and
 * `tabId` address the tile the click deep-links to; they are host-local by
 * construction (browser sessions never move hosts), so the row's originHostId
 * is what says where to open it.
 */
export const hostNotificationBrowserHumanNeededPayloadSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal("browser_human_needed"),
      epicId: idSchema,
      chatId: idSchema,
      sessionId: idSchema,
      tabId: idSchema,
      reason: z.string().min(1),
    })
    .catchall(z.unknown()),
);
export type HostNotificationBrowserHumanNeededPayload = z.infer<
  typeof hostNotificationBrowserHumanNeededPayloadSchema
>;

/**
 * `secret.grant.requested` payload: what an agent on a sandbox asked for.
 *
 * `requestId` is the broker's id for the request and the only thing a decision
 * is posted against; `hostId` is the sandbox the grant would be for, which is
 * not necessarily the host that relays the row. The request names a secret, a
 * destination, or both, so each is nullable on its own and the card shows what
 * it has. `secretName` is the secret's NAME - no value is ever in a
 * notification. `reason` is model-authored prose: rendered as body text, never
 * as a title or an identifier.
 *
 * `epicId`/`chatId` address the asking agent's chat when it has one, for the
 * deep link; an agent outside a chat leaves them out.
 *
 * `environmentId` is the environment the request is decided in: null (or left
 * out by a host that predates it) resolves Personal. `teamName` names a team
 * environment's team (null or absent for Personal). Once the row resolves,
 * `decision` carries the request's final status (known: approved,
 * approved_default, declined, expired).
 */
export const hostNotificationSecretGrantRequestPayloadSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal("secret_grant_request"),
      requestId: idSchema,
      hostId: idSchema,
      secretName: z.string().min(1).nullable(),
      destination: z.string().min(1).nullable(),
      port: z.number().int().positive().nullable().optional(),
      protocol: z.string().min(1).nullable(),
      reason: z.string(),
      sandboxName: z.string().optional(),
      agentId: z.string().min(1).nullable().optional(),
      environmentId: idSchema.nullable().optional(),
      teamName: z.string().nullable().optional(),
      decision: z.string().min(1).nullable().optional(),
      decidedBy: z.string().min(1).nullable().optional(),
      epicId: idSchema.optional(),
      chatId: idSchema.optional(),
    })
    .catchall(z.unknown()),
);
export type HostNotificationSecretGrantRequestPayload = z.infer<
  typeof hostNotificationSecretGrantRequestPayloadSchema
>;

/** What `traycer_secret_export` can mint. */
export const HOST_NOTIFICATION_SECRET_EXPORT_KINDS = [
  "presigned_url",
  "short_lived_credentials",
] as const;
export type HostNotificationSecretExportKind =
  (typeof HOST_NOTIFICATION_SECRET_EXPORT_KINDS)[number];

/**
 * `secret.export.minted`: The server no longer writes this kind; readers drop
 * it.
 */
export const hostNotificationSecretExportMintedPayloadSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal("secret_export_minted"),
      secretName: z.string().min(1),
      exportKind: z.string().min(1),
      expiresAt: z.number().int().nonnegative(),
      hostId: idSchema,
      agentId: z.string().min(1).nullable().optional(),
      epicId: idSchema.optional(),
      chatId: idSchema.optional(),
    })
    .catchall(z.unknown()),
);
export type HostNotificationSecretExportMintedPayload = z.infer<
  typeof hostNotificationSecretExportMintedPayloadSchema
>;

/** The rotation states a `secret.rotated` row knows how to word. */
export const HOST_NOTIFICATION_SECRET_ROTATION_STATES = [
  "accepted",
  "enforcing",
  "stalled",
  "enforced",
  "failed",
] as const;

/** The producer statuses a `secret.rotated` row knows how to word. */
export const HOST_NOTIFICATION_ROTATION_PRODUCER_STATUSES = [
  "acknowledged",
  "missing",
  "contained_by_expiry",
  "applies_on_resume",
] as const;

/** The evidence kinds of a `rotation_ack` receipt (the rotation wire). */
export const HOST_NOTIFICATION_ROTATION_EVIDENCE_KINDS = [
  "session_closed",
  "cache_cleared",
  "probe_refused",
] as const;

/**
 * One evidence entry as a notification carries it: `kind` read as a string,
 * so an evidence kind newer than this build still parses (and is simply not
 * counted as proof by a client that does not know it); `count` null where the
 * rotation wire's Evidence row allows it.
 */
export const hostNotificationRotationEvidenceSchema = lazySchema(() =>
  z
    .object({
      kind: z.string().min(1),
      count: z.number().int().nonnegative().nullable(),
    })
    .catchall(z.unknown()),
);
export type HostNotificationRotationEvidence = z.infer<
  typeof hostNotificationRotationEvidenceSchema
>;

/**
 * One producer that owed a `rotation_ack`: a gateway worker of a class, or a
 * host. `status` is read as a string with the known values above:
 * `contained_by_expiry` is an incarnation whose authorization provably ceased
 * (it supplies no count), `applies_on_resume` a host the rotation was not
 * delivered to. `evidence` is the receipt's entries, null without a receipt.
 */
export const hostNotificationRotationProducerSchema = lazySchema(() =>
  z
    .object({
      producer: z.string().min(1),
      workerClass: z.string().min(1).nullable(),
      hostId: z.string().min(1).nullable(),
      hostName: z.string().nullable(),
      status: z.string().min(1),
      evidence: z.array(hostNotificationRotationEvidenceSchema).nullable(),
    })
    .catchall(z.unknown()),
);
export type HostNotificationRotationProducer = z.infer<
  typeof hostNotificationRotationProducerSchema
>;

/** `secret.rotated`: The server no longer writes this kind; readers drop it. */
export const hostNotificationSecretRotatedPayloadSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal("secret_rotated"),
      secretName: z.string().min(1),
      secretId: z.string().min(1).nullable(),
      environmentId: idSchema,
      rotationId: z.string().min(1),
      state: z.string().min(1),
      evidence: z.array(hostNotificationRotationProducerSchema),
    })
    .catchall(z.unknown()),
);
export type HostNotificationSecretRotatedPayload = z.infer<
  typeof hostNotificationSecretRotatedPayloadSchema
>;

/** Whether one removal fact has arrived for a host. */
export const HOST_NOTIFICATION_REMOVAL_FACT_STATES = [
  "pending",
  "done",
] as const;

/**
 * One host's three removal facts (the flows' "stopped, old credential closed,
 * replacement delivered"), each pending until its receipt arrives.
 */
export const hostNotificationRemovalHostSchema = lazySchema(() =>
  z
    .object({
      hostId: z.string().min(1),
      hostName: z.string(),
      stopped: z.string().min(1),
      credentialClosed: z.string().min(1),
      replacementDelivered: z.string().min(1),
    })
    .catchall(z.unknown()),
);
export type HostNotificationRemovalHost = z.infer<
  typeof hostNotificationRemovalHostSchema
>;

/**
 * `team.member.removed`: The server no longer writes this kind; readers drop it.
 */
export const hostNotificationTeamMemberRemovedPayloadSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal("team_member_removed"),
      environmentId: idSchema,
      teamName: z.string(),
      memberName: z.string(),
      hosts: z.array(hostNotificationRemovalHostSchema),
      receiptId: idSchema.nullable().optional(),
      toRemovedMember: z.boolean().optional(),
    })
    .catchall(z.unknown()),
);
export type HostNotificationTeamMemberRemovedPayload = z.infer<
  typeof hostNotificationTeamMemberRemovedPayloadSchema
>;

/**
 * `team.member.joined`: The server no longer writes this kind; readers drop it.
 */
export const hostNotificationTeamMemberJoinedPayloadSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal("team_member_joined"),
      environmentId: idSchema,
      teamName: z.string(),
      memberName: z.string(),
      toNewcomer: z.boolean(),
      role: z.string().min(1).optional(),
    })
    .catchall(z.unknown()),
);
export type HostNotificationTeamMemberJoinedPayload = z.infer<
  typeof hostNotificationTeamMemberJoinedPayloadSchema
>;

/**
 * `team.policy.unapplied`: The server no longer writes this kind; readers drop it.
 */
export const hostNotificationTeamPolicyUnappliedPayloadSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal("team_policy_unapplied"),
      environmentId: idSchema,
      teamName: z.string(),
      policyVersion: z.number().int().nonnegative(),
    })
    .catchall(z.unknown()),
);
export type HostNotificationTeamPolicyUnappliedPayload = z.infer<
  typeof hostNotificationTeamPolicyUnappliedPayloadSchema
>;

/**
 * `team.policy.authority_expired`: The server no longer writes this kind; readers drop it.
 */
export const hostNotificationTeamPolicyAuthorityExpiredPayloadSchema =
  lazySchema(() =>
    z
      .object({
        kind: z.literal("team_policy_authority_expired"),
        environmentId: idSchema,
        teamName: z.string(),
        hostId: z.string().min(1),
        hostName: z.string(),
      })
      .catchall(z.unknown()),
  );
export type HostNotificationTeamPolicyAuthorityExpiredPayload = z.infer<
  typeof hostNotificationTeamPolicyAuthorityExpiredPayloadSchema
>;

/** Why the team lost its installing admin. */
export const HOST_NOTIFICATION_INSTALLING_ADMIN_GONE_REASONS = [
  "left",
  "demoted",
  "unlinked",
] as const;

/**
 * `team.installing_admin.gone`: The server no longer writes this kind; readers drop it.
 */
export const hostNotificationTeamInstallingAdminGonePayloadSchema = lazySchema(
  () =>
    z
      .object({
        kind: z.literal("team_installing_admin_gone"),
        environmentId: idSchema,
        teamName: z.string(),
        adminName: z.string(),
        reason: z.string().min(1),
      })
      .catchall(z.unknown()),
);
export type HostNotificationTeamInstallingAdminGonePayload = z.infer<
  typeof hostNotificationTeamInstallingAdminGonePayloadSchema
>;

/**
 * `team.plan.unlinked`: The server no longer writes this kind; readers drop it.
 */
export const hostNotificationTeamPlanUnlinkedPayloadSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal("team_plan_unlinked"),
      environmentId: idSchema,
      teamName: z.string(),
    })
    .catchall(z.unknown()),
);
export type HostNotificationTeamPlanUnlinkedPayload = z.infer<
  typeof hostNotificationTeamPlanUnlinkedPayloadSchema
>;

/** `team.pods.full`: The server no longer writes this kind; readers drop it. */
export const hostNotificationTeamPodsFullPayloadSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal("team_pods_full"),
      environmentId: idSchema,
      teamName: z.string(),
      podCount: z.number().int().nonnegative(),
    })
    .catchall(z.unknown()),
);
export type HostNotificationTeamPodsFullPayload = z.infer<
  typeof hostNotificationTeamPodsFullPayloadSchema
>;

/**
 * `environment.move.stalled`: The server no longer writes this kind; readers drop it.
 */
export const hostNotificationEnvironmentMoveStalledPayloadSchema = lazySchema(
  () =>
    z
      .object({
        kind: z.literal("environment_move_stalled"),
        environmentId: idSchema,
        hostId: z.string().min(1),
        hostName: z.string(),
        remaining: z.number().int().nonnegative(),
        reason: z.string().min(1),
      })
      .catchall(z.unknown()),
);
export type HostNotificationEnvironmentMoveStalledPayload = z.infer<
  typeof hostNotificationEnvironmentMoveStalledPayloadSchema
>;

/** `environment.apply.failed`: The server no longer writes this kind; readers drop it. */
export const hostNotificationEnvironmentApplyFailedPayloadSchema = lazySchema(
  () =>
    z
      .object({
        kind: z.literal("environment_apply_failed"),
        environmentId: idSchema,
        hostId: z.string().min(1),
        hostName: z.string(),
        itemKey: z.string().min(1),
        reason: z.string().min(1),
        sandbox: z
          .object({
            sandboxId: z.string().min(1).nullable().optional(),
            operationId: z.string().min(1).nullable().optional(),
            name: z.string(),
            configurationName: z.string(),
            attemptId: z.string(),
            applied: z.array(z.string()),
            notApplied: z.array(z.string()),
          })
          .nullable()
          .optional(),
      })
      .catchall(z.unknown()),
);
export type HostNotificationEnvironmentApplyFailedPayload = z.infer<
  typeof hostNotificationEnvironmentApplyFailedPayloadSchema
>;

/**
 * `team.role.changed`: a member's own role moved. The notification center
 * carries agent states only, and this is its one named exception — a member is
 * told their role changed the way a task's collaborators are told theirs did —
 * so the server writes it and readers show it. It announces itself nowhere:
 * no toast, no chime, no push.
 */
export const hostNotificationTeamRoleChangedPayloadSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal("team_role_changed"),
      environmentId: idSchema,
      teamName: z.string(),
      from: z.string().min(1),
      to: z.string().min(1),
    })
    .catchall(z.unknown()),
);
export type HostNotificationTeamRoleChangedPayload = z.infer<
  typeof hostNotificationTeamRoleChangedPayloadSchema
>;

/**
 * `team.host.returned`: The server no longer writes this kind; readers drop it.
 */
export const hostNotificationTeamHostReturnedPayloadSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal("team_host_returned"),
      environmentId: idSchema,
      teamName: z.string(),
      hostName: z.string(),
    })
    .catchall(z.unknown()),
);
export type HostNotificationTeamHostReturnedPayload = z.infer<
  typeof hostNotificationTeamHostReturnedPayloadSchema
>;

/** `secret.removed`: The server no longer writes this kind; readers drop it. */
export const hostNotificationSecretRemovedPayloadSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal("secret_removed"),
      environmentId: idSchema,
      secretName: z.string(),
      outcome: z.enum(["revoked", "cleanup_requested", "destroyed"]),
    })
    .catchall(z.unknown()),
);
export type HostNotificationSecretRemovedPayload = z.infer<
  typeof hostNotificationSecretRemovedPayloadSchema
>;

/** The `sandbox.notice` payload's notice. The server no longer writes this kind; readers drop it. */
export const hostNotificationSandboxNoticeSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("resting_warning"),
      destroyAt: z.number().int().nonnegative(),
      periodMinutes: z.number().int().positive(),
    }),
    z.object({ kind: z.literal("resting_destroyed") }),
    z.object({
      kind: z.literal("frozen"),
      cause: z.enum(["credits", "payer_removed"]),
    }),
    z.object({
      kind: z.literal("frozen_warning"),
      daysLeft: z.number().int().positive(),
    }),
    z.object({ kind: z.literal("frozen_deleting") }),
    z.object({ kind: z.literal("frozen_destroyed") }),
    z.object({ kind: z.literal("create_failed") }),
    z.object({ kind: z.literal("lost") }),
    z.object({
      kind: z.literal("destroyed_by_member"),
      actorName: z.string().nullable(),
      destroyedAt: z.number().int().nonnegative().optional(),
      stoppedAgentTaskTitles: z.array(z.string()).optional(),
    }),
    z.object({
      kind: z.literal("manual_rest"),
      verb: z.enum(["suspend", "stop"]),
      outcome: z.enum(["confirmed", "failed"]),
      byYou: z.boolean(),
      actorName: z.string().nullable(),
      confirmedAt: z.number().int().nonnegative().optional(),
    }),
  ]),
);
export type HostNotificationSandboxNotice = z.infer<
  typeof hostNotificationSandboxNoticeSchema
>;

/** `sandbox.notice`: The server no longer writes this kind; readers drop it. */
export const hostNotificationSandboxNoticePayloadSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal("sandbox_notice"),
      sandboxId: idSchema,
      sandboxName: z.string(),
      notice: hostNotificationSandboxNoticeSchema,
    })
    .catchall(z.unknown()),
);
export type HostNotificationSandboxNoticePayload = z.infer<
  typeof hostNotificationSandboxNoticePayloadSchema
>;

/**
 * `notification.hooks.removed`: The server no longer writes this kind; readers
 * drop it. No hook identity, configuration, URL or header may ride a removal
 * notice.
 */
export const hostNotificationHooksRemovedPayloadSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal("notification_hooks_removed"),
      hostId: idSchema,
      hostName: z.string(),
      count: z.number().int().positive(),
    })
    .strict(),
);
export type HostNotificationHooksRemovedPayload = z.infer<
  typeof hostNotificationHooksRemovedPayloadSchema
>;

export const hostNotificationKnownPayloadSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    hostNotificationChatStoppedPayloadSchema,
    hostNotificationEpicStoppedPayloadSchema,
    hostNotificationAgentStalledPayloadSchema,
    hostNotificationWorkspaceOperationFailedPayloadSchema,
    hostNotificationApprovalPayloadSchema,
    hostNotificationInterviewPayloadSchema,
    hostNotificationWorktreeDeletionPayloadSchema,
    hostNotificationWorktreeAutoCleanupPayloadSchema,
    hostNotificationManagedCommandDeliveryParkedPayloadSchema,
    hostNotificationBotThreadVerdictPayloadSchema,
    hostNotificationBotConversationPayloadSchema,
    hostNotificationBrowserHumanNeededPayloadSchema,
    hostNotificationSecretGrantRequestPayloadSchema,
    hostNotificationSecretExportMintedPayloadSchema,
    hostNotificationSecretRotatedPayloadSchema,
    hostNotificationTeamMemberRemovedPayloadSchema,
    hostNotificationTeamMemberJoinedPayloadSchema,
    hostNotificationTeamPolicyUnappliedPayloadSchema,
    hostNotificationTeamPolicyAuthorityExpiredPayloadSchema,
    hostNotificationTeamInstallingAdminGonePayloadSchema,
    hostNotificationTeamPlanUnlinkedPayloadSchema,
    hostNotificationTeamPodsFullPayloadSchema,
    hostNotificationEnvironmentMoveStalledPayloadSchema,
    hostNotificationEnvironmentApplyFailedPayloadSchema,
    hostNotificationTeamRoleChangedPayloadSchema,
    hostNotificationTeamHostReturnedPayloadSchema,
    hostNotificationSecretRemovedPayloadSchema,
    hostNotificationSandboxNoticePayloadSchema,
    hostNotificationHooksRemovedPayloadSchema,
  ]),
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
    case "workspace.operation.failed":
      return payloadKind === "workspace_operation_failed";
    case "approval.requested":
      return payloadKind === "approval";
    case "interview.requested":
      return payloadKind === "interview";
    // A FUTURE operation adds its arm above and its kind to this list; until a
    // client learns that kind, its rows degrade to the common-field tier
    // rather than failing - which is the property the whole payload tier
    // exists to provide.
    case "host.operation.finished":
      return (
        payloadKind === "worktree_deletion" ||
        payloadKind === "worktree_auto_cleanup" ||
        payloadKind === "managed_command_delivery_parked" ||
        payloadKind === "bot_thread_verdict" ||
        payloadKind === "bot_conversation"
      );
    case "browser.human.needed":
      return payloadKind === "browser_human_needed";
    case "secret.grant.requested":
      return payloadKind === "secret_grant_request";
    case "secret.export.minted":
      return payloadKind === "secret_export_minted";
    case "secret.rotated":
      return payloadKind === "secret_rotated";
    case "team.member.removed":
      return payloadKind === "team_member_removed";
    case "team.member.joined":
      return payloadKind === "team_member_joined";
    case "team.policy.unapplied":
      return payloadKind === "team_policy_unapplied";
    case "team.policy.authority_expired":
      return payloadKind === "team_policy_authority_expired";
    case "team.installing_admin.gone":
      return payloadKind === "team_installing_admin_gone";
    case "team.plan.unlinked":
      return payloadKind === "team_plan_unlinked";
    case "team.pods.full":
      return payloadKind === "team_pods_full";
    case "environment.move.stalled":
      return payloadKind === "environment_move_stalled";
    case "environment.apply.failed":
      return payloadKind === "environment_apply_failed";
    case "team.role.changed":
      return payloadKind === "team_role_changed";
    case "team.host.returned":
      return payloadKind === "team_host_returned";
    case "secret.removed":
      return payloadKind === "secret_removed";
    case "sandbox.notice":
      return payloadKind === "sandbox_notice";
    case "notification.hooks.removed":
      return payloadKind === "notification_hooks_removed";
  }
}
