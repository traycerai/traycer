import {
  HOST_FROZEN_WORD,
  hostSandboxStateWord,
  type HostSandboxState,
} from "@traycer/protocol/host/host-status";
import {
  parseSandboxHeartbeatPhase,
  sandboxSupportReference,
  type SandboxKind,
  type SandboxLifecycleVerb,
  type SandboxMember,
  type SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import type { HostHealthState } from "@/components/settings/host-scope/host-health";
import { frozenDestroyAt } from "@/lib/sandboxes/sandbox-balance";
import {
  formatSandboxDate,
  formatSandboxUtcDay,
  sandboxFailedToStart,
  sandboxFrozenClock,
} from "@/lib/sandboxes/sandbox-row-lines";

/**
 * The sandbox card's per-state copy and actions, kept free of React so the
 * table is read (and tested) in one place. Copy says what each state means to
 * the user; actions are the verbs the control plane accepts from that state.
 */

/** An action the card offers. `destroy` always asks for confirmation. */
export type SandboxCardAction =
  | "suspend"
  | "resume"
  | "stop"
  | "start"
  | "destroy";

const NO_ACTIONS: readonly SandboxCardAction[] = [];
const FROZEN_ACTIONS: readonly SandboxCardAction[] = ["destroy"];

/**
 * What the card offers from each state. Transitional states offer nothing:
 * the control plane refuses a verb on a row that is moving, and the card
 * re-reads the row as it lands. Except Destroy from `suspending` and
 * `stopping`: a vendor that keeps refusing leaves the row there, and the
 * control plane takes a destroy once one attempt's time is up
 * (`mayEnterDestroying`); before then it answers that the sandbox is
 * changing state. A frozen row offers only destroy, from every
 * state whose own row includes it - a wake would answer `sandbox_frozen`
 * until credits are added, and deleting a frozen sandbox is allowed at any
 * time. That includes `awake`: the meter sets `frozen` first and drives the
 * suspend afterwards, so a row whose freeze-suspend keeps failing at the
 * provider is frozen and awake, and the server destroys it from there.
 */
const ACTIONS_BY_STATE: Record<HostSandboxState, readonly SandboxCardAction[]> =
  {
    creating: NO_ACTIONS,
    awake: ["suspend", "stop", "destroy"],
    suspending: ["destroy"],
    suspended: ["resume", "destroy"],
    resuming: NO_ACTIONS,
    stopping: ["destroy"],
    stopped: ["start", "destroy"],
    starting: NO_ACTIONS,
    destroying: NO_ACTIONS,
    destroyed: NO_ACTIONS,
    failed: ["destroy"],
    // Only an Automations row rests here; a team pod's own table covers it.
    released: NO_ACTIONS,
  };

/**
 * A team pod's verbs (`kind: "automation"` on a team's row): it is `released`
 * or `awake`, never suspended. `stop` releases it (scaled to zero, disk kept),
 * `start` opens it, and a suspend would answer `409`, so it is never offered.
 * The server destroys it like any row.
 */
const TEAM_POD_ACTIONS_BY_STATE: Record<
  HostSandboxState,
  readonly SandboxCardAction[]
> = {
  ...ACTIONS_BY_STATE,
  awake: ["stop", "destroy"],
  released: ["start", "destroy"],
};

/**
 * The person's own Automations host (`kind: "automation"`, not a team's)
 * offers no lifecycle verb: its actions are Open terminal and Rename, and the
 * next shell starts it.
 */
export function sandboxCardActions(
  state: HostSandboxState | null,
  frozen: boolean,
  kind: SandboxKind,
  teamOwned: boolean,
): readonly SandboxCardAction[] {
  if (state === null) return NO_ACTIONS;
  if (kind === "automation" && !teamOwned) return NO_ACTIONS;
  const actions =
    kind === "automation"
      ? TEAM_POD_ACTIONS_BY_STATE[state]
      : ACTIONS_BY_STATE[state];
  if (frozen) {
    return actions.includes("destroy") ? FROZEN_ACTIONS : NO_ACTIONS;
  }
  return actions;
}

/** The one inline verb; all other allowed verbs stay in More. */
export function sandboxHeaderPrimaryAction(
  actions: readonly SandboxCardAction[],
): SandboxCardAction | null {
  return (
    actions.find(
      (action) =>
        action === "suspend" ||
        action === "resume" ||
        action === "start" ||
        action === "stop",
    ) ?? null
  );
}

/** The label each action's button carries. */
export const SANDBOX_CARD_ACTION_LABEL: Record<SandboxCardAction, string> = {
  suspend: "Suspend",
  resume: "Resume",
  stop: "Stop",
  start: "Start",
  destroy: "Destroy",
};

const STATE_LINE: Record<HostSandboxState, string> = {
  creating:
    "Provisioning and booting. This takes about 10 seconds once capacity is found.",
  awake: "Running. Billed at the awake rate.",
  suspending: "Suspending. Billing moves to storage.",
  suspended:
    "Suspended, resumes on your next action. Billed at the storage rate.",
  resuming: "Resuming. Back in a few seconds.",
  stopping: "Stopping. Its disk is kept; running processes end.",
  stopped:
    "Stopped. Disk kept, processes ended. Start boots it again; shells marked relaunch-on-restart come back.",
  starting: "Starting. Booting from its disk.",
  destroying: "Destroying. Its disk is being deleted.",
  destroyed: "Destroyed. Its disk is gone and nothing more is billed.",
  failed: "Failed to start.",
  released: `${hostSandboxStateWord("released")}, files kept. The next shell starts it.`,
};

/** "Nov 7, 2026", in the reader's own zone: for an instant that happened. */
export function formatSandboxDay(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * The frozen banner's sentence. The removal date shows only when the server
 * says when the row froze (`frozenAt`); a server from before that field gets
 * the sentence without it.
 */
export function sandboxFrozenLine(frozenAt: number | null): string {
  const base = `${HOST_FROZEN_WORD}. Top up to resume.`;
  const clock = sandboxFrozenClock(frozenAt);
  // The clock is the removal clause. This banner is a sentence, so it
  // closes that clause with a period the clause itself does not carry.
  return clock === null ? base : `${base} ${clock}.`;
}

/**
 * The withdrawal notice: when this sandbox stops running, and what the person
 * keeps when it does. `null` until a withdrawal is announced for the row's
 * kind of sandbox, which is every row today.
 *
 * What survives the withdrawal is what the person can act on, so the sentence
 * always carries it. The DATE is carried only when nothing else decides when
 * this row ends: `destroyAt` wins wherever it is set, because the row then
 * ends on that day rather than on the announced one. A frozen withdrawn row
 * is the case that makes the difference: while its `frozenAt` is known it
 * carries a day-30 `destroyAt`, which can fall well before the announced
 * day, so naming the announced day here would tell the person the row lasts
 * longer than it does. A frozen row whose `frozenAt` is absent is NOT that
 * case — `sandbox-day-30.ts` skips such a record, so it has no day-30
 * deadline to contradict, `destroyAt` is null, and the announced day is
 * named like any unfrozen row's.
 *
 * The day, where it is named, is the announced one read in UTC: no clock
 * time, because nothing ends the row at an instant — the date is what was
 * announced, and the drain is operational.
 */
export function sandboxWithdrawalLine(
  endsAt: number | null,
  destroyAt: number | null,
): string | null {
  if (endsAt === null) return null;
  // The half the person acts on, the same either way: whether the announced
  // day is named is the only difference between the two sentences.
  const rebuilt =
    "is rebuilt from your environment. Files outside the repository are lost.";
  return destroyAt === null
    ? `This sandbox stops running on ${formatSandboxUtcDay(endsAt)} and ${rebuilt}`
    : `This sandbox stops running and ${rebuilt}`;
}

/**
 * Who made a team sandbox, as the words that follow "Created by", or `null`
 * when the server does not say (a personal sandbox, or a server before the
 * field).
 */
export function sandboxCreatorName(
  summary: SandboxSummary,
  viewerUserId: string | null,
): string | null {
  const creator = summary.createdBy;
  if (creator === null) return null;
  return memberWords(creator, viewerUserId, CREATOR_WORDS);
}

/**
 * Who pays for the running wake of a team sandbox, while it is
 * awake; `null` asleep, frozen, or when the server names no payer.
 */
export function sandboxWakePayerName(
  state: HostSandboxState | null,
  frozen: boolean,
  summary: SandboxSummary,
  viewerUserId: string | null,
): string | null {
  const payer = summary.wakePayer;
  if (state !== "awake" || frozen || payer === null) return null;
  return viewerUserId !== null && payer.userId === viewerUserId
    ? "You"
    : (payer.displayName ?? "A team member");
}

/** A frozen team sandbox: the paying member's bundle ran out. */
export function sandboxTeamFrozenLine(
  summary: SandboxSummary | null,
  viewerUserId: string | null,
): string {
  const payer = summary === null ? null : summary.wakePayer;
  if (payer === null) return `${HOST_FROZEN_WORD}: its payer's bundle is out.`;
  if (viewerUserId !== null && payer.userId === viewerUserId) {
    return `${HOST_FROZEN_WORD}: your bundle is out.`;
  }
  return payer.displayName === null
    ? `${HOST_FROZEN_WORD}: its payer's bundle is out.`
    : `${HOST_FROZEN_WORD}: ${payer.displayName}'s bundle is out.`;
}

/** A team pod's room, from the pod list's `headroom` and `liveShells`. */
export function sandboxPodRoomLine(
  headroom: number,
  liveShells: number,
): string {
  const room =
    headroom === 0
      ? "No room for another shell"
      : `Room for ${headroom} more ${headroom === 1 ? "shell" : "shells"}`;
  const live =
    liveShells === 0
      ? "no live shells"
      : `${liveShells} live ${liveShells === 1 ? "shell" : "shells"}`;
  return `${room} · ${live}`;
}

/**
 * Whether the card mounts the personal cost view. The cost read lists only
 * the person's own sandboxes, so a team card (pods included) has no entry in
 * it; its payer line says whose bundle the wake is on instead.
 */
export function sandboxCardShowsCostView(teamOwned: boolean): boolean {
  return !teamOwned;
}

/** How a line names a member: the viewer, a named member, an unnamed one. */
interface MemberWords {
  readonly viewer: string;
  readonly named: (displayName: string) => string;
  readonly unnamed: string;
}

const CREATOR_WORDS: MemberWords = {
  viewer: "you",
  named: (displayName) => displayName,
  unnamed: "a team member",
};

function memberWords(
  member: SandboxMember,
  viewerUserId: string | null,
  words: MemberWords,
): string {
  if (viewerUserId !== null && member.userId === viewerUserId) {
    return words.viewer;
  }
  return member.displayName === null
    ? words.unnamed
    : words.named(member.displayName);
}

/** The control plane's code for a host that refused a newer `chat.db`. */
const CHAT_STORE_NEWER_CODE = "chat-store-newer";

/** Why a stopped sandbox's last start did not complete, in the person's terms. */
function stoppedFailureLine(failureCode: string): string {
  if (failureCode === CHAT_STORE_NEWER_CODE) {
    return "This sandbox's data was saved by a newer version of Traycer, so it can't start yet. Start it again after the next Traycer update.";
  }
  const reference = sandboxSupportReference(failureCode);
  return reference === null
    ? "The last start didn't finish. Start tries again."
    : `The last start didn't finish (${reference}). Start tries again.`;
}

/** The card's one-line description of where the sandbox is. */
export function sandboxStateLine(
  state: HostSandboxState | null,
  summary: SandboxSummary | null,
): string {
  if (state === null) return "Sandbox";
  if (state === "failed" && summary !== null && summary.failureCode !== null) {
    return `${sandboxFailedToStart(summary.failureCode)}.`;
  }
  // The control plane clears the code only when the row next wakes, so on a
  // stopped row it is a start (or stop) that did not complete: a rolled-back
  // start lands here, and without the reason the person retries forever.
  if (state === "stopped" && summary !== null && summary.failureCode !== null) {
    return stoppedFailureLine(summary.failureCode);
  }
  if (state === "awake" && summary?.kind === "automation") {
    return "Running.";
  }
  return STATE_LINE[state];
}

/** Operational facts stay on Installation; the header owns state and rate. */
export function sandboxOperationalLine(
  state: HostSandboxState | null,
  frozen: boolean,
): string | null {
  if (frozen || state === null) return null;
  switch (state) {
    case "awake":
    case "suspending":
    case "resuming":
    case "starting":
    case "failed":
      return null;
    case "creating":
      return "This takes about 10 seconds once capacity is found.";
    case "stopping":
      return "Its disk is kept; running processes end.";
    case "stopped":
      return "Disk kept, processes ended. Start boots it again; shells marked relaunch-on-restart come back.";
    case "suspended":
      return "Resumes on your next action.";
    case "released":
      return "Files kept. The next shell starts it.";
    case "destroying":
      return "Its disk is being deleted.";
    case "destroyed":
      return "Its disk is gone.";
  }
}

/** A stable state's list price: compute or one of the two storage rates. */
export type SandboxPriceField = "awakeMc" | "suspendedMc" | "stoppedMc";

/**
 * A stable state's price field. A transition's billed entry state is absent
 * from the summary, so its rate must come from the ledger instead.
 */
export function sandboxBilledPriceField(
  state: HostSandboxState,
): SandboxPriceField | null {
  switch (state) {
    case "awake":
      return "awakeMc";
    case "suspended":
      return "suspendedMc";
    case "stopped":
      return "stoppedMc";
    case "resuming":
    case "starting":
    case "suspending":
    case "stopping":
    case "creating":
    case "released":
    case "destroying":
    case "destroyed":
    case "failed":
      return null;
  }
}

/** The idle period the control plane applies when a row sets none. */
export const SANDBOX_DEFAULT_IDLE_MINUTES = 30;

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours} h` : `${hours.toFixed(1)} h`;
}

/**
 * The idle rule as the card states it. A burst sandbox is destroyed, not
 * suspended, once idle for its period; the Automations
 * row is released, its files kept, once no shell has run for its period.
 * Once released, the state line already says the files are kept and the next
 * shell starts it, so the rule keeps only its period.
 */
export function sandboxIdleLine(
  summary: SandboxSummary,
  state: HostSandboxState | null,
): string {
  const minutes = summary.idleMinutes ?? SANDBOX_DEFAULT_IDLE_MINUTES;
  if (summary.kind === "automation") {
    return state === "released"
      ? `Stops after ${formatMinutes(minutes)} idle`
      : `Stops after ${formatMinutes(minutes)} idle · files kept · the next shell starts it`;
  }
  return summary.burst
    ? `Destroyed after ${formatMinutes(minutes)} idle`
    : `Suspends after ${formatMinutes(minutes)} idle`;
}

/**
 * What a suspend keeps on this sandbox's provider,
 * from the catalogue's `suspendFidelity`, or `null` for a value this
 * build does not know.
 */
export function sandboxSuspendKeepsLine(
  suspendFidelity: string,
): string | null {
  switch (suspendFidelity) {
    case "memory":
      return "keeps memory";
    case "disk":
      return "keeps disk only · processes restart on resume";
    case "none":
      return "restarts from its image";
    default:
      return null;
  }
}

/** The translated setup failure, absent once settings apply or before a report. */
export function sandboxGuestConfigFailure(
  summary: SandboxSummary,
): string | null {
  return summary.guestConfigured === false
    ? sandboxGuestConfigFailureReason(summary.guestConfigFailureReason)
    : null;
}

/** Setup reasons are diagnostic tokens; the banner and repair result share copy. */
export function sandboxGuestConfigFailureReason(reason: string | null): string {
  switch (reason) {
    case "guest-config":
      return "Sandbox settings couldn't be applied.";
    case "canary":
      return "The sandbox couldn't connect to Traycer.";
    case "guest-runtime-unavailable":
      return "Sandbox setup isn't available right now.";
    default:
      return "Settings did not apply. Agents can't start here until they do.";
  }
}

/**
 * Whether brokered traffic flows on an awake sandbox, from the phase its host
 * last reported (`SandboxSummary.phase`). The card says "ready" on this and
 * not on the host merely being up: a sandbox whose host answers while its
 * gateway connection is still being proven cannot use a single secret yet.
 */
export interface SandboxSecretsReadiness {
  readonly tone: "ready" | "pending" | "degraded";
  readonly text: string;
}

/**
 * Whether what the sandbox's host last reported (its phase, its per-route
 * readiness) can still be shown. Nothing ages those reports: an idle
 * sandbox's host reports nothing, by design. So they stand only while the
 * host's own health - the verdict the host switcher shows - says it is
 * reachable; a host that went offline says nothing rather than a state it can
 * no longer vouch for. `reported-reachable` keeps them: it is the healthy
 * reading of a host this window never dialled.
 */
export function sandboxHostVouches(hostState: HostHealthState): boolean {
  return hostState === "online" || hostState === "reported-reachable";
}

/**
 * `null` when there is nothing to say: the sandbox is not awake (its grants
 * are refused until it is, and the state line already says where it stands),
 * its host is not reachable, the server reports no phase (one from before the
 * field, or a sandbox with no brokered secrets), or the phase is one this
 * build does not know - which is shown as nothing, never as ready.
 *
 * The phase is the one the host LAST reported, so the line stands only while
 * `sandboxHostVouches(hostState)`.
 */
export function sandboxSecretsReadiness(
  state: HostSandboxState | null,
  frozen: boolean,
  summary: SandboxSummary,
  hostState: HostHealthState,
): SandboxSecretsReadiness | null {
  if (frozen || state !== "awake" || summary.phase === null) return null;
  if (!sandboxHostVouches(hostState)) return null;
  const phase = parseSandboxHeartbeatPhase(summary.phase);
  switch (phase.kind) {
    case "proxy-reachable":
    case "ready":
      return { tone: "ready", text: "Ready: brokered traffic is flowing" };
    case "enrolling":
    case "proving":
    case "attaching":
      return {
        tone: "pending",
        text: "Connecting to Traycer's gateway. Secrets work once it is ready.",
      };
    case "degraded":
      return {
        tone: "degraded",
        text: "Degraded: requests to granted destinations are refused until it recovers.",
      };
    case "unknown":
      return null;
  }
}

/**
 * What a tab on a sandbox host shows over its last screen while the sandbox
 * is not awake, or `null` for a tab
 * that renders normally.
 */
export type SandboxTileOverlay =
  | { readonly kind: "frozen" }
  | {
      readonly kind: "asleep";
      readonly message: string;
      readonly verb: SandboxLifecycleVerb;
      readonly label: string;
    }
  | { readonly kind: "moving"; readonly message: string };

export function sandboxTileOverlay(
  state: HostSandboxState | null,
  frozen: boolean,
): SandboxTileOverlay | null {
  if (frozen) return { kind: "frozen" };
  switch (state) {
    case "suspending":
    case "suspended":
      return {
        kind: "asleep",
        message: `${hostSandboxStateWord(state)}, resumes on your next action`,
        verb: "resume",
        label: "Resume",
      };
    case "stopping":
    case "stopped":
      return {
        kind: "asleep",
        message: hostSandboxStateWord(state),
        verb: "start",
        label: "Start",
      };
    // The Automations row at rest: `start` opens it, with its files kept.
    case "released":
      return {
        kind: "asleep",
        message: hostSandboxStateWord(state),
        verb: "start",
        label: "Start",
      };
    case "resuming":
      return { kind: "moving", message: hostSandboxStateWord(state) };
    case "starting":
      return { kind: "moving", message: hostSandboxStateWord(state) };
    // Awake renders normally; creating, failed and destroyed are the tile's
    // own connection states, which it already shows.
    case "creating":
    case "awake":
    case "destroying":
    case "destroyed":
    case "failed":
    case null:
      return null;
  }
}

/** Failure details accompany the state word rather than replacing the header. */
export function sandboxHeaderFailureLine(sandbox: {
  readonly state: HostSandboxState | null;
  readonly frozen: boolean;
  readonly summary: SandboxSummary | null;
}): string | null {
  if (sandbox.frozen) return null;
  if (sandbox.state === "failed")
    return sandboxStateLine(sandbox.state, sandbox.summary);
  if (
    sandbox.state === "stopped" &&
    sandbox.summary !== null &&
    sandbox.summary.failureCode !== null
  )
    return sandboxStateLine(sandbox.state, sandbox.summary);
  return null;
}

export function sandboxHeaderNeedsRepair(
  summary: SandboxSummary,
  state: HostSandboxState | null,
  frozen: boolean,
  supported: boolean,
): boolean {
  return (
    state === "awake" &&
    !frozen &&
    summary.phase !== null &&
    summary.guestConfigured === false &&
    supported
  );
}

/** The host page offers only Destroy when credits run out, so names no wake remedy. */
export function sandboxHeaderCreditsLine(
  summary: SandboxSummary | null,
  teamOwned: boolean,
  teamName: string | null,
  viewerUserId: string | null,
): string {
  const payer = summary?.wakePayer ?? null;
  let payerName = "Its payer's";
  if (payer !== null)
    payerName =
      payer.userId === viewerUserId
        ? "Your"
        : `${payer.displayName ?? "A member"}'s`;
  const credits = teamOwned
    ? `${payerName} ${teamName ?? "team"} credits ran out`
    : "Your credits ran out";
  const frozenAt = summary?.frozenAt ?? null;
  const destroyAt =
    summary?.destroyAt ??
    (frozenAt === null ? null : frozenDestroyAt(frozenAt));
  return destroyAt === null
    ? credits
    : `${credits} · Will be removed on ${formatSandboxDate(destroyAt, true)}`;
}

export function sandboxSessionNotice(
  summary: SandboxSummary,
  state: HostSandboxState | null,
  now: number,
  filesOutcomeStated: boolean,
): string | null {
  const detail = summary.operation?.outcomeDetail ?? "";
  const converting =
    "Your paused session has expired. Your sandbox is being stopped.";
  switch (state) {
    case "starting":
    case "resuming":
      if (detail === "wake-retry") return "Restarting your sandbox";
      return detail === "suspended-session-expiry" ? converting : null;
    case "stopping":
      return detail === "suspended-session-lost" ? converting : null;
    case "awake":
      return detail === "wake-retried"
        ? "Your paused session was lost when your sandbox restarted. Your files are unchanged."
        : null;
    case "stopped":
      if (
        detail !== "suspended-session-lost" &&
        !isStoppedWakeRetryDetail(detail)
      )
        return null;
      return filesOutcomeStated
        ? "Your paused session was lost when your sandbox stopped."
        : "Your paused session was lost when your sandbox stopped. Your files are unchanged.";
    case "suspended":
      return suspendedSessionWarning(summary.suspendedSessionEndsAt, now);
    default:
      return null;
  }
}

function suspendedSessionWarning(
  at: number | null | undefined,
  now: number,
): string | null {
  if (at === undefined || at === null || at - now > 7 * 86_400_000) return null;
  return `Your paused session will be lost on ${formatSandboxDay(at)}. Resume your sandbox before then to keep it.`;
}

function isStoppedWakeRetryDetail(detail: string): boolean {
  return (
    detail === "wake-retry" ||
    detail === "wake-retry-failed" ||
    detail.startsWith("wake-retry:")
  );
}
