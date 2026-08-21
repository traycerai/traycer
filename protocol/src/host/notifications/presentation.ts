import {
  type HostNotificationEntryV21,
  type HostNotificationOutcome,
} from "@traycer/protocol/host/notifications/host-notifications";
import {
  deriveHostNotificationStoppedReason,
  parseHostOperationCommonPayload,
  parseKnownHostNotificationPayloadForKind,
  type HostNotificationKnownPayload,
} from "@traycer/protocol/host/notifications/payloads";
import { providerSignedOutMessage } from "@traycer/protocol/host/provider-display";
import {
  PROVIDER_DISPLAY_NAMES,
  providerIdSchema,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";

export interface HostNotificationPresentation {
  readonly title: string;
  readonly body: string;
}

/**
 * Canonical user-facing copy for one enriched host notification entry.
 *
 * The host and every renderer-facing surface consume this formatter so an
 * external delivery cannot drift from the in-app notification feed. Unknown,
 * future, cross-kind, or malformed semantic payloads degrade to the same safe
 * generic copy instead of throwing or exposing untrusted raw error text.
 */
export function formatHostNotificationPresentation(
  entry: HostNotificationEntryV21,
): HostNotificationPresentation {
  const known = parseKnownHostNotificationPayloadForKind(
    entry.kind,
    entry.payload,
  );
  const { agentName, title, agentContext } = knownPresentationContext(known);
  switch (entry.kind) {
    case "agent.stopped": {
      const context = notificationContext(agentName, title);
      const reason = known === null ? null : knownStoppedReason(known);
      const providerId = known === null ? null : knownProviderId(known);
      const backgroundWorkRunning =
        known === null ? false : knownBackgroundWorkRunning(known);
      const status = agentStoppedStatus(
        entry.outcome,
        reason,
        providerId,
        backgroundWorkRunning,
      );
      return {
        title,
        body: `${context} • ${status}`,
      };
    }
    case "agent.stalled":
      return {
        title,
        body: `${notificationContext(agentName, title)} • ${agentStalledStatus(known)}`,
      };
    case "workspace.operation.failed":
      return {
        title,
        body: `${agentContext} • ${workspaceOperationFailedStatus(known)}`,
      };
    case "approval.requested":
      return {
        title,
        body: `${agentContext} • ${resolvableRequestStatus(entry.resolvedAt, "Approval requested", "Approval resolved")}`,
      };
    case "interview.requested":
      return {
        title,
        body: `${agentContext} • ${resolvableRequestStatus(entry.resolvedAt, "Question waiting", "Question resolved")}`,
      };
    case "host.operation.finished":
      return hostOperationFinishedPresentation(
        entry.outcome,
        entry.payload,
        known,
      );
  }
}

/**
 * Three-tier degradation for a host-wide operation completion, resolved as a
 * per-FIELD fallback chain rather than a first-match-wins branch:
 *
 *  1. a KNOWN operation payload's own copy, when that arm supplies any
 *     (`hostOperationKnownCopy` - no arm supplies copy yet);
 *  2. the common `operation`/`title`/`message` convention read leniently off
 *     the open record, so an operation newer than this build still shows
 *     host-composed copy;
 *  3. generic copy, keyed only off the durable `outcome` column.
 *
 * The chain is per-field on purpose. A first-match-wins branch would let the
 * first real operation arm REGRESS a row that already renders host-composed
 * copy today: recognising the payload would swap "Deleted 3 worktrees" for
 * whatever the known branch produced. Here an arm can only ever add copy, so
 * a known payload is never worse than an unknown one - which is the property
 * that makes the tier ordering safe to activate.
 *
 * Tiers 2 and 3 are what make the frozen outer arm affordable: a future
 * operation is additive at the payload layer and never needs another outer
 * kind. Copy comes from the host, so it reaches email and hooks unchanged.
 */
function hostOperationFinishedPresentation(
  outcome: HostNotificationOutcome,
  payload: Record<string, unknown>,
  known: HostNotificationKnownPayload | null,
): HostNotificationPresentation {
  const operationCopy = known === null ? null : hostOperationKnownCopy(known);
  const common = parseHostOperationCommonPayload(payload);
  return {
    title:
      operationCopy?.title ??
      common?.title ??
      hostOperationGenericTitle(outcome),
    body:
      operationCopy?.body ??
      common?.message ??
      hostOperationGenericBody(outcome),
  };
}

/**
 * Per-operation copy for a payload arm this build fully understands, or
 * `null` to inherit the common-field/generic copy below it.
 *
 * Exhaustive over the known payload union so the first operation arm gets a
 * compile-visible slot here. Every arm that exists today is chat-scoped and
 * belongs to a different notification kind, so none of them may supply copy
 * for a host-wide row: their titles come from `taskTitle`/`chatTitle` fields
 * a host-wide operation payload does not have, and letting them answer would
 * render "Task" over the host's own composed title.
 */
export function hostOperationKnownCopy(
  payload: HostNotificationKnownPayload,
): { readonly title: string | null; readonly body: string | null } | null {
  switch (payload.kind) {
    case "chat":
    case "epic":
    case "agent_stalled":
    case "approval":
    case "interview":
    case "workspace_operation_failed":
      return null;
    // Worktree deletion supplies no copy of its own on purpose: the host
    // already composed `title`/`message` into the payload's common fields, and
    // that exact wording is what reached email and notification hooks at mint
    // time. Re-deriving it here would make the in-app row and the email
    // disagree about the same command for no gain - the arm's value is the
    // structured counts and the navigation target, not the prose.
    case "worktree_deletion":
      return null;
  }
}

function hostOperationGenericTitle(outcome: HostNotificationOutcome): string {
  return outcome === "errored"
    ? "Host operation failed"
    : "Host operation finished";
}

function hostOperationGenericBody(outcome: HostNotificationOutcome): string {
  if (outcome === "errored") return "Host operation • Failed";
  if (outcome === "stopped") return "Host operation • Stopped";
  return "Host operation • Done";
}

// The protocol records only whether an approval/interview has resolved, not
// how it resolved. Keep the canonical formatter honest and shared across the
// in-app feed and external hook deliveries.
function resolvableRequestStatus(
  resolvedAt: number | null,
  waitingLabel: string,
  resolvedLabel: string,
): string {
  return resolvedAt === null ? waitingLabel : resolvedLabel;
}

function knownPresentationContext(known: HostNotificationKnownPayload | null) {
  const agentName =
    known === null ? null : nonEmptyTitle(knownAgentName(known));
  const chatTitle =
    known === null ? null : nonEmptyTitle(knownChatTitle(known));
  const taskTitle =
    known === null ? null : nonEmptyTitle(knownTaskTitle(known));
  const title = taskTitle ?? chatTitle ?? agentName ?? "Task";
  return {
    agentName,
    title,
    agentContext:
      chatTitle !== null && chatTitle !== title ? chatTitle : "Agent",
  };
}

/**
 * The task title a chat-scoped payload carries, or `null` for a payload that
 * has no task at all.
 *
 * Read through a switch rather than off the union directly (`known.taskTitle`)
 * because host-WIDE operation payloads are not addressed to an epic/chat and
 * carry no such field. This is the compile-visible seam that stopped the first
 * host-wide arm from being modelled as "a task notification with the task
 * fields left blank".
 */
function knownTaskTitle(payload: HostNotificationKnownPayload): string | null {
  switch (payload.kind) {
    case "chat":
    case "epic":
    case "agent_stalled":
    case "approval":
    case "interview":
    case "workspace_operation_failed":
      return payload.taskTitle;
    case "worktree_deletion":
      return null;
  }
}

function knownAgentName(payload: HostNotificationKnownPayload): string | null {
  switch (payload.kind) {
    case "chat":
    case "epic":
    case "agent_stalled":
      return payload.agentName;
    case "approval":
    case "interview":
    case "workspace_operation_failed":
    case "worktree_deletion":
      return null;
  }
}

function knownChatTitle(payload: HostNotificationKnownPayload): string | null {
  switch (payload.kind) {
    case "approval":
    case "interview":
    case "workspace_operation_failed":
      return payload.chatTitle;
    case "chat":
    case "epic":
    case "agent_stalled":
    case "worktree_deletion":
      return null;
  }
}

function knownStoppedReason(
  payload: HostNotificationKnownPayload,
): string | null {
  switch (payload.kind) {
    case "chat":
    case "epic":
      return (
        payload.reason ??
        deriveHostNotificationStoppedReason(payload.code ?? null)
      );
    case "agent_stalled":
    case "approval":
    case "interview":
    case "workspace_operation_failed":
    case "worktree_deletion":
      return null;
  }
}

function knownProviderId(
  payload: HostNotificationKnownPayload,
): ProviderId | null {
  switch (payload.kind) {
    case "chat":
    case "epic": {
      const parsed = providerIdSchema.safeParse(payload.providerId);
      return parsed.success ? parsed.data : null;
    }
    case "agent_stalled":
    case "approval":
    case "interview":
    case "workspace_operation_failed":
    case "worktree_deletion":
      return null;
  }
}

function agentStoppedStatus(
  outcome: HostNotificationOutcome,
  reason: string | null,
  providerId: ProviderId | null,
  backgroundWorkRunning: boolean,
): string {
  if (outcome === "errored") {
    return agentStoppedFailureStatus(reason, providerId);
  }
  if (outcome === "stopped") return "Stopped";
  if (backgroundWorkRunning) return "Background work running";
  return "Done";
}

function knownBackgroundWorkRunning(
  payload: HostNotificationKnownPayload,
): boolean {
  switch (payload.kind) {
    case "chat":
    case "epic":
      return payload.backgroundWorkRunning === true;
    case "agent_stalled":
    case "approval":
    case "interview":
    case "workspace_operation_failed":
    case "worktree_deletion":
      return false;
  }
}

function agentStoppedFailureStatus(
  reason: string | null,
  providerId: ProviderId | null,
): string {
  switch (reason) {
    case "auth":
      return providerId === null
        ? "Provider is signed out. Reconnect to continue."
        : providerSignedOutMessage(providerId);
    case "rate_limit":
      return providerSpecificFailureStatus(
        providerId,
        "Rate limit reached",
        (providerName) => `${providerName} rate limit reached`,
      );
    case "billing":
      return providerSpecificFailureStatus(
        providerId,
        "Provider billing issue",
        (providerName) => `${providerName} billing issue`,
      );
    case "model_unavailable":
      return "Model unavailable";
    case "provider_unavailable":
      return providerSpecificFailureStatus(
        providerId,
        "Provider is temporarily unavailable",
        (providerName) => `${providerName} is temporarily unavailable`,
      );
    case "provider_connection_failed":
      return providerSpecificFailureStatus(
        providerId,
        "Provider connection failed",
        (providerName) => `Connection to ${providerName} failed`,
      );
    case "context_exhausted":
      return "Context limit reached";
    case "request_rejected":
      return providerSpecificFailureStatus(
        providerId,
        "Provider rejected the request",
        (providerName) => `${providerName} rejected the request`,
      );
    case "turn_start_timeout":
      return "Provider did not start in time";
    case "missing_terminal_event":
      return "Provider stopped responding";
    case "background_work_failed":
      return "Background work stopped";
    case null:
    default:
      return "Failed";
  }
}

function providerSpecificFailureStatus(
  providerId: ProviderId | null,
  genericStatus: string,
  providerStatus: (providerName: string) => string,
): string {
  return providerId === null
    ? genericStatus
    : providerStatus(PROVIDER_DISPLAY_NAMES[providerId]);
}

function agentStalledStatus(
  payload: HostNotificationKnownPayload | null,
): string {
  if (payload?.kind !== "agent_stalled") return "Stalled";
  switch (payload.reason) {
    case "provider_buffering":
      return "Provider is taking longer than expected";
    case "provider_reroute":
      return "Provider is rerouting";
    default:
      return "Stalled";
  }
}

function workspaceOperationFailedStatus(
  payload: HostNotificationKnownPayload | null,
): string {
  if (payload?.kind !== "workspace_operation_failed") {
    return "Workspace operation failed";
  }
  if (payload.operation === "provision") return "Worktree creation failed";
  if (payload.operation === "setup") return "Workspace setup failed";
  return "Workspace operation failed";
}

function notificationContext(agentName: string | null, title: string): string {
  if (agentName !== null && agentName !== title) return agentName;
  return "Agent";
}

function nonEmptyTitle(value: string | null): string | null {
  return value !== null && value.length > 0 ? value : null;
}
