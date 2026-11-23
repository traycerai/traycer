import type {
  ReviewHeldEntry,
  UndoOutcome,
} from "@traycer-clients/shared/environment/environment-review";
import type {
  EnvironmentNotice,
  EnvironmentStatusResponse,
  LocalOverride,
  LocalOverrideTarget,
  RemoteAccessState,
} from "@traycer/protocol/host/environment-schemas";
import { heldCommandLine } from "@/components/settings/move/held-from-review";
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

const TEAM_REMOTE_ACCESS_TEXT: Readonly<Record<RemoteAccessState, string>> = {
  on: "On. Team members and agents can reach this computer.",
  turning_off: "Turning off. Team members and agents are being disconnected.",
  off: "Off. Team members and agents can't reach this computer.",
};

export function remoteAccessText(
  state: RemoteAccessState,
  principal: EnvironmentStatusResponse["principal"],
): string {
  return principal?.kind === "team"
    ? TEAM_REMOTE_ACCESS_TEXT[state]
    : REMOTE_ACCESS_TEXT[state];
}

/** The host refuses a role with `FORBIDDEN`, authn with a 403 (`E_ROLE_FORBIDDEN`). */
export function remoteAccessFailureText(code: string): string {
  return code === "FORBIDDEN" || code === "E_ROLE_FORBIDDEN"
    ? "You don't have permission to change remote access on this computer."
    : "Couldn't change remote access. Try again.";
}

/**
 * The state the section shows. The status read can still say `on` for a poll
 * or two after the host took an Off, so an Off the person pressed
 * (`lastAnswer` `turning_off`) shows "turning off" until the host itself
 * reports `off`. Otherwise the status's.
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
 *
 * `awaiting_consent` is `null` too: the computer runs its own settings until
 * the person moves it to Personal, which has no deadline, so nothing is being
 * set up. The move is offered where it is (the Local row, Getting started).
 */
export function setupView(
  setup: EnvironmentStatusResponse["setup"],
): SetupView | null {
  if (setup === null) return null;
  if (setup.state === "done" || setup.stage === "done") return null;
  if (setup.state === "awaiting_consent") return null;
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

export function movedNoticeShown(
  status: EnvironmentStatusResponse,
  hostId: string,
  uploadedHostIds: readonly string[],
  dismissed: boolean,
): boolean {
  return (
    !dismissed &&
    status.principal?.kind === "personal" &&
    status.setup !== null &&
    (status.setup.state === "done" || status.setup.stage === "done") &&
    uploadedHostIds.includes(hostId)
  );
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

/**
 * What a terminal sign-in is, named for the host it lives on: `null` for
 * this computer, else the host's name (`e2e-sbx-p1's own sign-in, which
 * stays on e2e-sbx-p1. …`).
 */
export function terminalAccountSentence(hostName: string | null): string {
  return hostName === null
    ? "This computer's own sign-in, which stays on this computer. Sign in on Providers to use one everywhere."
    : `${hostName}'s own sign-in, which stays on ${hostName}. Sign in on Providers to use one everywhere.`;
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

export function noticeText(notice: EnvironmentNotice): string {
  return `${itemLabel(notice)} now applies everywhere.`;
}

/** What an Undo that did not go through says. */
export function undoRefusalText(
  outcome: UndoOutcome,
  label: string,
): string | null {
  switch (outcome.outcome) {
    case "saved":
      return null;
    case "stale":
      return `Couldn't undo: ${label} was changed again since.`;
    case "needs_grant":
      return "Couldn't undo: it needs your confirmation. Sign in again and retry.";
  }
}

// ── Needs you ────────────────────────────────────────────────────────────────

/**
 * A hold's row: "env-e2e-memory (MCP server) runs npx -y @mcp/memory and is on
 * hold until you choose", or without a command "env-e2e-memory (MCP server)
 * is on hold until you choose"; every other kind by its own line
 * (`heldCommandLine`). authn's holds carry no reason, so every hold reads
 * this way, whatever its kind.
 */
export function reviewText(entry: ReviewHeldEntry): string {
  const line = heldCommandLine(entry);
  return `${line.name} ${line.clause}${line.acts ? " and" : ""} is on hold until you choose`;
}

export const REVIEW_LINK_LABEL = "Review in the dashboard";
