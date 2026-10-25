import type {
  EnvironmentNotice,
  EnvironmentReviewEntry,
  EnvironmentStatusResponse,
  EnvironmentWriteOutcome,
  LocalOverride,
  LocalOverrideTarget,
  RemoteAccessState,
} from "@traycer/protocol/host/environment-schemas";
import { heldCommandLine } from "@/components/settings/move/held-from-review";
import { providerIdSchema } from "@traycer/protocol/host/provider-schemas";
import { itemLabel } from "@/components/settings/personal/personal-page-status";
import { providerDisplayName } from "@/lib/provider-ordering";

/*
 * The words and the state rules of a host's access and setup (Settings >
 * Host > Overview > Access and setup) and of the notices on Personal pages.
 * Pure, so the copy and the rules are tested without a host.
 *
 * Copy rule: the person's words only. The sentences say what happens to the
 * person and their computer, never how.
 */

// ── Remote access ────────────────────────────────────────────────────────────

export const REMOTE_ACCESS_QUESTION =
  "Allow other devices and agents on your account to reach this computer?";

export const REMOTE_ACCESS_TEXT: Readonly<Record<RemoteAccessState, string>> = {
  on: "On. Other devices and agents signed in to your account can reach this computer.",
  turning_off: "Turning off. Other devices and agents are being disconnected.",
  off: "Off. Other devices and agents can't reach this computer. Your settings still reach it.",
};

/**
 * The state the section shows. Off answers `turning_off` until the host has
 * closed every session, and the status read can still say `on` for a poll or
 * two after that answer, so an Off the person pressed shows "turning off"
 * until the host itself reports `off`. Any other answer is the status's.
 */
export function shownRemoteAccess(
  status: RemoteAccessState,
  lastAnswer: RemoteAccessState | null,
): RemoteAccessState {
  if (lastAnswer === "turning_off" && status !== "off") return "turning_off";
  return status;
}

/**
 * Whether the one-time question shows: the host has the person's settings,
 * remote access is off and this desktop has not had an answer for the host.
 * Not on a team's host, whose access is the team's.
 */
export function remoteAccessQuestionShown(
  status: EnvironmentStatusResponse,
  answered: boolean,
): boolean {
  return (
    !answered &&
    status.principal !== null &&
    status.principal.kind === "personal" &&
    status.remoteAccess === "off"
  );
}

// ── Setup ────────────────────────────────────────────────────────────────────

/** The stages a first start passes through, in order, with their names. */
export const SETUP_STEPS: ReadonlyArray<{
  readonly stage: string;
  readonly label: string;
}> = [
  { stage: "registering", label: "Registering this host" },
  {
    stage: "moving_settings",
    label: "Moving this host's settings to Personal",
  },
  { stage: "applying", label: "Applying your settings" },
];

export type SetupView =
  | {
      readonly kind: "running";
      /** The stage running now, an index into `SETUP_STEPS`; -1 for a stage this desktop does not know. */
      readonly stepIndex: number;
    }
  | {
      readonly kind: "stopped";
      readonly stepIndex: number;
      readonly text: string;
    };

/**
 * What the Setup section shows for the host's `setup`, or `null` once there
 * is nothing to finish. A stage or state newer than this desktop reads as
 * running, with no step named.
 */
export function setupView(
  setup: EnvironmentStatusResponse["setup"],
): SetupView | null {
  if (setup === null) return null;
  if (setup.state === "done" || setup.stage === "done") return null;
  const stepIndex = SETUP_STEPS.findIndex((step) => step.stage === setup.stage);
  const step = stepIndex === -1 ? null : SETUP_STEPS[stepIndex];
  if (setup.state === "failed" && setup.stage === "moving_settings") {
    return {
      kind: "stopped",
      stepIndex,
      text: "Moving this host's settings to Personal failed.",
    };
  }
  if (setup.state === "stalled" || setup.state === "failed") {
    return {
      kind: "stopped",
      stepIndex,
      text:
        step === null
          ? "Setup stopped."
          : `Setup stopped while ${lowerFirst(step.label)}.`,
    };
  }
  return { kind: "running", stepIndex };
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Whether the one-time "Your settings moved to Personal" notice shows: setup
 * is done and a change came from this host's move.
 */
export function movedNoticeShown(
  status: EnvironmentStatusResponse,
  notices: readonly EnvironmentNotice[],
  dismissed: boolean,
): boolean {
  if (dismissed || status.setup === null) return false;
  if (status.setup.state !== "done" && status.setup.stage !== "done") {
    return false;
  }
  return notices.some((notice) => notice.source === "migration");
}

export const MOVED_NOTICE_TEXT =
  "Your settings moved to Personal. Review what changed.";

// ── Team hosts ───────────────────────────────────────────────────────────────

export function teamOwnedText(teamName: string): string {
  if (teamName === "") return "These settings belong to your team.";
  return `These settings belong to ${teamName}.`;
}

// ── This host's own values ───────────────────────────────────────────────────

export const LOCAL_VALUES_RESTART_NOTE =
  "Agents started after a change use the new value; restart the host for the host itself to pick it up.";

/** A Personal computer's Terminal account line. */
export const TERMINAL_ACCOUNT_SENTENCE =
  "This computer's own sign-in, which stays on this computer. Sign in on Providers to use one everywhere.";

/** A team host's Terminal account line: only an admin links a team's plan. */
export function teamTerminalAccountSentence(teamName: string): string {
  return `This host's own sign-in, which stays on this host. An admin can link a plan on ${teamName}'s Providers to use one everywhere.`;
}

/** A kept value's name: the variable, or `<NAME> (<Provider>)` for an override. */
export function localOverrideLabel(override: LocalOverride): string {
  const { target } = override;
  if (target.kind === "variable") return target.key;
  return `${target.key} (${providerDisplayName(target.providerId)})`;
}

/** The same target, compared by what it names. */
export function sameOverrideTarget(
  a: LocalOverrideTarget,
  b: LocalOverrideTarget,
): boolean {
  if (a.kind === "variable" && b.kind === "variable") return a.key === b.key;
  if (a.kind === "env_override" && b.kind === "env_override") {
    return a.providerId === b.providerId && a.key === b.key;
  }
  return false;
}

// ── Notices ──────────────────────────────────────────────────────────────────

/** Where a change came from, as a person names it. */
function changedFromText(notice: EnvironmentNotice): string {
  const { from } = notice;
  if (from.kind === "dashboard") return "the dashboard";
  return from.hostLabel ?? "another host";
}

/** "DATABASE_URL from dev-box now applies everywhere." */
export function noticeText(notice: EnvironmentNotice): string {
  return `${itemLabel(notice)} from ${changedFromText(notice)} now applies everywhere.`;
}

/**
 * The value the "Keep" action writes on this host, as a local override, or
 * `null` where it is not offered. Offered only for a variable or a provider's
 * variable, only while undo still is, and only on the host the change came
 * from (the window's host).
 */
export function keepLocalTarget(
  notice: EnvironmentNotice,
  windowHostId: string | null,
): LocalOverrideTarget | null {
  if (!notice.undoAvailable || windowHostId === null) return null;
  if (notice.from.kind !== "host" || notice.from.hostId !== windowHostId) {
    return null;
  }
  if (notice.kind === "variable") return { kind: "variable", key: notice.key };
  if (notice.kind !== "env_override") return null;
  // An env override's item key is `<providerId>:<variable>`.
  const separator = notice.key.indexOf(":");
  if (separator === -1) return null;
  const providerId = providerIdSchema.safeParse(notice.key.slice(0, separator));
  if (!providerId.success) return null;
  return {
    kind: "env_override",
    providerId: providerId.data,
    key: notice.key.slice(separator + 1),
  };
}

/** "Keep dev-box's value on dev-box". */
export function keepLocalText(hostName: string): string {
  return `Keep ${hostName}'s value on ${hostName}`;
}

/**
 * What an Undo that did not go through says, or `null` for one that did.
 * `kept` is the Keep action's Undo: the value stays on this host either way.
 */
export function undoRefusalText(
  outcome: EnvironmentWriteOutcome,
  label: string,
  kept: { readonly hostName: string } | null,
): string | null {
  const prefix =
    kept === null
      ? "Couldn't undo"
      : `Kept on ${kept.hostName}, but couldn't undo the change everywhere`;
  switch (outcome.outcome) {
    case "saved":
      return null;
    case "pending":
      return kept === null
        ? "Undo applies when this host reconnects."
        : `Kept on ${kept.hostName}. The change everywhere is undone when this host reconnects.`;
    case "stale":
      return `${prefix}: ${label} was changed again since.`;
    case "needs_grant":
      return `${prefix}: it needs your confirmation. Sign in again and retry.`;
  }
}

/** The Keep action's Undo failed outright; the value stays on this host. */
export function keptUndoFailedText(hostName: string): string {
  return `Kept on ${hostName}, but couldn't undo the change everywhere.`;
}

// ── Needs you ────────────────────────────────────────────────────────────────

const REVIEW_REASONS: Readonly<Partial<Record<string, string>>> = {
  executable_entry: "runs a command",
  needs_grant: "was changed without your confirmation",
};

/**
 * "DATABASE_URL is waiting for you: looks like a secret."; a held key-shaped
 * value reads "DATABASE_URL looks like a key and is on hold until you
 * choose", which its row follows with `· Review`, and a held command reads
 * `heldCommandText`.
 */
export function reviewText(entry: EnvironmentReviewEntry): string {
  if (entry.reason === "executable_entry") return heldCommandText(entry);
  if (entry.reason === "credential_like_value") {
    return `${itemLabel(entry)} looks like a key and is on hold until you choose`;
  }
  const reason = REVIEW_REASONS[entry.reason];
  return reason === undefined
    ? `${itemLabel(entry)} is waiting for you.`
    : `${itemLabel(entry)} is waiting for you: ${reason}.`;
}

/**
 * "env-e2e-memory (MCP server) runs npx -y @mcp/memory and is on hold until
 * you choose", "notify (hook) runs notify.sh on stop and is on hold until you
 * choose", or without a command "env-e2e-memory (MCP server) is on hold until
 * you choose"; every other kind by its own line (`heldCommandLine`). Its
 * row's `Review` opens the retrospective sheet.
 */
function heldCommandText(entry: EnvironmentReviewEntry): string {
  const line = heldCommandLine(entry);
  return `${line.name} ${line.clause}${line.acts ? " and" : ""} is on hold until you choose`;
}

export const REVIEW_LINK_LABEL = "Review in the dashboard";
