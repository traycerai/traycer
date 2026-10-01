import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { AgentActivityCloudSyncStatus } from "@traycer/protocol/host/agent/activity";
import type { NotificationFeedMode } from "@/lib/notifications/notification-feed-mode";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";
import {
  buildFocusBackground,
  type FocusBackgroundChat,
} from "@/lib/home-focus/focus-background";
import {
  buildFocusBrowsers,
  focusBrowserTabTitles,
  type FocusBrowsersInput,
} from "@/lib/home-focus/focus-browsers";
import type {
  FocusBackgroundRow,
  FocusBrowserRow,
  FocusDegradedHost,
  FocusDegradedReason,
  FocusModel,
  FocusPromptRow,
  FocusTaskRow,
} from "@/lib/home-focus/focus-model";
import {
  buildFocusPrompts,
  focusPromptEpicIds,
} from "@/lib/home-focus/focus-prompts";
import {
  buildFocusTasks,
  type FocusTasksInput,
} from "@/lib/home-focus/focus-tasks";
import { shallowEqualRow } from "@/lib/home-focus/focus-identity";

/**
 * What `FocusModel` (`focus-model.ts`) means. That file is kept to the
 * interface block alone so it reads as a contract at a glance, which is why the
 * reasoning behind its fields lives here instead.
 *
 * The model is everything happening right now across every task on the host,
 * with the things that need the user first.
 *
 * Read as three independent projections that happen to share a page, because
 * their COVERAGE differs and the difference is user-visible:
 *
 * - `prompts` and `tasks` cover every task the host knows about, opened in this
 *   window or not - the agent-activity stream is per-user and the notification
 *   feed is per-host (per-account in cloud mode).
 * - `background` covers only tasks whose chats are warm in THIS window, because
 *   the only client-side source for a shell or a sub-agent is a live
 *   `chat.subscribe` session. `coverage.backgroundIsMountedOnly` is the literal
 *   `true` rather than a boolean, which puts that limit in the TYPE: a source
 *   that ever covers unmounted tasks cannot be widened into this field without
 *   failing to compile here, where the caption's premise is decided.
 * - `browsers` covers the same narrow set for the same shape of reason: a
 *   browser inventory arrives on a `browser.sessions` stream held by a mounted
 *   canvas, and Home reads that registry without acquiring one of its own
 *   (`use-browser-sessions-plane`). `coverage.browsersAreMountedOnly` records it
 *   in the type the same way.
 *
 * What is missing is missing for a reason, not by omission: there are no agent
 * start timestamps on the activity plane (so no elapsed time), and a received
 * A2A message awaiting a reply has neither a notification kind nor a live
 * index, so it cannot be a prompt row here.
 *
 * Every field is derived; nothing in this module owns state. The builders in
 * this directory are pure and deterministic, and reuse the previous model's
 * rows whenever their content is unchanged, so a store frame that changes
 * nothing re-renders nothing.
 *
 * {@link EMPTY_FOCUS_MODEL} below is that model's zero: the baseline a first
 * build reconciles against. Its `activity: "unknown"` is deliberate - no claim
 * has been made yet, and reading silence as an outage is the mistake the
 * activity store's own attestation marker exists to prevent. Note that an idle
 * app only keeps returning it BY IDENTITY while that stays true: the first
 * `state` frame moves `coverage.activity` off `"unknown"`, which mints a new
 * coverage object and therefore a new model, once.
 */
export const EMPTY_FOCUS_MODEL: FocusModel = Object.freeze({
  prompts: Object.freeze<FocusPromptRow[]>([]),
  tasks: Object.freeze<FocusTaskRow[]>([]),
  background: Object.freeze<FocusBackgroundRow[]>([]),
  browsers: Object.freeze<FocusBrowserRow[]>([]),
  coverage: Object.freeze({
    activity: "unknown",
    degradedHosts: Object.freeze<FocusDegradedHost[]>([]),
    notifications: "local",
    backgroundIsMountedOnly: true,
    browsersAreMountedOnly: true,
  }),
});

export interface FocusActivityHealth {
  readonly connectionStatus: StreamConnectionStatus;
  readonly cloudSyncStatus: AgentActivityCloudSyncStatus | null;
  readonly stateFrameSeenThisEpoch: boolean;
  /** How many hosts this client can currently dial (`useConnectableHostIds`).
   * More than one is what makes a host-local union incomplete rather than
   * merely narrow. */
  readonly connectableHostCount: number;
  /** Whether that count is an ANSWER yet. A directory still loading reports
   * zero hosts, which is indistinguishable from a single-host install by the
   * count alone - and the two want opposite verdicts. */
  readonly connectableHostsResolved: boolean;
}

export interface BuildFocusModelInput {
  /** Every merged notification row, unfiltered. The prompt builder does its own
   * lifecycle classification so its ordering is testable without a store. */
  readonly notificationRows: ReadonlyArray<MergedNotificationRow>;
  readonly tasks: Omit<FocusTasksInput, "promptEpicIds">;
  readonly backgroundChats: ReadonlyArray<FocusBackgroundChat>;
  readonly browsers: FocusBrowsersInput;
  readonly activity: FocusActivityHealth;
  /**
   * The hosts whose OWN slice is degraded, sorted by host id, from the fold
   * that compared them. A separate input from `activity` rather than a field
   * on it: `FocusActivityHealth` is the set of inputs the coverage VERDICT is
   * computed from, and this is an attribution the verdict throws away.
   */
  readonly degradedHosts: ReadonlyArray<FocusDegradedHost>;
  readonly feedMode: NotificationFeedMode;
}

/**
 * The whole model in one pure pass, reusing `previous`'s rows wherever content
 * is unchanged so an unrelated store frame produces no new references at all.
 *
 * Prompts are built first because the task rows read their epic ids: a task
 * whose prompt row is loaded reads `needsYou` even when the host's indicator
 * batch did not cover it.
 *
 * Browsers are built BEFORE prompts for the mirror-image reason: a browser
 * hand-off names a session and a tab, and the tab's title exists only in the
 * browser rows - so the prompt reads the tab from the section below it rather
 * than resolving the plane a second time and risking a name the page is not
 * showing.
 */
export function buildFocusModel(
  input: BuildFocusModelInput,
  previous: FocusModel,
): FocusModel {
  const browsers = buildFocusBrowsers(input.browsers, previous.browsers);
  const prompts = buildFocusPrompts(
    input.notificationRows,
    input.tasks.taskTitles,
    focusBrowserTabTitles(browsers),
    previous.prompts,
  );
  const tasks = buildFocusTasks(
    { ...input.tasks, promptEpicIds: focusPromptEpicIds(prompts) },
    previous.tasks,
  );
  const background = buildFocusBackground(
    input.backgroundChats,
    previous.background,
  );
  const coverage = {
    activity: focusActivityCoverage(input.activity),
    // Reused by identity when the set is unchanged, so a page whose hosts are
    // all healthy frame after frame does not mint a new coverage object (and
    // therefore a new model) on every activity frame.
    degradedHosts: sameDegradedHosts(
      input.degradedHosts,
      previous.coverage.degradedHosts,
    )
      ? previous.coverage.degradedHosts
      : input.degradedHosts,
    notifications: focusNotificationCoverage(input.feedMode),
    backgroundIsMountedOnly: true,
    browsersAreMountedOnly: true,
  } as const;
  const next: FocusModel = {
    prompts,
    tasks,
    background,
    browsers,
    coverage: shallowEqualRow(coverage, previous.coverage)
      ? previous.coverage
      : coverage,
  };
  return shallowEqualRow(next, previous) ? previous : next;
}

function sameDegradedHosts(
  a: ReadonlyArray<FocusDegradedHost>,
  b: ReadonlyArray<FocusDegradedHost>,
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (host, index) =>
        host.hostId === b[index].hostId && host.reason === b[index].reason,
    )
  );
}

/**
 * How far the "Running" section can be trusted right now, read off the activity
 * store's own health fields rather than re-derived from `byEpic`.
 *
 * The store splits this question in two on purpose, and BOTH halves are load
 * bearing here.
 *
 * The first is `agentActivityPlaneAnswers`: an open socket, this epoch's own
 * `state` frame, and a cloud stamp that is not itself degraded. All three,
 * because `servedBy` and `byEpic` survive a stream replacement AND an in-place
 * reconnect, so an open socket alone can be showing the previous connection's
 * union.
 *
 * The second is `agentActivityPlaneSpansFleet`, and it is the one this section
 * actually turns on. The Running list claims to cover EVERY task on the
 * account, so a union that reaches only the serving host is not a narrow-but-
 * true answer here - it is a short list under a caption that says the list is
 * complete. Only a `connected` cloud stamp proves the union reached other
 * machines; `null` is NO CLAIM (a host with no cloud link, or one on the `@1.0`
 * minor that predates the field), never proof of the negative.
 *
 * So a narrow union reads `"unknown"` - but only once the client knows there IS
 * somewhere else to look. A single-host install has nothing beyond its own
 * host, its narrow union is therefore complete, and it keeps reading `"live"`;
 * downgrading it would make every install without a cloud link look blind,
 * which is exactly what the store's own doc warns against.
 *
 * Until the directory has ANSWERED, the fleet's shape is not known either, and
 * an unanswered directory reports zero hosts - which the count alone cannot
 * tell apart from a single-host install. So the loading window also reads
 * `"unknown"`: the honest value while the client cannot say whether anything
 * is missing, and the one that cannot flash a false "complete" caption before
 * settling.
 */
export function focusActivityCoverage(
  health: FocusActivityHealth,
): FocusModel["coverage"]["activity"] {
  const reason = focusActivityDegradedReason(health);
  if (reason === "host-lost" || reason === "cloud-disconnected")
    return "disconnected";
  if (reason !== null) return "reconnecting";
  if (!health.stateFrameSeenThisEpoch) return "unknown";
  if (
    health.cloudSyncStatus !== "connected" &&
    (!health.connectableHostsResolved || health.connectableHostCount > 1)
  ) {
    return "unknown";
  }
  return "live";
}

/**
 * Which link a slice is missing, or `null` when it is not degraded. The
 * coverage verdict above is derived from this, so the reason a notice names is
 * always the one that raised it. A socket that is open but has not yet had
 * this epoch's `state` frame is not degraded - that is `unknown` - so the
 * cloud stamp is only read once the frame has arrived.
 */
export function focusActivityDegradedReason(
  health: Pick<
    FocusActivityHealth,
    "connectionStatus" | "cloudSyncStatus" | "stateFrameSeenThisEpoch"
  >,
): FocusDegradedReason | null {
  if (health.connectionStatus === "closed") return "host-lost";
  if (health.connectionStatus !== "open") return "host-reconnecting";
  if (!health.stateFrameSeenThisEpoch) return null;
  if (health.cloudSyncStatus === "reconnecting") return "cloud-reconnecting";
  if (health.cloudSyncStatus === "disconnected") return "cloud-disconnected";
  return null;
}

/**
 * `upgrade-required` is a mode the notification hook cannot currently return,
 * but the type still names it. It maps to `"local"` rather than widening the
 * contract: a host that cannot serve the cloud feed is answering from whatever
 * it has locally, which is exactly what "local" tells the reader.
 */
function focusNotificationCoverage(
  feedMode: NotificationFeedMode,
): FocusModel["coverage"]["notifications"] {
  return feedMode === "cloud" ? "cloud" : "local";
}
