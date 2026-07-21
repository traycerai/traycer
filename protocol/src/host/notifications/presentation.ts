import {
  type HostNotificationEntry,
  type HostNotificationOutcome,
} from "@traycer/protocol/host/notifications/host-notifications";
import {
  deriveHostNotificationStoppedReason,
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
  entry: HostNotificationEntry,
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
      return {
        title,
        body: `${context} • ${agentStoppedStatus(entry.outcome, reason, providerId)}`,
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
      return { title, body: `${agentContext} • Approval requested` };
    case "interview.requested":
      return { title, body: `${agentContext} • Question waiting` };
  }
}

function knownPresentationContext(known: HostNotificationKnownPayload | null) {
  const agentName =
    known === null ? null : nonEmptyTitle(knownAgentName(known));
  const chatTitle =
    known === null ? null : nonEmptyTitle(knownChatTitle(known));
  const taskTitle = known === null ? null : nonEmptyTitle(known.taskTitle);
  const title = taskTitle ?? chatTitle ?? agentName ?? "Task";
  return {
    agentName,
    title,
    agentContext: chatTitle !== null && chatTitle !== title ? chatTitle : "Agent",
  };
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
      return null;
  }
}

function agentStoppedStatus(
  outcome: HostNotificationOutcome,
  reason: string | null,
  providerId: ProviderId | null,
): string {
  if (outcome === "errored") {
    return agentStoppedFailureStatus(reason, providerId);
  }
  if (outcome === "stopped") return "Stopped";
  return "Done";
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
