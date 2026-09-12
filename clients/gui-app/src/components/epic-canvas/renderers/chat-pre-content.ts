import type {
  HostLeaseDeadState,
  HostLeaseSnapshot,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { IncompatibilityUpgradeGuidance } from "@traycer/protocol/framework/index";
import { HOST_OLDER_THAN_DATA_FATAL_CODE } from "@traycer/protocol/host/store-formats";
import type {
  HostReachability,
  HostReachabilityHostKind,
  HostReachabilityStatus,
} from "@/hooks/agent/use-host-reachability";
import { HOST_UPDATE_SKEW_COPY } from "@/lib/host/version-skew-copy";
import {
  createReportIssueContext,
  type ReportIssueContext,
} from "@/lib/report-issue-context";
import type { PreSnapshotRetryEvidence } from "@/stores/chats/chat-session-store";
import { tileDeadMessage, tileHostName } from "./tile-host-load-copy";

/**
 * Everything the chat tile shows before it has a transcript, as pure
 * functions: the axes it is decided on, the six arms, their words, and the
 * report a person can send from them.
 *
 * Two bodies used to cover this wait with two budgets: `TileHostLoadState`
 * while the session handle was still null (the shared 15s tile budget), and a
 * pre-snapshot gate once it existed (its own 20s pane, which offered Retry for
 * a load that was slow but healthy). One classifier now decides both, so the
 * whole matrix is asserted without mounting anything, as
 * `tile-host-load-copy.ts` is. `chat-tile-runtime-gate.tsx` renders it; this
 * module holds no components, for Fast Refresh.
 *
 * The rules it encodes:
 *
 * - Name the host, and say only what is true.
 * - Escalate on evidence. Time alone only adds a line saying the load is taking
 *   longer. The buttons come at the deadline, after three refusals from a host
 *   that is up, or at once when nothing is retrying.
 * - No error styling without a verdict from the host.
 * - One narrator per scope: the body never repeats the strip above it, and
 *   never contradicts it.
 */

/**
 * How many failed attempts in one wait, while the host is up, before the tile
 * offers its buttons ahead of the deadline.
 *
 * Three, because two is one retry - the shape of a host restart or a
 * sleep-wake redial, both of which recover on their own. The third failure is
 * the first one that is a pattern. It counts only while the host is up: failed
 * dials while a host starts or restarts are expected, not evidence.
 */
export const STALLED_CHAT_LOAD_ATTEMPTS = 3;

/**
 * When the body adds a line saying the load is taking longer. No buttons:
 * nothing has failed yet.
 *
 * A warm open takes 0.4-1.9s, so 20s is unusual. It is not yet a failure: the
 * worst open measured right after a host restart took 21.8s.
 */
export const STALLED_CHAT_LOAD_ELAPSED_MS = 20_000;

/**
 * When Try again and Report issue appear however the wait looks. This is
 * invariant 6's deadline and terminal presentation for a wait that no host
 * verdict ends.
 *
 * Equal to `LINK_DOWN_ESCALATION_MS`, deliberately. When the wait began at a
 * link drop, the epic pill's "Still reconnecting…" and these buttons arrive
 * together; when it began later, the tile escalates after the pill. Either
 * way the two never contradict each other.
 *
 * It does not pause while the host restarts, even while the lease vouches for
 * the restart. Only the strip waits for the lease. A host that keeps flapping
 * must still reach a terminal state, and 60s covers a restart plus a cold
 * open.
 */
export const CHAT_LOAD_DEADLINE_MS = 60_000;

/**
 * The fatal-close fields this presentation reads. A structural subset of
 * `FatalErrorDetails` rather than the type itself: it names exactly what the
 * words depend on, so a caller can hand over a whole close and the compiler
 * still holds this module to the three fields it uses.
 */
export interface ChatTileFatalDetails {
  readonly code: string;
  readonly reason: string;
  readonly upgradeGuidance: IncompatibilityUpgradeGuidance | null;
}

/**
 * One wait for this chat's first transcript.
 *
 * Recorded by `ChatTile`, above its handle branch, and not by the body. The
 * body renders in two different subtrees - the handle-pending branch and the
 * session view - so a wait kept in the body would start over when the handle
 * arrived, and a handle that took 40s would push the buttons out to 100s.
 */
export interface ChatLoadWait {
  /**
   * The tile's first render for this chat, or the last Try again.
   *
   * The tile can only anchor the waits it can see. A `retry()` from one of the
   * three automatic callers begins a later wait without a click, and the
   * SESSION stamps that one - see `chatLoadWaitBeganAt`.
   */
  readonly startedAt: number;
  /**
   * Failed attempts the store had already counted when this wait began.
   *
   * Zero for a first render. For a Try again it is the streak's count at the
   * click, so the click starts the refusal count over as well as the clock.
   * The store keeps its streak across the click on purpose, because the
   * failures are evidence about the host, and the report still carries every
   * one of them.
   */
  readonly attemptsBefore: number;
  /**
   * Whether the streak's own start can move this wait earlier.
   *
   * True for a first render, so a tile that mounts into a stall already in
   * progress inherits it instead of restarting the budget. False after a Try
   * again, whose wait begins at the click: without that, a streak older than
   * the deadline would declare the new attempt overdue on sight.
   */
  readonly inheritsStreak: boolean;
}

/** What `ChatTile` hands both pre-content bodies from above its handle branch. */
export interface ChatTilePreContentFrame {
  readonly wait: ChatLoadWait;
  /** Begins a new wait at Try again, given the streak's count at the click. */
  readonly restartWait: (attemptsNow: number) => void;
  /**
   * The reachability the tile's strip is drawn from. Handed down rather than
   * read again, because `useHostReachability` keeps its starting deadline in
   * component state: a second instance mounted later would let the body's
   * strip axis say "starting" while the strip on screen had already fallen to
   * offline.
   */
  readonly reachability: HostReachability;
}

/**
 * When the wait began: the anchor, a LATER episode that supersedes it, or an
 * older streak the anchor inherits.
 *
 * The anchor is the tile's first render for this chat, which is the start of
 * the FIRST wait and of no other. `retry()` puts a loaded session back into a
 * pre-snapshot wait - the wake pulse, the plan-restricted reprobe and the
 * host-version move all do it to a tile whose transcript is on screen - and
 * the session stamps that instant (`preSnapshotReloadStartedAt`). A tile
 * mounted longer ago than the deadline would otherwise call the replacement
 * subscription overdue on its first frame, which is the one thing this whole
 * body exists not to do.
 *
 * Later wins, both ways round: a Try again pressed inside such an episode
 * anchors the wait at the click, which is newer than the stamp.
 */
export function chatLoadWaitBeganAt(
  wait: ChatLoadWait,
  retries: PreSnapshotRetryEvidence | null,
  reloadStartedAt: number | null,
): number {
  if (supersededByReload(wait, reloadStartedAt)) {
    // A streak cannot reach back past an episode that began after it.
    return reloadStartedAt;
  }
  if (!wait.inheritsStreak || retries === null) return wait.startedAt;
  return Math.min(wait.startedAt, retries.firstAt);
}

/** Failed attempts counted since the wait began. See `ChatLoadWait`. */
export function chatLoadAttemptsThisWait(
  wait: ChatLoadWait,
  retries: PreSnapshotRetryEvidence | null,
  reloadStartedAt: number | null,
): number {
  const count = retries?.count ?? 0;
  // Both halves of the anchor move together, or the arms disagree about which
  // wait they are in. A later episode's streak starts from zero - the snapshot
  // that ended the previous wait cleared `preSnapshotRetries` - so subtracting
  // an earlier wait's `attemptsBefore` would hide this episode's own refusals
  // until they passed a count that is no longer about anything.
  if (supersededByReload(wait, reloadStartedAt)) return count;
  return Math.max(0, count - wait.attemptsBefore);
}

/**
 * Whether a later pre-content episode has superseded the tile's anchor - the
 * one condition both halves of {@link ChatLoadWait} are read through.
 */
function supersededByReload(
  wait: ChatLoadWait,
  reloadStartedAt: number | null,
): reloadStartedAt is number {
  return reloadStartedAt !== null && reloadStartedAt > wait.startedAt;
}

/**
 * The host's verdict on this attempt: none, a verdict, or a verdict whose
 * remedy is updating the host.
 */
export type ChatPreContentFatal = "none" | "verdict" | "host-update";

/**
 * What the lease says about the host, read together with the strip.
 *
 * `unknown` is a real answer: no lease (this window's kernel has not
 * attached), or a lease that says the host is up while the strip on screen
 * says it is offline. Presenting that pair as up would put "Loading from X"
 * under a banner saying X is offline.
 */
export type ChatPreContentHost =
  | "dead"
  | "up"
  | "restarting"
  | "starting"
  | "unknown";

/**
 * Which strip `ChatTile` shows above the body: `ChatHostStartingBanner`, the
 * dead-tile banner, or nothing.
 */
export type ChatPreContentStrip = "starting" | "offline" | "none";

/**
 * What the stream has shown so far, first match wins (see
 * `chatPreContentEvidence`).
 */
export type ChatPreContentEvidence =
  | "no-handle"
  | "stalled-closed"
  | "refused"
  | "silent"
  | "reconnecting"
  | "connecting";

/** Under 20s, 20-60s, or 60s and more since the wait began. */
export type ChatPreContentElapsed = "early" | "slow" | "overdue";

export interface ChatPreContentAxes {
  readonly fatal: ChatPreContentFatal;
  readonly host: ChatPreContentHost;
  readonly strip: ChatPreContentStrip;
  readonly evidence: ChatPreContentEvidence;
  readonly elapsed: ChatPreContentElapsed;
}

/** The session's side of the wait; absent while the tile has no handle. */
export interface ChatPreContentSession {
  readonly fatalClose: ChatTileFatalDetails | null;
  readonly connectionStatus: StreamConnectionStatus;
  readonly retries: PreSnapshotRetryEvidence | null;
  /** See `chatLoadAttemptsThisWait`. */
  readonly attemptsThisWait: number;
}

export interface ChatPreContentInput {
  /** `null` while the tile has no session handle: no store, no stream. */
  readonly session: ChatPreContentSession | null;
  readonly lease: HostLeaseSnapshot | null;
  readonly reachabilityStatus: HostReachabilityStatus;
  readonly hostKind: HostReachabilityHostKind;
  /** `resolvedHostLabel`'s answer: `null` while the directory has no label. */
  readonly hostLabel: string | null;
  /** `hostIsBehindClient` over the two app versions. */
  readonly hostBehindClient: boolean;
  readonly elapsed: ChatPreContentElapsed;
}

export function chatPreContentStrip(
  status: HostReachabilityStatus,
): ChatPreContentStrip {
  switch (status) {
    case "host-starting":
      return "starting";
    case "unreachable":
      return "offline";
    case "checking":
    case "reachable":
      return "none";
  }
}

export function chatPreContentHost(
  lease: HostLeaseSnapshot | null,
  strip: ChatPreContentStrip,
): ChatPreContentHost {
  if (lease === null) return "unknown";
  switch (lease.status) {
    case "dead":
      return "dead";
    case "ready":
    case "degraded":
      return strip === "offline" ? "unknown" : "up";
    case "restarting-expected":
      return "restarting";
    case "connecting":
      return "starting";
  }
}

/**
 * What the stream has shown, first match wins.
 *
 * `stalled-closed` is `closed` with no fatal close. `retry()` leaves the store
 * there when its stream factory throws, and nothing retries it after that, so
 * it is the one wait that escalates at once. `silent` is `open` with nothing
 * sent: the host acknowledged the subscribe and has said nothing since.
 */
export function chatPreContentEvidence(
  session: ChatPreContentSession | null,
): ChatPreContentEvidence {
  if (session === null) return "no-handle";
  if (session.connectionStatus === "closed" && session.fatalClose === null) {
    return "stalled-closed";
  }
  if (session.attemptsThisWait >= STALLED_CHAT_LOAD_ATTEMPTS) return "refused";
  if (session.connectionStatus === "open") return "silent";
  if (session.attemptsThisWait >= 1) return "reconnecting";
  return "connecting";
}

export function chatPreContentFatal(
  fatalClose: ChatTileFatalDetails | null,
): ChatPreContentFatal {
  if (fatalClose === null) return "none";
  return fatalRemedyIsHostUpdate(fatalClose) ? "host-update" : "verdict";
}

/** The elapsed axis, from the two deadlines the component watches. */
export function chatPreContentElapsed(
  slow: boolean,
  overdue: boolean,
): ChatPreContentElapsed {
  if (overdue) return "overdue";
  return slow ? "slow" : "early";
}

export function chatPreContentAxes(
  input: ChatPreContentInput,
): ChatPreContentAxes {
  const strip = chatPreContentStrip(input.reachabilityStatus);
  return {
    fatal: chatPreContentFatal(input.session?.fatalClose ?? null),
    host: chatPreContentHost(input.lease, strip),
    strip,
    evidence: chatPreContentEvidence(input.session),
    elapsed: input.elapsed,
  };
}

export type ChatPreContentKind =
  | "failed"
  | "failed-host-update"
  | "host-gone"
  | "taking-too-long"
  | "waiting-for-host"
  | "loading";

/**
 * Which of the six arms the body is in, and the only place that decides.
 *
 * The order is the precedence, and each step knows more than the one after
 * it. A fatal close is the host's own verdict on this attempt. A dead lease is
 * the authority's verdict on the host, which outranks the deadline: a reader
 * should be told the host is gone, not that the agent is taking long. Then
 * the evidence that earns the buttons - a store with nothing retrying it, the
 * deadline, or three refusals from a host that is up. Refusals while the host
 * is not up are expected, so they wait for the deadline like everything else.
 * What remains is an ordinary wait, named by whether the host is up.
 */
export function classifyChatPreContent(
  axes: ChatPreContentAxes,
): ChatPreContentKind {
  if (axes.fatal === "verdict") return "failed";
  if (axes.fatal === "host-update") return "failed-host-update";
  if (axes.host === "dead") return "host-gone";
  if (
    axes.evidence === "stalled-closed" ||
    axes.elapsed === "overdue" ||
    (axes.host === "up" && axes.evidence === "refused")
  ) {
    return "taking-too-long";
  }
  return axes.host === "up" ? "loading" : "waiting-for-host";
}

/** Everything the component renders for one arm. */
export interface ChatPreContentView {
  readonly kind: ChatPreContentKind;
  readonly headline: string;
  /** The second line, or `null` for none. */
  readonly detail: string | null;
  /**
   * Whether this attempt is over, which only a host verdict can say. It
   * decides the two things that follow from that one fact and must not
   * disagree: a settled failure is announced assertively under a warning mark,
   * and a wait is announced politely, so a reader hears it change either way.
   * The element is a live region in BOTH states - it is the same element, and
   * a region that stops being live at the instant its content changes
   * announces nothing at all.
   */
  readonly settled: boolean;
  /** Whether something is still running, and so whether the spinner shows. */
  readonly spinner: boolean;
  /** A card for the arms that offer a choice, plain words for a calm wait. */
  readonly layout: "card" | "plain";
  readonly offersHostUpdate: boolean;
  /** Never without a handle: there is no store to retry. */
  readonly offersTryAgain: boolean;
  /** Only where something failed or ran out of time. */
  readonly offersReport: boolean;
  /** The host's own code, when the stream has carried one. */
  readonly code: string | null;
}

const KEEPS_RETRYING = "This keeps retrying on its own.";

export function describeChatPreContent(
  input: ChatPreContentInput,
): ChatPreContentView {
  const axes = chatPreContentAxes(input);
  const kind = classifyChatPreContent(axes);
  const host = tileHostName(input.hostLabel);
  const hasHandle = input.session !== null;
  const code = input.session?.retries?.code ?? null;
  switch (kind) {
    case "failed":
    case "failed-host-update": {
      const fatal = fatalCloseOf(input);
      const copy = describeFatalCopy(fatal);
      return {
        kind,
        headline: copy.paneTitle,
        // The reason's `CODE: ` prefix repeats the code the report carries.
        detail: fatal.reason.replace(/^[A-Z_]+:\s*/, ""),
        settled: true,
        spinner: false,
        layout: "card",
        offersHostUpdate: copy.offersHostUpdate,
        offersTryAgain: hasHandle,
        offersReport: true,
        code: fatal.code,
      };
    }
    case "host-gone":
      return {
        kind,
        headline: tileDeadMessage(deadStateOf(input), "agent", input.hostLabel),
        detail: null,
        settled: false,
        spinner: false,
        layout: "plain",
        offersHostUpdate: false,
        offersTryAgain: hasHandle,
        offersReport: true,
        code,
      };
    case "taking-too-long":
      return {
        kind,
        headline: input.hostBehindClient
          ? HOST_UPDATE_SKEW_COPY.title
          : "This agent hasn't loaded yet.",
        detail: takingTooLongDetail(axes, input, host),
        settled: false,
        // Loading continues underneath, unless the store is closed with
        // nothing retrying it, or there is no store at all.
        spinner: hasHandle && axes.evidence !== "stalled-closed",
        layout: "card",
        offersHostUpdate: input.hostBehindClient,
        offersTryAgain: hasHandle,
        offersReport: true,
        code,
      };
    case "waiting-for-host":
      return {
        kind,
        headline: waitingForHostHeadline(axes, input.hostKind, host),
        detail: axes.elapsed !== "early" && hasHandle ? KEEPS_RETRYING : null,
        settled: false,
        // Under an offline strip with no handle nothing is running: the tile
        // opens when the host's entry returns.
        spinner: !(axes.strip === "offline" && !hasHandle),
        layout: "plain",
        offersHostUpdate: false,
        offersTryAgain: false,
        offersReport: false,
        code,
      };
    case "loading":
      return {
        kind,
        headline: `Loading this agent from ${host}…`,
        detail:
          axes.elapsed === "early" ? null : loadingDetail(axes.evidence, host),
        settled: false,
        spinner: true,
        layout: "plain",
        offersHostUpdate: false,
        offersTryAgain: false,
        offersReport: false,
        code,
      };
  }
}

/**
 * What Report issue sends from this body.
 *
 * Arms 1 and 2 report the host's verdict and its code, as they always have.
 * The rest report the wait itself, built only from fixed copy and stable
 * tokens - never host free text, per `report-issue-context.ts` - and carry the
 * host's code when a retryable close brought one. The component builds this
 * at click time, because `elapsedMs` is only true then.
 */
export function chatPreContentReport(
  input: ChatPreContentInput,
  elapsedMs: number,
): ReportIssueContext {
  const fatalClose = input.session?.fatalClose ?? null;
  if (fatalClose !== null) {
    return createReportIssueContext({
      title: describeFatalCopy(fatalClose).reportTitle,
      message: "The agent could not be opened.",
      code: fatalClose.code,
      source: "Chat",
    });
  }
  const axes = chatPreContentAxes(input);
  return createReportIssueContext({
    title: "This agent hasn't loaded",
    message: [
      `stage=${classifyChatPreContent(axes)}`,
      `evidence=${axes.evidence}`,
      `attempts=${String(input.session?.retries?.count ?? 0)}`,
      `elapsedS=${String(Math.max(0, Math.floor(elapsedMs / 1000)))}`,
      `stream=${input.session?.connectionStatus ?? "none"}`,
      `lease=${leaseToken(input.lease)}`,
      `strip=${axes.strip}`,
    ].join(" "),
    code: input.session?.retries?.code ?? null,
    source: "Chat",
  });
}

/** A dead lease carries its reason, because arm 3's words differ by it. */
function leaseToken(lease: HostLeaseSnapshot | null): string {
  if (lease === null) return "none";
  if (lease.status === "dead") return `dead:${lease.dead.reason}`;
  return lease.status;
}

/**
 * The fatal close behind arms 1 and 2. The classifier answers those two only
 * for a fatal close read off this same input, so this cannot throw; it exists
 * so the words are read off the close rather than a cast.
 */
function fatalCloseOf(input: ChatPreContentInput): ChatTileFatalDetails {
  const fatalClose = input.session?.fatalClose ?? null;
  if (fatalClose === null) {
    throw new Error("A failed arm was classified without a fatal close");
  }
  return fatalClose;
}

/** The dead lease behind arm 3, on the same terms as {@link fatalCloseOf}. */
function deadStateOf(input: ChatPreContentInput): HostLeaseDeadState {
  if (input.lease?.status !== "dead") {
    throw new Error("host-gone was classified without a dead lease");
  }
  return input.lease.dead;
}

function sentenceCase(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function describeAttempts(count: number): string {
  return count === 1 ? "1 attempt" : `${String(count)} attempts`;
}

/**
 * Arm 5's headline, by strip first: under a strip the body says what happens
 * to this agent and leaves the host's state to the strip, and with no strip it
 * says what it is waiting on.
 *
 * Under an offline strip the host cannot be restarting, because
 * `useHostReachability` turns an expected restart back to `host-starting`.
 * `up` and `dead` never reach this arm; they share the no-strip default.
 */
function waitingForHostHeadline(
  axes: ChatPreContentAxes,
  hostKind: HostReachabilityHostKind,
  host: string,
): string {
  if (axes.strip === "starting") {
    return `This agent will open once ${host} is ready.`;
  }
  if (axes.strip === "offline") {
    return `This agent will open once ${host} is available.`;
  }
  switch (axes.host) {
    case "restarting":
      return `Waiting for ${host} to restart…`;
    case "starting":
      // A local host starting is a process booting on this machine; a remote
      // one is only a connection this client has not made yet.
      return hostKind === "local"
        ? `Waiting for ${host} to start…`
        : `Connecting to ${host}…`;
    case "unknown":
    case "up":
    case "dead":
      return `Connecting to ${host}…`;
  }
}

/** Arm 4's second line, first match wins. */
function takingTooLongDetail(
  axes: ChatPreContentAxes,
  input: ChatPreContentInput,
  host: string,
): string {
  const evidence = axes.evidence;
  const Host = sentenceCase(host);
  if (evidence === "stalled-closed") {
    return `The connection to ${host} was lost.`;
  }
  if (axes.strip === "offline") {
    return `It will open here once ${host} is available.`;
  }
  if (axes.host === "restarting") {
    return `${Host} is still restarting. ${KEEPS_RETRYING}`;
  }
  if (axes.host === "starting" && input.hostKind === "local") {
    return `${Host} hasn't started yet. ${KEEPS_RETRYING}`;
  }
  if (axes.host === "starting" || axes.host === "unknown") {
    return `${Host} hasn't answered yet. ${KEEPS_RETRYING}`;
  }
  switch (evidence) {
    case "refused":
      return `${Host} has not opened it after ${describeAttempts(input.session?.retries?.count ?? 0)}. ${KEEPS_RETRYING}`;
    case "silent":
      return `${Host} is connected but hasn't sent it yet. It will appear here as soon as it arrives.`;
    case "connecting":
      return `${Host} hasn't accepted the connection yet. ${KEEPS_RETRYING}`;
    case "reconnecting":
      return `Still reconnecting to ${host}. ${KEEPS_RETRYING}`;
    case "no-handle":
      return `${Host} hasn't answered.`;
  }
}

/** Arm 6's second line from 20s, by what the stream has shown. */
function loadingDetail(evidence: ChatPreContentEvidence, host: string): string {
  switch (evidence) {
    case "silent":
      return `Taking longer than usual. It will appear here as soon as ${host} sends it.`;
    case "connecting":
      return `Still connecting to ${host}. ${KEEPS_RETRYING}`;
    case "reconnecting":
      return `Reconnecting to ${host}. ${KEEPS_RETRYING}`;
    // No handle yet: there is no connection to describe, only the wait.
    // `refused` and `stalled-closed` never reach this arm; both escalate
    // while the host is up.
    case "no-handle":
    case "refused":
    case "stalled-closed":
      return "Taking longer than usual.";
  }
}

interface ChatTileFatalCopy {
  readonly paneTitle: string;
  readonly reportTitle: string;
  readonly offersHostUpdate: boolean;
}

/**
 * What a fatal close tells the reader to DO.
 *
 * The host-update arm is decided by the host's own statements and never by
 * relative versions, which is the whole point: `HOST_OLDER_THAN_DATA` says a
 * store on that machine was written by a build newer than the one serving it,
 * so an app at 1.3 talking to a host at 1.4 still needs the HOST to move.
 * Routing this through `describeVersionSkew` answered "Your app is too old"
 * for exactly that case and hid the only action that could help.
 *
 * `CHAT_STORE_UNUSABLE` is the neighbouring code and is deliberately NOT here.
 * The host emits it for a malformed stamp, a shape that disagrees with its
 * stamp, or failed integrity verification, and says so at the emitting site:
 * "the remedy differs - this one needs a repair or a support report, not a
 * host update". Its body is the generic one, whose Report issue is that
 * report.
 */
function describeFatalCopy(details: ChatTileFatalDetails): ChatTileFatalCopy {
  if (fatalRemedyIsHostUpdate(details)) {
    return {
      paneTitle: HOST_UPDATE_SKEW_COPY.title,
      reportTitle: HOST_UPDATE_SKEW_COPY.title,
      offersHostUpdate: true,
    };
  }
  return {
    paneTitle: "This agent could not be opened.",
    reportTitle: "This agent could not be opened",
    offersHostUpdate: false,
  };
}

/**
 * Whether the host has said, one way or the other, that IT is the leg that has
 * to move. The code is the authoritative form; the guidance is the general
 * one, and covers a future code this build has never heard of whose host still
 * marked the direction. Neither is a version comparison.
 */
function fatalRemedyIsHostUpdate(details: ChatTileFatalDetails): boolean {
  if (details.code === HOST_OLDER_THAN_DATA_FATAL_CODE) return true;
  const guidance = details.upgradeGuidance;
  if (guidance === null) return false;
  return guidance.hostShouldUpgrade && !guidance.clientShouldUpgrade;
}
