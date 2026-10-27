import {
  type HostNotificationEntryV25,
  type HostNotificationOutcome,
} from "@traycer/protocol/host/notifications/host-notifications";
import {
  deriveHostNotificationStoppedReason,
  parseHostOperationCommonPayload,
  parseKnownHostNotificationPayloadForKind,
  type HostNotificationKnownPayload,
  type HostNotificationRotationProducer,
  type HostNotificationStoppedReason,
} from "@traycer/protocol/host/notifications/payloads";
import { withIndefiniteArticle } from "@traycer/protocol/host/notifications/indefinite-article";
import {
  sandboxSettingsFailureLine,
  sandboxSettingsStepsLine,
} from "@traycer/protocol/host/sandbox-settings";
import type { AgentFailureReason } from "@traycer/protocol/persistence/epic/content-blocks";
import type { FallbackRungKind } from "@traycer/protocol/host/fallback-policy";
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
  entry: HostNotificationEntryV25,
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
      const unverified = known === null ? false : knownUnverified(known);
      const status = agentStoppedStatus(
        entry.outcome,
        reason,
        providerId,
        backgroundWorkRunning,
        unverified,
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
    // Host-composed title, agent-authored reason as the context. The reason is
    // the only thing that says WHICH wall was hit, so it leads the body; a
    // payload this build cannot parse still gets the title and the status.
    case "browser.human.needed":
      return {
        title: "Browser needs you",
        body: `${browserHumanNeededReason(known) ?? "Browser"} • ${resolvableRequestStatus(entry.resolvedAt, "Waiting for you", "Resumed")}`,
      };
    // Host-composed titles. The subject is the secret's NAME (or, for a
    // request that names only a destination, the destination); the agent's
    // reason stays in the payload for the approval card and is not put into
    // copy that also reaches email and hooks.
    case "secret.grant.requested":
      return {
        title: "Secret requested",
        body: `${secretGrantRequestSubject(known) ?? "A sandbox agent"} • ${resolvableRequestStatus(entry.resolvedAt, "Waiting for your decision", secretGrantDecidedBy(known) ?? "Decided")}`,
      };
    case "secret.export.minted":
      return {
        title: "Secret exported",
        body: `${secretExportMintedSubject(known) ?? "A secret"} • Short-lived export created`,
      };
    case "secret.rotated":
      return secretRotatedPresentation(known);
    case "team.member.removed":
    case "team.member.joined":
    case "team.policy.unapplied":
    case "team.policy.authority_expired":
    case "team.installing_admin.gone":
    case "team.plan.unlinked":
    case "team.pods.full":
      return teamNotificationPresentation(entry.kind, known);
    case "environment.move.stalled":
    case "environment.apply.failed":
    case "team.role.changed":
    case "team.host.returned":
    case "secret.removed":
      return environmentNotificationPresentation(entry.kind, known);
    case "sandbox.notice":
      return sandboxNoticePresentation(known, Date.now());
  }
}

const SANDBOX_FILES_LINE =
  "Files on this sandbox cannot be recovered; published chats stay readable.";

/**
 * When a sandbox is destroyed, in the reader's own time zone: `at 10:36`
 * today, `tomorrow at 10:36`, `on Oct 27 at 10:36` after that. The formats
 * are built per call, so a zone changed while the app runs is read.
 */
export function sandboxDestroyWhen(destroyAt: number, now: number): string {
  const at = new Date(destroyAt);
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
  const today = new Date(now);
  const tomorrow = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() + 1,
  );
  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(at, today)) return `at ${time}`;
  if (sameDay(at, tomorrow)) return `tomorrow at ${time}`;
  const date = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(at);
  return `on ${date} at ${time}`;
}

/** The sandbox rows: what happened to one sandbox, by name. */
function sandboxNoticePresentation(
  known: HostNotificationKnownPayload | null,
  now: number,
): HostNotificationPresentation {
  if (known?.kind !== "sandbox_notice") {
    return { title: "Sandbox", body: "Open Details to see what happened" };
  }
  const name = known.sandboxName.length > 0 ? known.sandboxName : "A sandbox";
  const notice = known.notice;
  switch (notice.kind) {
    case "resting_warning":
      return {
        title: `${name} is destroyed ${sandboxDestroyWhen(notice.destroyAt, now)} unless you use it`,
        body: SANDBOX_FILES_LINE,
      };
    case "resting_destroyed":
      return {
        title: `${name} was destroyed after resting`,
        body: SANDBOX_FILES_LINE,
      };
    case "frozen":
      return {
        title: `${name} is frozen`,
        body:
          notice.cause === "credits"
            ? "Add credits to use it again."
            : "Its paying member left the team.",
      };
    case "frozen_warning":
      return {
        title:
          notice.daysLeft === 1
            ? `${name} is deleted tomorrow`
            : `${name} is deleted in ${notice.daysLeft} days`,
        body: "Add credits to keep it; otherwise it is deleted with its files.",
      };
    case "frozen_deleting":
      return {
        title: `${name} is being deleted`,
        body: "It was frozen for lack of credits for 30 days.",
      };
    case "frozen_destroyed":
      return {
        title: `${name} was deleted`,
        body: "It was frozen for lack of credits for 30 days.",
      };
    case "create_failed":
      return {
        title: `${name} couldn't start`,
        body: "Open Details to see why.",
      };
    case "lost":
      return {
        title: `${name} was lost`,
        body: "The provider no longer has it; its files could not be kept.",
      };
    case "destroyed_by_member":
      return {
        title: `${notice.actorName ?? "A member"} destroyed ${name}`,
        body: SANDBOX_FILES_LINE,
      };
    case "manual_rest": {
      const done = notice.verb === "suspend" ? "suspended" : "stopped";
      const confirmed = notice.outcome === "confirmed";
      let title: string;
      if (notice.byYou) {
        title = confirmed
          ? `${notice.verb === "suspend" ? "Suspended" : "Stopped"} ${name}`
          : `Couldn't ${notice.verb} ${name}`;
      } else {
        const actor = notice.actorName ?? "A member";
        title = confirmed
          ? `${actor} ${done} ${name}`
          : `${actor} couldn't ${notice.verb} ${name}`;
      }
      return {
        title,
        body: confirmed ? "Its files are kept." : "It is still running.",
      };
    }
  }
}

/** The environments rows: what happened to a configuration, by name. */
function environmentNotificationPresentation(
  kind:
    | "environment.move.stalled"
    | "environment.apply.failed"
    | "team.role.changed"
    | "team.host.returned"
    | "secret.removed",
  known: HostNotificationKnownPayload | null,
): HostNotificationPresentation {
  switch (kind) {
    case "environment.move.stalled":
      return {
        title: "Move to Personal stalled",
        body:
          known?.kind === "environment_move_stalled"
            ? `${known.hostName} • ${known.remaining === 1 ? "1 item" : `${known.remaining} items`} not in Personal yet`
            : "A computer's move to Personal stopped before it finished",
      };
    case "environment.apply.failed": {
      const sandbox =
        known?.kind === "environment_apply_failed" ? known.sandbox : null;
      if (sandbox !== null && sandbox !== undefined)
        return {
          title: sandboxSettingsFailureLine(
            sandbox.name,
            sandbox.configurationName,
            "SBX-0520",
          ),
          body: [
            "Compute is charged while it is awake.",
            sandboxSettingsStepsLine(sandbox),
          ]
            .filter(Boolean)
            .join(" "),
        };
      return {
        title: "Setting not applied",
        body:
          known?.kind === "environment_apply_failed"
            ? `${known.hostName} • A setting could not be applied`
            : "A host could not apply a setting",
      };
    }
    case "team.role.changed":
      return {
        title: "Your role changed",
        body:
          known?.kind === "team_role_changed"
            ? `${known.teamName} • You're now ${roleName(known.to)} (you were ${roleName(known.from)}).`
            : "Your role in a team changed",
      };
    case "team.host.returned":
      return {
        title: "Computer back on your own settings",
        body:
          known?.kind === "team_host_returned"
            ? `${known.hostName} • No longer runs ${known.teamName}`
            : "A computer no longer runs a team's settings",
      };
    case "secret.removed":
      return {
        title: "Secret removed",
        body:
          known?.kind === "secret_removed"
            ? `${known.secretName} • ${secretRemovedStatus(known.outcome)}`
            : "A secret was removed",
      };
  }
}

/** A role read off a payload as a string; a role newer than this build reads as-is. */
function roleName(role: string): string {
  switch (role) {
    case "owner":
    case "admin":
    case "editor":
    case "viewer":
      return withIndefiniteArticle(role);
    default:
      return role;
  }
}

function secretRemovedStatus(
  outcome: "revoked" | "cleanup_requested" | "destroyed",
): string {
  switch (outcome) {
    case "revoked":
      return "Revoked";
    case "cleanup_requested":
      return "Revoked; removing it from its hosts";
    case "destroyed":
      return "Destroyed";
  }
}

/**
 * A replaced secret's row. The state is read from the payload as a string:
 * a state newer than this build reads "Value replaced". "Enforced" is said
 * only when the payload's state is `enforced`; the per-class proof beside it
 * is counted from the evidence kinds this build knows, never from a fence or
 * a deadline.
 */
function secretRotatedPresentation(
  known: HostNotificationKnownPayload | null,
): HostNotificationPresentation {
  const title = "Secret value replaced";
  if (known?.kind !== "secret_rotated") {
    return { title, body: "A secret • Value replaced" };
  }
  const subject = known.secretName;
  switch (known.state) {
    case "accepted":
    case "enforcing":
      return {
        title,
        body: `${subject} • New value accepted, closing old sessions`,
      };
    case "stalled":
      return {
        title,
        body: `${subject} • Not confirmed after a minute; you can stop the sandbox`,
      };
    case "enforced": {
      const proof = rotationProofSummary(known.evidence);
      return {
        title,
        body:
          proof === null
            ? `${subject} • Enforced`
            : `${subject} • Enforced: ${proof}`,
      };
    }
    case "failed":
      return { title, body: `${subject} • Replacing the value failed` };
    default:
      return { title, body: `${subject} • Value replaced` };
  }
}

/**
 * "3 sessions closed, cached keys dropped": the known evidence summed over
 * every producer. A kind this build does not know adds nothing; a producer
 * contained by expiry supplies no count.
 */
function rotationProofSummary(
  producers: readonly HostNotificationRotationProducer[],
): string | null {
  let sessions = 0;
  let sawSessions = false;
  let cachesDropped = false;
  let probed = false;
  for (const producer of producers) {
    for (const entry of producer.evidence ?? []) {
      if (entry.kind === "session_closed") {
        sawSessions = true;
        sessions += entry.count ?? 0;
      } else if (entry.kind === "cache_cleared") {
        cachesDropped = true;
      } else if (entry.kind === "probe_refused") {
        probed = true;
      }
    }
  }
  const parts: string[] = [];
  if (sawSessions && sessions > 0) {
    parts.push(
      sessions === 1 ? "1 session closed" : `${sessions} sessions closed`,
    );
  }
  if (cachesDropped) parts.push("cached keys dropped");
  if (probed) parts.push("old value refused");
  return parts.length === 0 ? null : parts.join(", ");
}

/** The team rows: what changed in the team, by name. */
function teamNotificationPresentation(
  kind:
    | "team.member.removed"
    | "team.member.joined"
    | "team.policy.unapplied"
    | "team.policy.authority_expired"
    | "team.installing_admin.gone"
    | "team.plan.unlinked"
    | "team.pods.full",
  known: HostNotificationKnownPayload | null,
): HostNotificationPresentation {
  switch (kind) {
    case "team.member.removed": {
      if (known?.kind !== "team_member_removed") {
        return { title: "Member removed", body: "A team member was removed" };
      }
      if (known.toRemovedMember === true) {
        return {
          title: "No longer a member",
          body: `You are no longer a member of ${known.teamName}.`,
        };
      }
      const done = known.hosts.filter(
        (host) =>
          host.stopped === "done" &&
          host.credentialClosed === "done" &&
          host.replacementDelivered === "done",
      ).length;
      const progress =
        known.hosts.length === 0
          ? "Removal complete"
          : `${done} of ${known.hosts.length} hosts done`;
      return {
        title: "Member removed",
        body: `${known.memberName} • ${known.teamName} • ${progress}`,
      };
    }
    case "team.member.joined":
      if (known?.kind !== "team_member_joined") {
        return { title: "Member joined", body: "Someone joined your team" };
      }
      return known.toNewcomer
        ? {
            title: `Welcome to ${known.teamName}`,
            body: `Open a tab on one of ${known.teamName}'s sandboxes, or create one`,
          }
        : {
            title: "Member joined",
            body: `${known.memberName} • Joined ${known.teamName}`,
          };
    case "team.policy.unapplied":
      return {
        title: "Policy not applied yet",
        body:
          known?.kind === "team_policy_unapplied"
            ? `${known.teamName} • No host has applied the latest policy yet`
            : "No host has applied the latest policy yet",
      };
    case "team.policy.authority_expired":
      return {
        title: "Policy lapsed on a host",
        body:
          known?.kind === "team_policy_authority_expired"
            ? `${known.hostName} • Its ${known.teamName} policy has lapsed`
            : "A host's team policy has lapsed",
      };
    case "team.installing_admin.gone":
      return {
        title: "GitHub needs an installing admin",
        body:
          known?.kind === "team_installing_admin_gone"
            ? `${installingAdminGoneLine(known.adminName, known.teamName, known.reason)} • Git fails on every ${known.teamName} sandbox until another admin connects GitHub`
            : "Git fails on every team sandbox until another admin connects GitHub",
      };
    case "team.plan.unlinked":
      return {
        title: "Team plan unlinked",
        body:
          known?.kind === "team_plan_unlinked"
            ? `${known.teamName} • Its plan was unlinked`
            : "A team's plan was unlinked",
      };
    case "team.pods.full":
      return {
        title: "Every pod is full",
        body:
          known?.kind === "team_pods_full"
            ? `${known.teamName} • All ${known.podCount} pods are full; add a pod`
            : "Every team pod is full; add a pod",
      };
  }
}

function installingAdminGoneLine(
  adminName: string,
  teamName: string,
  reason: string,
): string {
  switch (reason) {
    case "left":
      return `${adminName} left ${teamName}`;
    case "demoted":
      return `${adminName} is no longer an admin of ${teamName}`;
    case "unlinked":
      return `${adminName} unlinked GitHub`;
    default:
      return `${adminName} can no longer install GitHub for ${teamName}`;
  }
}

function secretGrantRequestSubject(
  known: HostNotificationKnownPayload | null,
): string | null {
  if (known?.kind !== "secret_grant_request") return null;
  return known.secretName ?? known.destination;
}

/**
 * "Approved by Ana" or "Declined by Ana" for a resolved request whose payload
 * names who answered (a team's other admins read it), else `null`.
 */
function secretGrantDecidedBy(
  known: HostNotificationKnownPayload | null,
): string | null {
  if (known?.kind !== "secret_grant_request") return null;
  const decidedBy = known.decidedBy ?? null;
  if (decidedBy === null) return null;
  if (known.decision === "approved") return `Approved by ${decidedBy}`;
  if (known.decision === "declined") return `Declined by ${decidedBy}`;
  return null;
}

function secretExportMintedSubject(
  known: HostNotificationKnownPayload | null,
): string | null {
  return known?.kind === "secret_export_minted" ? known.secretName : null;
}

function browserHumanNeededReason(
  known: HostNotificationKnownPayload | null,
): string | null {
  return known?.kind === "browser_human_needed" ? known.reason : null;
}

/**
 * Three-tier degradation for a host-wide operation completion, resolved as a
 * per-FIELD fallback chain rather than a first-match-wins branch:
 *
 *  1. a KNOWN operation payload's own copy, when that arm supplies any
 *     (`hostOperationKnownCopy`);
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
 * Exhaustive over the known payload union so every operation arm gets a
 * compile-visible slot here. A Task-scoped operation may replace the title
 * with its Task name, but must retain the host-composed operation result in
 * the body. Host-wide rows inherit the common payload copy unchanged.
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
    // The browser park row's copy is composed above from the entry itself, not
    // from the payload arm: `reason` is the body's context, never a title.
    case "browser_human_needed":
    case "secret_grant_request":
    case "secret_export_minted":
    case "secret_rotated":
    case "team_member_removed":
    case "team_member_joined":
    case "team_policy_unapplied":
    case "team_policy_authority_expired":
    case "team_installing_admin_gone":
    case "team_plan_unlinked":
    case "team_pods_full":
    case "environment_move_stalled":
    case "environment_apply_failed":
    case "team_role_changed":
    case "team_host_returned":
    case "secret_removed":
    case "sandbox_notice":
      return null;
    case "worktree_deletion": {
      const taskTitle = nonEmptyTitle(payload.taskTitle ?? null);
      if (
        payload.source !== "task_sweep" ||
        payload.epicId === undefined ||
        taskTitle === null
      ) {
        return null;
      }
      return {
        title: taskTitle,
        body: `${payload.title} • ${payload.message}`,
      };
    }
    // These arms retain the host-composed copy used by delivery hooks.
    case "worktree_auto_cleanup":
    case "managed_command_delivery_parked":
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
      return payload.taskTitle ?? null;
    case "worktree_auto_cleanup":
    case "managed_command_delivery_parked":
    case "browser_human_needed":
    case "secret_grant_request":
    case "secret_export_minted":
    case "secret_rotated":
    case "team_member_removed":
    case "team_member_joined":
    case "team_policy_unapplied":
    case "team_policy_authority_expired":
    case "team_installing_admin_gone":
    case "team_plan_unlinked":
    case "team_pods_full":
    case "environment_move_stalled":
    case "environment_apply_failed":
    case "team_role_changed":
    case "team_host_returned":
    case "secret_removed":
    case "sandbox_notice":
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
    case "worktree_auto_cleanup":
    case "managed_command_delivery_parked":
    case "browser_human_needed":
    case "secret_grant_request":
    case "secret_export_minted":
    case "secret_rotated":
    case "team_member_removed":
    case "team_member_joined":
    case "team_policy_unapplied":
    case "team_policy_authority_expired":
    case "team_installing_admin_gone":
    case "team_plan_unlinked":
    case "team_pods_full":
    case "environment_move_stalled":
    case "environment_apply_failed":
    case "team_role_changed":
    case "team_host_returned":
    case "secret_removed":
    case "sandbox_notice":
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
    case "worktree_auto_cleanup":
    case "managed_command_delivery_parked":
    case "browser_human_needed":
    case "secret_grant_request":
    case "secret_export_minted":
    case "secret_rotated":
    case "team_member_removed":
    case "team_member_joined":
    case "team_policy_unapplied":
    case "team_policy_authority_expired":
    case "team_installing_admin_gone":
    case "team_plan_unlinked":
    case "team_pods_full":
    case "environment_move_stalled":
    case "environment_apply_failed":
    case "team_role_changed":
    case "team_host_returned":
    case "secret_removed":
    case "sandbox_notice":
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
    case "worktree_auto_cleanup":
    case "managed_command_delivery_parked":
    case "browser_human_needed":
    case "secret_grant_request":
    case "secret_export_minted":
    case "secret_rotated":
    case "team_member_removed":
    case "team_member_joined":
    case "team_policy_unapplied":
    case "team_policy_authority_expired":
    case "team_installing_admin_gone":
    case "team_plan_unlinked":
    case "team_pods_full":
    case "environment_move_stalled":
    case "environment_apply_failed":
    case "team_role_changed":
    case "team_host_returned":
    case "secret_removed":
    case "sandbox_notice":
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
    case "worktree_auto_cleanup":
    case "managed_command_delivery_parked":
    case "browser_human_needed":
    case "secret_grant_request":
    case "secret_export_minted":
    case "secret_rotated":
    case "team_member_removed":
    case "team_member_joined":
    case "team_policy_unapplied":
    case "team_policy_authority_expired":
    case "team_installing_admin_gone":
    case "team_plan_unlinked":
    case "team_pods_full":
    case "environment_move_stalled":
    case "environment_apply_failed":
    case "team_role_changed":
    case "team_host_returned":
    case "secret_removed":
    case "sandbox_notice":
      return null;
  }
}

function agentStoppedStatus(
  outcome: HostNotificationOutcome,
  reason: string | null,
  providerId: ProviderId | null,
  backgroundWorkRunning: boolean,
  unverified: boolean,
): string {
  if (outcome === "errored") {
    return agentStoppedFailureStatus(reason, providerId);
  }
  if (outcome === "stopped") return "Stopped";
  if (backgroundWorkRunning) return "Background work running";
  if (unverified) return "Paused, not verified";
  return "Done";
}

function knownUnverified(payload: HostNotificationKnownPayload): boolean {
  switch (payload.kind) {
    case "chat":
      return payload.unverified === true;
    case "epic":
    case "agent_stalled":
    case "approval":
    case "interview":
    case "workspace_operation_failed":
    case "worktree_deletion":
    case "worktree_auto_cleanup":
    case "managed_command_delivery_parked":
    case "browser_human_needed":
    case "secret_grant_request":
    case "secret_export_minted":
    case "secret_rotated":
    case "team_member_removed":
    case "team_member_joined":
    case "team_policy_unapplied":
    case "team_policy_authority_expired":
    case "team_installing_admin_gone":
    case "team_plan_unlinked":
    case "team_pods_full":
    case "environment_move_stalled":
    case "environment_apply_failed":
    case "team_role_changed":
    case "team_host_returned":
    case "secret_removed":
    case "sandbox_notice":
      return false;
  }
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
    case "worktree_auto_cleanup":
    case "managed_command_delivery_parked":
    case "browser_human_needed":
    case "secret_grant_request":
    case "secret_export_minted":
    case "secret_rotated":
    case "team_member_removed":
    case "team_member_joined":
    case "team_policy_unapplied":
    case "team_policy_authority_expired":
    case "team_installing_admin_gone":
    case "team_plan_unlinked":
    case "team_pods_full":
    case "environment_move_stalled":
    case "environment_apply_failed":
    case "team_role_changed":
    case "team_host_returned":
    case "secret_removed":
    case "sandbox_notice":
      return false;
  }
}

/**
 * Short, PROVIDER-INDEPENDENT label for one stopped reason.
 *
 * Deliberately a second map beside {@link agentStoppedFailureStatus} rather
 * than a lift of it. The two surfaces want opposite shapes and must not be
 * merged:
 *
 * - `agentStoppedFailureStatus` is NOTIFICATION copy: sentence-shaped and
 *   provider-aware ("Provider is temporarily unavailable", "Anthropic rate
 *   limit reached", and for `auth` it delegates to `providerSignedOutMessage`,
 *   which gives Reasonix an API-key-specific sentence). It is a `body` line a
 *   user reads out of context, so it names the provider and tells them what to
 *   do. Its output must not change.
 * - This map is a NOUN PHRASE for a settings matrix row and the fallback cards,
 *   where the provider is already on screen in the identity chip and repeating
 *   it inside the label is noise.
 *
 * Total over the taxonomy by construction (`Record<…, string>`), so a new
 * stopped reason cannot ship without a label here.
 */
export const FALLBACK_REASON_LABELS: Record<
  HostNotificationStoppedReason,
  string
> = {
  rate_limit: "Rate limit reached",
  billing: "Billing issue",
  model_unavailable: "Model unavailable",
  provider_unavailable: "Temporarily unavailable",
  auth: "Signed out",
  provider_connection_failed: "Connection failed",
  context_exhausted: "Context limit reached",
  request_rejected: "Provider rejected the request",
  turn_start_timeout: "Provider did not start in time",
  missing_terminal_event: "Provider stopped responding",
  background_work_failed: "Background work stopped",
  session_budget: "Session limit reached",
};

/**
 * {@link FALLBACK_REASON_LABELS} keyed by the PERSISTED failure vocabulary.
 *
 * Indexing a `Record<HostNotificationStoppedReason, string>` with an
 * `AgentFailureReason` is the compile-time proof that persisted ⊆ host;
 * `runtimeFailureReason` (`host/agent/gui/agent-runtime.ts`) proves the other
 * direction. Between them the two lists cannot drift, which is what lets
 * `content-blocks.ts` re-declare the taxonomy instead of importing it across a
 * layer boundary it may not cross.
 */
export function fallbackReasonLabel(reason: AgentFailureReason): string {
  return FALLBACK_REASON_LABELS[reason];
}

/**
 * What a ladder step is called in USER-FACING text.
 *
 * `"rung"` and `"ladder"` are engine words on the ux-surfaces never-say list,
 * and so are the step ids themselves - a notice row reading `Rung: tier` is
 * two of them in four characters. The settings panel already resolved this for
 * its own surfaces (`FALLBACK_RUNG_COPY`, which calls the concept a "step");
 * this map exists because a notice's `details` value is built HOST-side and the
 * GUI cannot fix it on the way out. That is the same constraint that put
 * {@link FALLBACK_REASON_LABELS} here rather than in the client: a `details`
 * value is an open `string`, so a GUI-side lookup would be a string-indexed
 * cast that fails open on anything it has not heard of.
 *
 * `"manual"` is not a ladder step - it is what the cursor reads as when the
 * user picked the destination themselves, so the ladder index names no rung.
 *
 * `Record<…, string>` over the union, so a fifth step cannot ship without copy.
 */
export const FALLBACK_RUNG_LABELS: Record<FallbackRungKind | "manual", string> =
  {
    profile: "Another profile",
    tier: "Equivalent model",
    wait: "Waiting for reset",
    notify: "Notify only",
    manual: "Chosen by you",
  };

export function fallbackRungLabel(rung: FallbackRungKind | "manual"): string {
  return FALLBACK_RUNG_LABELS[rung];
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
    // Provider-NEUTRAL even though only one provider emits the code today, and
    // for the same reason `context_exhausted` is: the limit is a property of
    // this conversation, not of the account or the vendor's capacity. Naming
    // the provider here would read as a provider-side condition, which is
    // precisely the misreading that made this a `rate_limit` in the first place.
    case "session_budget":
      return "Session limit reached";
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
    // The provider-fallback engine's armed-traversal notice. A stalled row
    // rather than a failure row on purpose: the turn died, but the host is
    // already acting on it and the user's only decision is whether to let it -
    // which is the opposite of the "a human must intervene" the failure row
    // means. `reason` is open text on this payload, so this arm is additive and
    // an older host simply renders the generic status below.
    case "fallback_pending":
      return "Trying a fallback provider";
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
