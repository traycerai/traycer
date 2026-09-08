import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { AgentActivityCloudSyncStatus } from "@traycer/protocol/host/agent/activity";
import type { NotificationFeedMode } from "@/lib/notifications/notification-feed-mode";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";
import {
  buildFocusBackground,
  type FocusBackgroundChat,
} from "@/lib/home-focus/focus-background";
import type {
  FocusBackgroundRow,
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
 * What `FocusModel` (`focus-model.ts`) means. The contract file is kept to the
 * interface block alone so the view lane's copy of it merges byte-identical,
 * so the reasoning behind those fields lives here.
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
 *   `true` rather than a boolean so a renderer cannot forget to caption it.
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
  coverage: Object.freeze({
    activity: "unknown",
    notifications: "local",
    backgroundIsMountedOnly: true,
  }),
  badgeCount: 0,
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
  readonly activity: FocusActivityHealth;
  readonly feedMode: NotificationFeedMode;
}

/**
 * The whole model in one pure pass, reusing `previous`'s rows wherever content
 * is unchanged so an unrelated store frame produces no new references at all.
 *
 * Prompts are built first because the task rows read their epic ids: a task
 * whose prompt row is loaded reads `needsYou` even when the host's indicator
 * batch did not cover it.
 */
export function buildFocusModel(
  input: BuildFocusModelInput,
  previous: FocusModel,
): FocusModel {
  const prompts = buildFocusPrompts(
    input.notificationRows,
    input.tasks.taskTitles,
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
    notifications: focusNotificationCoverage(input.feedMode),
    backgroundIsMountedOnly: true,
  } as const;
  const next: FocusModel = {
    prompts,
    tasks,
    background,
    coverage: shallowEqualRow(coverage, previous.coverage)
      ? previous.coverage
      : coverage,
    badgeCount: prompts.length,
  };
  return shallowEqualRow(next, previous) ? previous : next;
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
  if (health.connectionStatus === "closed") return "disconnected";
  if (health.connectionStatus !== "open") return "reconnecting";
  if (!health.stateFrameSeenThisEpoch) return "unknown";
  if (health.cloudSyncStatus === "reconnecting") return "reconnecting";
  if (health.cloudSyncStatus === "disconnected") return "disconnected";
  if (
    health.cloudSyncStatus !== "connected" &&
    (!health.connectableHostsResolved || health.connectableHostCount > 1)
  ) {
    return "unknown";
  }
  return "live";
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
