import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  RpcSchedulingMode,
  RpcSchedulingPolicy,
} from "@traycer-clients/shared/host-client/rpc-scheduling-policy";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type {
  ProviderManagedInstallState,
  ProviderManagedVersions,
} from "@traycer/protocol/host/provider-schemas";
import { chatPublicationDefinitiveReason } from "@/lib/chats/chat-publication-definitive";
import { PROVIDER_PACK_DISCOVERY_CHECK_TIMEOUT_MS } from "@/lib/host-rpc-policy/provider-pack-discovery-check-timeout";
import { RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS } from "@/lib/rate-limits/rate-limit-timing";

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;

export type ConditionPollLane = {
  readonly id: string;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
};

export type ErasedConditionPollPolicy<
  Method extends keyof HostRpcRegistry & string,
> = {
  readonly kind: "condition";
  readonly method: Method;
  classify(data: unknown): ConditionPollLane | false;
  readonly initialErrorLane: ConditionPollLane;
  readonly staleDataErrorLane: ConditionPollLane;
  readonly resetLaneIds: ReadonlySet<string>;
};

type HostMethodPollPolicy<Method extends keyof HostRpcRegistry & string> =
  | null
  | { readonly kind: "fixed"; readonly intervalMs: number }
  | ErasedConditionPollPolicy<Method>;

type HostMethodScheduling<Method extends keyof HostRpcRegistry & string> = {
  readonly mode:
    | RpcSchedulingMode
    | ((params: RequestOfMethod<HostRpcRegistry, Method>) => RpcSchedulingMode);
  readonly joinResponseTimeoutMs: number | null;
  readonly poll: HostMethodPollPolicy<Method>;
};

type HostMethodPolicyTable = {
  readonly [
    Method in keyof HostRpcRegistry & string
  ]: HostMethodScheduling<Method>;
};

type ConditionPolicyDefinition<Method extends keyof HostRpcRegistry & string> =
  {
    readonly classify: (
      data: ResponseOfMethod<HostRpcRegistry, Method> | undefined,
    ) => ConditionPollLane | false;
    readonly initialErrorLane: ConditionPollLane;
    readonly staleDataErrorLane: ConditionPollLane;
    readonly resetLaneIds: ReadonlySet<string>;
  };

export function defineConditionPolicy<
  Method extends keyof HostRpcRegistry & string,
>(
  method: Method,
  entry: ConditionPolicyDefinition<Method>,
): ErasedConditionPollPolicy<Method> {
  return {
    kind: "condition",
    method,
    classify: entry.classify,
    initialErrorLane: entry.initialErrorLane,
    staleDataErrorLane: entry.staleDataErrorLane,
    resetLaneIds: entry.resetLaneIds,
  };
}

export const PROVIDERS_PENDING_POLL_LANE: ConditionPollLane = {
  id: "providers.pending",
  initialDelayMs: 800,
  maxDelayMs: 30 * SECOND_MS,
};
/**
 * A managed provider pack is actively downloading.
 * Mirrors the speech model's download lane below (1.5s → 5s), for the same reason: `providers.list` is the ONLY source of install progress, so its cadence IS the progress bar's frame rate.
 */
export const PROVIDERS_INSTALLING_POLL_LANE: ConditionPollLane = {
  id: "providers.installing",
  initialDelayMs: 1_500,
  maxDelayMs: 5 * SECOND_MS,
};
/** A managed pack failed and the host has scheduled another attempt. */
export const PROVIDERS_RETRY_SCHEDULED_POLL_LANE: ConditionPollLane = {
  id: "providers.retry-scheduled",
  initialDelayMs: 5 * SECOND_MS,
  maxDelayMs: 30 * SECOND_MS,
};

/** How long after `retryAtMs` the lane keeps watching. */
export const PROVIDERS_RETRY_OBSERVATION_GRACE_MS = 60 * SECOND_MS;

function isRetryWorthWatching(
  state: ProviderManagedInstallState | null | undefined,
  nowMs: number,
): boolean {
  if (state === null || state === undefined) return false;
  if (state.status !== "error") return false;
  // `retryAtMs: null` is the terminal case - `unrepairable`, or a failure the manager deliberately declined to memo.
  // Nothing is coming, so watching is not cheaper than the steady lane, it is only more expensive.
  if (state.retryAtMs === null) return false;
  return nowMs < state.retryAtMs + PROVIDERS_RETRY_OBSERVATION_GRACE_MS;
}

/**
 * True when any managed-pack transfer is in flight for this provider row - automatic lane (`managedInstallState`) or user-lane version-manager rows (`managedVersions.available[].installState`).
 */
function providerHasManagedInstallInFlight(provider: {
  readonly managedInstallState?: ProviderManagedInstallState | null;
  // The protocol type, not a structural stand-in.
  // The row shape used to be spelled out with `status: string`, which widened the wire union to any string: rename `downloading` upstream and the comparison below silently returns false, dropping every user-lane download onto the 15-minute steady lane with no.
  readonly managedVersions?: Pick<ProviderManagedVersions, "available"> | null;
}): boolean {
  if (provider.managedInstallState?.status === "downloading") return true;
  const managedVersions = provider.managedVersions;
  if (managedVersions === null || managedVersions === undefined) return false;
  return managedVersions.available.some(
    (row) => row.installState.status === "downloading",
  );
}
export const PROVIDERS_LIMITED_POLL_LANE: ConditionPollLane = {
  id: "providers.limited",
  initialDelayMs: 30 * SECOND_MS,
  maxDelayMs: 30 * SECOND_MS,
};
export const PROVIDERS_STEADY_POLL_LANE: ConditionPollLane = {
  id: "providers.steady",
  initialDelayMs: 15 * MINUTE_MS,
  maxDelayMs: 15 * MINUTE_MS,
};

export const HARNESS_PENDING_POLL_LANE: ConditionPollLane = {
  id: "harnesses.pending",
  initialDelayMs: 800,
  maxDelayMs: 5 * SECOND_MS,
};
export const HARNESS_INITIAL_ERROR_POLL_LANE: ConditionPollLane = {
  ...HARNESS_PENDING_POLL_LANE,
  id: "harnesses.initial-error",
};
export const HARNESS_STALE_ERROR_POLL_LANE: ConditionPollLane = {
  ...HARNESS_PENDING_POLL_LANE,
  id: "harnesses.stale-error",
};
export const HARNESS_UNAVAILABLE_POLL_LANE: ConditionPollLane = {
  id: "harnesses.unavailable",
  initialDelayMs: 30 * SECOND_MS,
  maxDelayMs: 5 * MINUTE_MS,
};
export const HARNESS_ALL_AVAILABLE_POLL_LANE: ConditionPollLane = {
  id: "harnesses.all-available",
  initialDelayMs: 15 * MINUTE_MS,
  maxDelayMs: 15 * MINUTE_MS,
};

export const ONBOARDING_DRAFT_PROVIDERS_UNSETTLED_POLL_LANE: ConditionPollLane =
  {
    id: "onboarding-draft.providers-unsettled",
    initialDelayMs: 750,
    maxDelayMs: 3 * SECOND_MS,
  };
export const ONBOARDING_DRAFT_INITIAL_ERROR_POLL_LANE: ConditionPollLane = {
  ...ONBOARDING_DRAFT_PROVIDERS_UNSETTLED_POLL_LANE,
  id: "onboarding-draft.initial-error",
};
export const ONBOARDING_DRAFT_STALE_ERROR_POLL_LANE: ConditionPollLane = {
  ...ONBOARDING_DRAFT_PROVIDERS_UNSETTLED_POLL_LANE,
  id: "onboarding-draft.stale-error",
};
export const SPEECH_MODEL_DOWNLOADING_POLL_LANE: ConditionPollLane = {
  id: "speech-model.downloading",
  initialDelayMs: 1_500,
  maxDelayMs: 5 * SECOND_MS,
};
export const SPEECH_MODEL_INITIAL_ERROR_POLL_LANE: ConditionPollLane = {
  ...SPEECH_MODEL_DOWNLOADING_POLL_LANE,
  id: "speech-model.initial-error",
};
export const SPEECH_MODEL_STALE_ERROR_POLL_LANE: ConditionPollLane = {
  ...SPEECH_MODEL_DOWNLOADING_POLL_LANE,
  id: "speech-model.stale-error",
};
export const WORKTREE_SETUP_IN_FLIGHT_POLL_LANE: ConditionPollLane = {
  id: "worktree-binding.setup-in-flight",
  initialDelayMs: 2 * SECOND_MS,
  maxDelayMs: 5 * SECOND_MS,
};
export const WORKTREE_SETUP_INITIAL_ERROR_POLL_LANE: ConditionPollLane = {
  ...WORKTREE_SETUP_IN_FLIGHT_POLL_LANE,
  id: "worktree-binding.initial-error",
};
export const WORKTREE_SETUP_STALE_ERROR_POLL_LANE: ConditionPollLane = {
  ...WORKTREE_SETUP_IN_FLIGHT_POLL_LANE,
  id: "worktree-binding.stale-error",
};
export const GIT_DIRTY_SUBMODULE_POLL_LANE: ConditionPollLane = {
  id: "git.dirty-submodule",
  initialDelayMs: 5 * SECOND_MS,
  maxDelayMs: 10 * SECOND_MS,
};
export const GIT_INITIAL_ERROR_POLL_LANE: ConditionPollLane = {
  ...GIT_DIRTY_SUBMODULE_POLL_LANE,
  id: "git.initial-error",
};
export const GIT_STALE_ERROR_POLL_LANE: ConditionPollLane = {
  ...GIT_DIRTY_SUBMODULE_POLL_LANE,
  id: "git.stale-error",
};
export const NOTIFICATION_INDICATOR_ERROR_POLL_LANE: ConditionPollLane = {
  id: "notification-indicator.error",
  initialDelayMs: 30 * SECOND_MS,
  maxDelayMs: 30 * SECOND_MS,
};
/**
 * `host.update.check` answered `cli-unavailable`.
 * That answer retires the whole update region and the retired region hides Check now, so with no focus/reconnect refetch in production nothing would ever notice the Traycer CLI being reinstalled - the region stayed retired until the user left the host scope.
 */
/**
 * A fork boundary waiting on the publisher: the chat has not been backed up yet, or the chosen turn is not covered by the last receipt.
 */
export const CHAT_PUBLICATION_WAIT_POLL_LANE: ConditionPollLane = {
  id: "epic-chat-publication-state.waiting",
  initialDelayMs: 5 * SECOND_MS,
  maxDelayMs: 30 * SECOND_MS,
};
export const UPDATE_CHECK_CLI_RECOVERY_POLL_LANE: ConditionPollLane = {
  id: "host-update-check.cli-recovery",
  initialDelayMs: 5 * SECOND_MS,
  maxDelayMs: 60 * SECOND_MS,
};
/**
 * The check itself failed - a transport fault, not an answer.
 * Same recovery reasoning as the lane above ("Couldn't ask …" has no retry button either), on a quieter cadence: reachability is the scope's problem first, this query only needs to catch up once the host is back.
 */
export const UPDATE_CHECK_ERROR_POLL_LANE: ConditionPollLane = {
  id: "host-update-check.error",
  initialDelayMs: 30 * SECOND_MS,
  maxDelayMs: 5 * 60 * SECOND_MS,
};

const NO_RESET_LANES: ReadonlySet<string> = new Set();
export const PROVIDERS_INITIAL_ERROR_POLL_LANE: ConditionPollLane = {
  ...PROVIDERS_PENDING_POLL_LANE,
  id: "providers.initial-error",
};
export const PROVIDERS_STALE_ERROR_POLL_LANE: ConditionPollLane = {
  ...PROVIDERS_PENDING_POLL_LANE,
  id: "providers.stale-error",
};
const PROVIDERS_RESET_LANES: ReadonlySet<string> = new Set([
  PROVIDERS_STEADY_POLL_LANE.id,
]);
const HARNESS_RESET_LANES: ReadonlySet<string> = new Set([
  HARNESS_ALL_AVAILABLE_POLL_LANE.id,
]);

const LATEST_SCHEDULING = {
  mode: "latest",
  joinResponseTimeoutMs: null,
} as const;

export const HOST_METHOD_POLL_TABLE = {
  // Settings > Browser's saved-logins list.
  // A bounded read that can coalesce, and no cadence: the list changes only when the person on this screen clears a row or a site writes a cookie, and the group refetches on the former.
  "browser.savedLoginSites": { ...LATEST_SCHEDULING, poll: null },
  // Opt-in polling (`poll: true`), for one caller: the Overview's drain affordance.
  // Its `busySessionCount` / `busyBreakdown` is what "Apply now - ends 2 agents and 1 terminal" (or "ends N sessions" on a @1.1 host) promises and then destroys, so the question is not whether the cached value may be reused but whether it is still TRUE.
  "host.status": {
    ...LATEST_SCHEDULING,
    poll: { kind: "fixed", intervalMs: 10_000 },
  },
  // Restart commits host admission state before its deferred teardown.
  "host.restart": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  // The host's own name: a bounded read that can coalesce.
  // It has no poll - the host watches `host-name.json`, so a rename made anywhere else lands on the next read (or the next explicit invalidation) rather than needing one.
  "host.identity.get": { ...LATEST_SCHEDULING, poll: null },
  // Renaming persists a file the heartbeat then publishes; rapid edits must
  // land in the order the user made them, so this is never coalesced.
  "host.identity.set": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "host.doctor": { ...LATEST_SCHEDULING, poll: null },
  "host.update.check": {
    ...LATEST_SCHEDULING,
    poll: defineConditionPolicy("host.update.check", {
      classify: (data) => {
        if (data === undefined) return false;
        // ONLY the CLI's absence. The other repair this method is re-asked
        // for - a CLI-floor refusal the Overview is showing a remedy for -
        // is NOT a lane here: whether a floored catalog row is the row the
        // Overview offers depends on the installed version and its release
        // line, which the response does not carry, and a classifier over
        // the response alone kept polling on floored rows no remedy named.
        // The Overview owns that recheck (`useHostOverviewUpdates`), keyed
        // on the remedy it renders.
        return data.outcome === "cli-unavailable"
          ? UPDATE_CHECK_CLI_RECOVERY_POLL_LANE
          : false;
      },
      initialErrorLane: UPDATE_CHECK_ERROR_POLL_LANE,
      staleDataErrorLane: UPDATE_CHECK_ERROR_POLL_LANE,
      resetLaneIds: NO_RESET_LANES,
    }),
  },
  "host.update.install": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Polled, at the `host.status` cadence, for one consumer: the Overview
  // derives "installed, restart to finish" and "staged, waiting for work"
  // from the install and staged records beside the live status. Those
  // records change UNDER a mounted page - a detached `traycer host update`
  // commits or parks, the desktop's launch converge swaps bytes - and a read
  // that only goes stale never observes them, so the card that should offer
  // the restart never appeared until the page was remounted. One host RPC
  // over an open connection, only while the Overview is mounted (it is the
  // only surface that opts into `poll: true` on this method).
  "host.getInstallationInfo": {
    ...LATEST_SCHEDULING,
    poll: { kind: "fixed", intervalMs: 10_000 },
  },
  "host.service.status": { ...LATEST_SCHEDULING, poll: null },
  // FIFO, like `host.update.install` and for the same reason: these mutate the host's own lifecycle, so two in flight must never collapse to "the latest".
  // Unpolled - a service registration changes only when someone changes it, and the status read above is what refreshes after a write.
  "host.service.register": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "host.service.deregister": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "host.getRuntimeCapabilities": { ...LATEST_SCHEDULING, poll: null },
  // The provider-pull branch spawns a CLI subprocess on the host whose probe can legitimately outlast the transport's 30s default frame timeout (a Claude refresh-safe probe alone is budgeted 90s).
  "host.getRateLimitUsage": {
    ...LATEST_SCHEDULING,
    joinResponseTimeoutMs: RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS,
    poll: { kind: "fixed", intervalMs: 15 * MINUTE_MS },
  },
  // Consuming a reset credit changes the provider's persisted quota state.
  "providers.consumeRateLimitResetCredit": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // An explicit human maintenance action may probe one disabled profile.
  // It can spawn the same long-running CLI usage probe as the ordinary read, but is never polled or coalesced with another profile's action.
  "providers.refreshProfileStatus": {
    mode: "fifo",
    joinResponseTimeoutMs: RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS,
    poll: null,
  },
  "host.notifications.list": { ...LATEST_SCHEDULING, poll: null },
  "host.notificationHooks.status": { ...LATEST_SCHEDULING, poll: null },
  // Testing a hook sends a real notification.
  "host.notificationHooks.test": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Saving a hook changes its persisted delivery configuration.
  "host.notificationHooks.save": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "host.notifications.getConfig": { ...LATEST_SCHEDULING, poll: null },
  // Setting notification configuration persists user intent.
  "host.notifications.setConfig": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Marking one notification read persists its acknowledgement.
  "host.notifications.markRead": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Retained for compatible occurrence-scoped workflow resolution callers.
  "host.notifications.resolve": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Marking all notifications read persists acknowledgements.
  "host.notifications.markAllRead": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Clearing notifications destructively changes the notification store.
  "host.notifications.clearAll": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Cloud-feed dispositions persist in the replicated feed and must retain
  // their invocation order at the host boundary.
  "host.notifications.cloudFeed.markRead": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "host.notifications.cloudFeed.markAllRead": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "host.notifications.cloudFeed.resolve": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "host.notifications.cloudFeed.clear": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "host.notifications.cloudFeed.clearAll": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "host.notifications.indicatorState": {
    ...LATEST_SCHEDULING,
    poll: defineConditionPolicy("host.notifications.indicatorState", {
      classify: () => false,
      initialErrorLane: NOTIFICATION_INDICATOR_ERROR_POLL_LANE,
      staleDataErrorLane: NOTIFICATION_INDICATOR_ERROR_POLL_LANE,
      resetLaneIds: NO_RESET_LANES,
    }),
  },
  "comments.listThreads": { ...LATEST_SCHEDULING, poll: null },
  // Updating a thread's status persists collaboration state.
  "comments.setThreadStatus": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // The on-demand body behind a windowed chat's accumulated-change summary.
  // Latest-wins is safe because a newer click for the same summary supersedes an older one, and it is deliberately never polled: the live `chat.subscribe` snapshot pushes summary freshness while the UI fetches bodies only for the file the person opens.
  "chat.readAccumulatedFileChange": { ...LATEST_SCHEDULING, poll: null },
  // Where a cross-tile jump target sits, asked once when the target row is cold.
  // Latest-wins for the same reason as the read above - a newer jump supersedes an older one - and never polled: the answer is a position in a transcript the live subscription is already reporting changes to.
  "chat.locateRow": { ...LATEST_SCHEDULING, poll: null },
  "snapshots.getLocalStorageSize": { ...LATEST_SCHEDULING, poll: null },
  "snapshots.readSnapshotDiff": { ...LATEST_SCHEDULING, poll: null },
  // Clearing snapshots destructively removes locally retained data.
  "snapshots.clearLocalSnapshots": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Killing a process tree from the resource monitor is a destructive command.
  "resources.kill": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  "resources.listLocalServers": {
    ...LATEST_SCHEDULING,
    poll: { kind: "fixed", intervalMs: 3 * SECOND_MS },
  },
  // Shell lifecycle from the Shells list and the output window header.
  // `fifo` is what buys these three the guarantees the coordinator reserves for commands: `selectJob` refuses to coalesce a fifo job, `snapshotHostTransition` refuses to abort one, and `cancelActiveRead` refuses to cancel one.
  "managedCommand.start": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "managedCommand.stop": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "managedCommand.delete": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // A toggle: two quick presses are on-then-off, and the second must not coalesce into the first or the human ends up with the opposite of what the switch shows.
  // `fifo` keeps two IDENTICAL presses distinct; it cannot order an on against an off, because the value is part of the params and so of the queue key - those are two queues.
  "managedCommand.configure": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Deliver takes `fifo` for a reason the other three do not have, and NOT the one about distinct params.
  // The coordinator keys queues by [hostId, userId, method, params], so two Delivers naming different subsets are already distinct jobs - but the common press names no subset at all (`commandIds: null`), and two of THOSE are byte-identical params, one queue.
  "managedCommand.deliverHeld": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "agent.gui.listHarnesses": {
    ...LATEST_SCHEDULING,
    poll: defineConditionPolicy("agent.gui.listHarnesses", {
      classify: (data) => {
        if (data === undefined) return false;
        if (data.harnesses.some((harness) => harness.availabilityPending)) {
          return HARNESS_PENDING_POLL_LANE;
        }
        if (data.harnesses.some((harness) => !harness.available)) {
          return HARNESS_UNAVAILABLE_POLL_LANE;
        }
        return HARNESS_ALL_AVAILABLE_POLL_LANE;
      },
      initialErrorLane: HARNESS_INITIAL_ERROR_POLL_LANE,
      staleDataErrorLane: HARNESS_STALE_ERROR_POLL_LANE,
      resetLaneIds: HARNESS_RESET_LANES,
    }),
  },
  "agent.gui.listModels": { ...LATEST_SCHEDULING, poll: null },
  "agent.gui.listCommands": { ...LATEST_SCHEDULING, poll: null },
  "agent.gui.getPlan": { ...LATEST_SCHEDULING, poll: null },
  "agent.tui.listHarnesses": { ...LATEST_SCHEDULING, poll: null },
  // Preparing a launch creates or updates host-side harness launch state.
  "agent.tui.prepareLaunch": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Read-only cross-profile fork-admission preflight; no host-side state changes, but each call answers a specific candidate profile so requests are not superseded by one another.
  "agent.tui.validateForkProfile": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Generating a title writes the result to the terminal-agent record.
  "agent.tui.generateTitle": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // A turn-ended hook updates broker activity and notifications.
  "agent.tui.turnEnded": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Activity hooks update the host's terminal-agent activity oracle.
  "agent.tui.recordActivity": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Optional replacement for the recordActivity start edge: records the activity edge and pulls the role-registry digest cursor forward when behind (roles-snapshot-delivery).
  // Same scheduling as its sibling hooks.
  "agent.tui.promptSubmitted": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Creating an agent persists a new collaboration record.
  "agent.create": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  "agent.selectionGuide": { ...LATEST_SCHEDULING, poll: null },
  "agent.selectionGuide.getGlobal": { ...LATEST_SCHEDULING, poll: null },
  "agent.selectionGuide.getGlobalOnboardingDraft": {
    ...LATEST_SCHEDULING,
    poll: defineConditionPolicy(
      "agent.selectionGuide.getGlobalOnboardingDraft",
      {
        classify: (data) =>
          data?.content === null && !data.providersSettled
            ? ONBOARDING_DRAFT_PROVIDERS_UNSETTLED_POLL_LANE
            : false,
        initialErrorLane: ONBOARDING_DRAFT_INITIAL_ERROR_POLL_LANE,
        staleDataErrorLane: ONBOARDING_DRAFT_STALE_ERROR_POLL_LANE,
        resetLaneIds: NO_RESET_LANES,
      },
    ),
  },
  // Saving the global guide changes shared onboarding configuration.
  "agent.selectionGuide.setGlobal": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Resetting the global guide overwrites persisted configuration.
  "agent.selectionGuide.resetGlobalToDefault": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "agent.listHarnessModels": { ...LATEST_SCHEDULING, poll: null },
  "agent.list": { ...LATEST_SCHEDULING, poll: null },
  // Sending a message enqueues it in the recipient's inbox.
  "agent.sendMessage": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "agent.getTranscript": { ...LATEST_SCHEDULING, poll: null },
  "agent.inbox.read": { ...LATEST_SCHEDULING, poll: null },
  "agent.inbox.ack": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Claiming a role persists responsibility and broadcasts awareness.
  "agent.roles.claim": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "agent.roles.list": { ...LATEST_SCHEDULING, poll: null },
  // Relinquishing a role removes persisted responsibility and broadcasts awareness.
  "agent.roles.relinquish": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Stopping an agent terminates its active execution.
  "agent.stop": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  // Forking an agent persists a new collaboration record, like agent.create.
  "agent.fork": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  // Migrating a phase changes the epic's persisted workflow state.
  "phase.migrateToEpic": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // A pure read of whether an import run is in flight.
  // `latest` because only the newest answer means anything to the surface that shows it, and no fixed poll: the wizard subscribes to `sessionImport.run` while it is open, so the only reader of this is the Settings entry, which asks on mount.
  "sessionImport.status": { ...LATEST_SCHEDULING, poll: null },
  "epic.listTasks": { ...LATEST_SCHEDULING, poll: null },
  // Recording a view updates the user's central task ordering preference.
  "epic.recordViewed": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Pinning changes a task's persisted ordering preference.
  "epic.setPinned": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  "epic.getTaskContexts": { ...LATEST_SCHEDULING, poll: null },
  // Creating an epic persists a new collaboration root.
  "epic.create": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  // Batch deletion permanently removes the selected epics.
  "epic.batchDelete": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  // Preparing folders persists their repo-to-workspace mappings.
  "workspace.prepareFolders": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "workspace.listFileTree": { ...LATEST_SCHEDULING, poll: null },
  "workspace.listDirectory": { ...LATEST_SCHEDULING, poll: null },
  "workspace.browseFolders": { ...LATEST_SCHEDULING, poll: null },
  "workspace.readFile": { ...LATEST_SCHEDULING, poll: null },
  // Saving a file writes to disk and each attempt carries the revision
  // acknowledged by the previous save, so writes must not be coalesced.
  "workspace.writeFile": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "workspace.mentionFiles": { ...LATEST_SCHEDULING, poll: null },
  "workspace.mentionFolders": { ...LATEST_SCHEDULING, poll: null },
  "workspace.mentionWorktrees": { ...LATEST_SCHEDULING, poll: null },
  "workspace.mentionGitRoot": { ...LATEST_SCHEDULING, poll: null },
  "workspace.mentionGitBranches": { ...LATEST_SCHEDULING, poll: null },
  "workspace.mentionGitCommits": { ...LATEST_SCHEDULING, poll: null },
  "workspace.searchPaths": { ...LATEST_SCHEDULING, poll: null },
  "workspace.searchText": { ...LATEST_SCHEDULING, poll: null },
  "workspace.resolvePathsByRepoIdentifiers": {
    ...LATEST_SCHEDULING,
    poll: null,
  },
  // Removing a repository changes the epic's workspace binding.
  "epic.removeRepo": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  "epic.mentionEpics": { ...LATEST_SCHEDULING, poll: null },
  "epic.mentionSpecs": { ...LATEST_SCHEDULING, poll: null },
  "epic.mentionTickets": { ...LATEST_SCHEDULING, poll: null },
  "epic.mentionStories": { ...LATEST_SCHEDULING, poll: null },
  "epic.mentionReviews": { ...LATEST_SCHEDULING, poll: null },
  "epic.listCollaborators": {
    ...LATEST_SCHEDULING,
    poll: { kind: "fixed", intervalMs: 5 * MINUTE_MS },
  },
  // Creating an artifact persists a new document node.
  "epic.createArtifact": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Deleting an artifact permanently removes its document node.
  "epic.deleteArtifact": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Updating artifact status persists workflow state.
  "epic.updateArtifactStatus": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Renaming an artifact persists its title.
  "epic.renameArtifact": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Reparenting an artifact changes document hierarchy.
  "epic.reparentArtifact": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Creating a chat persists a new collaboration record.
  "epic.createChat": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  // Renaming a chat persists its title.
  "epic.renameChat": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  // Updating chat run settings changes persisted execution configuration.
  "epic.updateChatRunSettings": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Updating a chat's profile persists its selected agent/model (optional host capability).
  "epic.updateChatProfile": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Deleting a chat permanently removes its collaboration record.
  "epic.deleteChat": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  // Reparenting a chat changes document hierarchy.
  "epic.reparentChat": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Optional host capability, read-only: does the source chat's publication cover a chosen fork boundary?
  // Asked when the fork dialog OPENS, and only when the account has a host other than the source, so a single-host user never pays for it.
  "epic.chatPublicationState": {
    // A pure read with no ordering requirement, like every other read here.
    ...LATEST_SCHEDULING,
    // Polled only while the answer is one the FORK DIALOG'S COPY promises will resolve on its own - "It backs up automatically - try again shortly" and the boundary-syncing sentence.
    // `staleTime` alone only marks the cache stale and issues nothing for a mounted, idle observer, so an open dialog sitting on either answer would wait forever on a sentence that told the user waiting was enough.
    poll: defineConditionPolicy("epic.chatPublicationState", {
      classify: (data) => {
        if (data === undefined) return false;
        // Terminal, and it outranks both readings below: `definitive` names a reason waiting cannot clear, so re-asking cannot clear it either.
        // Any reason counts, including one this build does not recognise; the shared reader is also what keeps a host that predates the field (`undefined`, not `null`) in the wait lane where it belongs.
        if (chatPublicationDefinitiveReason(data.definitive) !== null) {
          return false;
        }
        if (!data.published) return CHAT_PUBLICATION_WAIT_POLL_LANE;
        return data.boundaryCovered === false
          ? CHAT_PUBLICATION_WAIT_POLL_LANE
          : false;
      },
      initialErrorLane: CHAT_PUBLICATION_WAIT_POLL_LANE,
      staleDataErrorLane: CHAT_PUBLICATION_WAIT_POLL_LANE,
      resetLaneIds: NO_RESET_LANES,
    }),
  },
  // Archiving a chat or terminal-agent record persists its archived flag
  // (optional host capability).
  "epic.setChatArchived": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Visibility mutations.
  // Optional host capability.
  "epic.setCloudChatVisibility": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "epic.setChatSharingDefault": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "epic.prepareArtifactImage": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "epic.finishArtifactImage": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Creating a TUI agent persists its terminal-agent record.
  "epic.createTuiAgent": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Deleting a TUI agent permanently removes its record.
  "epic.deleteTuiAgent": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Renaming a TUI agent persists its title.
  "epic.renameTuiAgent": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Updating the epic title persists user intent.
  "epic.updateTitle": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  // Re-running an interrupted major migration.
  // `fifo`, not `latest`, because it is an ACTION with host-side effects and not a read: `latest` would let a second press supersede an in-flight retry, dropping a user-initiated recovery attempt.
  "epic.retryMigration": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Granting access changes the epic's collaborator set.
  "epic.grantAccess": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  // Updating roles changes collaborator permissions.
  "epic.batchUpdateRoles": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Revoking access changes the epic's collaborator set.
  "epic.revokeCollaborator": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Creating a comment persists a new collaboration annotation.
  "epic.createCommentThread": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Replying to a comment persists a new collaboration annotation.
  "epic.replyToCommentThread": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Editing a comment persists its new content.
  "epic.editComment": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  // Deleting a comment permanently removes collaboration content.
  "epic.deleteComment": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Resolving a thread persists its workflow state.
  "epic.setCommentThreadResolved": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Deleting a thread permanently removes collaboration content.
  "epic.deleteCommentThread": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // A FIXED cadence the caller gates, not an always-on one.
  // Comment threads normally arrive pushed on the records lane, and while that lane is up this poll must stay quiet - the lane is fresher by construction and a cadence beside it would be pure waste.
  "epic.listCommentThreads": {
    ...LATEST_SCHEDULING,
    poll: { kind: "fixed", intervalMs: 15 * SECOND_MS },
  },
  "epic.resolveArtifactByPath": { ...LATEST_SCHEDULING, poll: null },
  "epic.searchArtifacts": { ...LATEST_SCHEDULING, poll: null },
  // The workspace context the decomposed lanes fetch at tab open.
  // A read, so `latest`; `poll: null` because it is refetched on EVENTS - a reconnect, or a control-lane migration/permission signal - never on a cadence.
  "epic.getWorkspaceContext": { ...LATEST_SCHEDULING, poll: null },
  // The cloud-chat READ surface.
  // All five are reads, so `latest` - and the two properties that follow from the coordinator keying on PARAMS are exactly what this fan-out wants: a read of part A never supersedes a concurrent read of part B (different params, different queue), while two.
  "epic.listCloudChats": { ...LATEST_SCHEDULING, poll: null },
  "epic.resolveCloudChatHead": { ...LATEST_SCHEDULING, poll: null },
  "epic.readCloudChatPart": { ...LATEST_SCHEDULING, poll: null },
  "epic.listCloudChatPayloads": { ...LATEST_SCHEDULING, poll: null },
  "epic.readCloudChatPayload": { ...LATEST_SCHEDULING, poll: null },
  // One chat image attachment's bytes.
  // Not polled, and it must not be: the answer is content-addressed, so a hash that resolved once resolves to the same bytes forever and a hash that missed is re-driven by the image blob cache's own retry ladder (`use-image-blob-url.ts`), not by a cadence.
  "epic.readChatAttachment": { ...LATEST_SCHEDULING, poll: null },
  // Like the chat attachment read, artifact attachment bytes are addressed by their content hash and the image cache owns retry after a transient miss.
  // Polling this unary method would only re-fetch immutable bytes.
  "epic.fetchArtifactAttachment": { ...LATEST_SCHEDULING, poll: null },
  // Not polled, and this is a deliberate freshness choice rather than a copy of the row above it.
  // The answer is "which cloud row does this local chat publish into", which changes exactly once in a chat's life - when a fork sends its lineage into a clone row - and never again.
  "epic.listChatPublicationTargets": { ...LATEST_SCHEDULING, poll: null },
  // One-shot read: the doc content of an unreachable owner's chat cannot
  // change while its owner is away.
  "epic.chatReplicaRead": { ...LATEST_SCHEDULING, poll: null },
  // The store-backed chat RECORD channel (chat-sync-v2 ticket 49).
  "epic.listChatRecords": {
    ...LATEST_SCHEDULING,
    poll: { kind: "fixed", intervalMs: 20 * SECOND_MS },
  },
  // UNPOLLED, unlike the list above, and for the opposite reason: the list has to notice a chat that appeared elsewhere, while this answers a question whose subject cannot change without a user action.
  "epic.getChatRunSettings": {
    ...LATEST_SCHEDULING,
    poll: null,
  },
  // The terminal-agent RECORD read (TUI eviction), the sibling of `epic.listChatRecords` above and polled at its exact cadence for its exact reasons: the facts it serves are committed to the host's registry and written nowhere the renderer already listens.
  "epic.listTuiAgents": {
    ...LATEST_SCHEDULING,
    poll: { kind: "fixed", intervalMs: 20 * SECOND_MS },
  },
  // The publisher's own convergence sweep is 30s, so a 45s local read is
  // responsive without asking faster than the underlying state can change.
  "epic.chatBackupStatus": {
    ...LATEST_SCHEDULING,
    poll: { kind: "fixed", intervalMs: 45_000 },
  },
  // Polled: no host-pushed invalidation channel exists for this event today (see the implementation report), so without a cadence a fork detected after this query first cached would never surface. 45s sits between the publisher's own ~30s detection sweep and.
  "host.chatFork.get": {
    ...LATEST_SCHEDULING,
    poll: { kind: "fixed", intervalMs: 45_000 },
  },
  // Opening paths changes state in the user's editor.
  "editor.openPaths": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  "git.listChangedFiles": {
    ...LATEST_SCHEDULING,
    poll: defineConditionPolicy("git.listChangedFiles", {
      classify: (data) => {
        if (data === undefined) return false;
        const hasDirtySubmodule = data.submodules.some((submodule) => {
          if (submodule.availability.state === "unavailable") return true;
          if (submodule.files.length > 0) return true;
          if (submodule.pointer.kind === "conflicted") return true;
          return (
            submodule.pointer.commitChanged ||
            submodule.pointer.modifiedContent ||
            submodule.pointer.untrackedContent
          );
        });
        return hasDirtySubmodule ? GIT_DIRTY_SUBMODULE_POLL_LANE : false;
      },
      initialErrorLane: GIT_INITIAL_ERROR_POLL_LANE,
      staleDataErrorLane: GIT_STALE_ERROR_POLL_LANE,
      resetLaneIds: NO_RESET_LANES,
    }),
  },
  "git.getFileDiff": { ...LATEST_SCHEDULING, poll: null },
  "git.getFileDiffs": { ...LATEST_SCHEDULING, poll: null },
  "git.getFileContents": { ...LATEST_SCHEDULING, poll: null },
  "git.getCapabilities": { ...LATEST_SCHEDULING, poll: null },
  // A read of the local checkout, requested when the PR Files tab opens.
  // No poll: the PR detail stream is what notices a new push, and a re-render off a changed `headRefOid` re-keys the query on its own.
  "pr.getLocalDiff": { ...LATEST_SCHEDULING, poll: null },
  // The split form of the same read: one metadata frame when the tile opens, then one small patch per visible row.
  // Same no-poll reasoning - the detail stream notices pushes, and the per-file queries are keyed by immutable OIDs, so there is nothing a cadence could learn.
  "pr.getLocalDiffSummary": { ...LATEST_SCHEDULING, poll: null },
  "pr.getLocalFileDiff": { ...LATEST_SCHEDULING, poll: null },
  // The composer's PR/issue mention sections.
  // Both are latest-wins with no poll: the menu is open for seconds at a time and drives every fetch explicitly (open, refresh click, filter change), so there is no cadence to keep - and a superseded read has nothing worth waiting for.
  "mention.githubCatalog": { ...LATEST_SCHEDULING, poll: null },
  // Latest-wins is load-bearing here rather than incidental: the section searches as the user types, and a queued query that has already been retyped past must not be the one that lands.
  "mention.githubSearch": { ...LATEST_SCHEDULING, poll: null },
  // Creating a terminal allocates a host PTY session.
  "terminal.create": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  // Killing a terminal terminates a host PTY session.
  "terminal.kill": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  "terminal.list": { ...LATEST_SCHEDULING, poll: null },
  // A read that materializes the terminal's output to a file on the host.
  // Latest-wins with no poll: it is issued on demand, and a superseded read has nothing worth waiting for - the next one rewrites the same file.
  "terminal.readOutput": { ...LATEST_SCHEDULING, poll: null },
  // Renaming a terminal persists its display name.
  "terminal.rename": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  // Durable plain-terminal authority.
  // The list is snapshot seeding only; the stream owns subsequent convergence.
  "terminal.plain.create": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "terminal.plain.list": { ...LATEST_SCHEDULING, poll: null },
  "terminal.plain.rename": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "terminal.plain.ensureRunning": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "terminal.plain.close": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "terminal.plain.importLegacy": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "worktree.listByWorkspacePaths": { ...LATEST_SCHEDULING, poll: null },
  "worktree.listBranches": { ...LATEST_SCHEDULING, poll: null },
  // Creating a worktree starts a host-side setup operation.
  "worktree.create": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  // Creating worktree paths starts host-side setup operations.
  "worktree.createPaths": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Importing a worktree persists a new binding.
  "worktree.import": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  // Changing an entry mode mutates its worktree binding.
  "worktree.setEntryMode": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Removing an entry mutates the workspace binding.
  "workspaceBinding.removeEntry": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Retrying setup starts a new host-side setup operation.
  "worktree.retrySetup": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Deleting a worktree removes a host-side binding and directory.
  "worktree.delete": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  "worktree.listAllForHost": { ...LATEST_SCHEDULING, poll: null },
  // Setting repo scripts persists worktree execution configuration.
  "worktree.setRepoScripts": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Setting the repo branch-prefix override persists worktree naming config.
  "worktree.setRepoBranchPrefix": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "worktree.getBinding": {
    ...LATEST_SCHEDULING,
    poll: defineConditionPolicy("worktree.getBinding", {
      classify: (data) =>
        data?.binding?.entries.some(
          (entry) =>
            entry.mode === "worktree" &&
            (entry.setupState === "pending" || entry.setupState === "running"),
        )
          ? WORKTREE_SETUP_IN_FLIGHT_POLL_LANE
          : false,
      initialErrorLane: WORKTREE_SETUP_INITIAL_ERROR_POLL_LANE,
      staleDataErrorLane: WORKTREE_SETUP_STALE_ERROR_POLL_LANE,
      resetLaneIds: NO_RESET_LANES,
    }),
  },
  // Forced auth refresh mutates provider auth state; ordinary listing is read-only.
  "providers.list": {
    mode: (params) => (params.forceAuthRefresh === true ? "fifo" : "latest"),
    joinResponseTimeoutMs: null,
    poll: defineConditionPolicy("providers.list", {
      classify: (data) => {
        if (data === undefined) return false;
        // `providers.list` is also the carrier for the native (MCP/plugins/ skills) queries, which cache a MAPPED shape under their own `cacheKeyIdentity` rather than the raw response.
        // Those entries have no `providers` array; they opt out of table-owned polling (`poll: false`) and must never drive the classic lanes.
        if (!Array.isArray(data.providers)) return false;
        // Ahead of the probe lane deliberately.
        // Both can be true at once on a first boot, and `providers.pending` decays to 30s while an install needs a bounded 5s - taking the faster, tighter-capped lane while bytes are moving is the only ordering that keeps progress readable.
        const hasInstallInFlight = data.providers.some((provider) =>
          providerHasManagedInstallInFlight(provider),
        );
        if (hasInstallInFlight) return PROVIDERS_INSTALLING_POLL_LANE;
        const hasPendingProbe = data.providers.some(
          (provider) =>
            provider.enabled &&
            (provider.authPending ||
              provider.availabilityPending ||
              provider.candidates.some(
                (candidate) => candidate.versionPending,
              )),
        );
        if (hasPendingProbe) return PROVIDERS_PENDING_POLL_LANE;
        // After the probe lane, which is faster off the mark and caps at the
        // same 30s, and before the rate-limit lane, which starts there.
        const nowMs = Date.now();
        const hasScheduledRetry = data.providers.some((provider) =>
          isRetryWorthWatching(provider.managedInstallState, nowMs),
        );
        if (hasScheduledRetry) return PROVIDERS_RETRY_SCHEDULED_POLL_LANE;
        const hasLimitedProfile = data.providers.some((provider) =>
          provider.profiles.some(
            (profile) =>
              profile.rateLimitStatus === "near_limit" ||
              profile.rateLimitStatus === "hard_limit",
          ),
        );
        if (hasLimitedProfile) return PROVIDERS_LIMITED_POLL_LANE;
        return PROVIDERS_STEADY_POLL_LANE;
      },
      initialErrorLane: PROVIDERS_INITIAL_ERROR_POLL_LANE,
      staleDataErrorLane: PROVIDERS_STALE_ERROR_POLL_LANE,
      resetLaneIds: PROVIDERS_RESET_LANES,
    }),
  },
  // Selecting a provider changes persisted provider preference.
  "providers.setSelection": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Adding a custom path changes persisted provider discovery configuration.
  "providers.addCustomPath": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Removing a custom path changes persisted provider discovery configuration.
  "providers.removeCustomPath": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "providers.detectVersion": { ...LATEST_SCHEDULING, poll: null },
  // Starting login spawns a provider-authentication process.
  "providers.startLogin": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Compatible waiters share one provider-login result for its fixed long-poll budget.
  "providers.awaitLogin": {
    mode: "join",
    joinResponseTimeoutMs: 16 * MINUTE_MS,
    poll: null,
  },
  // Cancelling login terminates the provider-authentication process.
  "providers.cancelLogin": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Submitting a code advances the provider-authentication process.
  "providers.submitLoginCode": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Touching login extends the active provider-authentication deadline.
  "providers.touchLogin": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Opening a sign-in terminal kills the previous one and spawns a PTY, so ordering is load-bearing: a "latest wins" policy could drop the call that actually left a terminal behind.
  // Concurrent clicks are collapsed host-side, which is where that decision belongs.
  "providers.startTerminalLogin": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Setting an API key changes persisted credentials.
  "providers.setApiKey": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Clearing an API key removes persisted credentials.
  "providers.clearApiKey": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Updating terminal args changes persisted provider configuration.
  "providers.setTerminalAgentArgs": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Setting an environment override changes persisted provider configuration.
  "providers.setEnvOverride": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Deleting an environment override changes persisted provider configuration.
  "providers.deleteEnvOverride": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Enabling a provider changes persisted provider configuration.
  "providers.setEnabled": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Profile eligibility is persisted provider configuration.
  "providers.setProfileEnabled": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Native MCP/plugins/skills mutations write provider config files, so they are `fifo` for the same reason as the classic provider mutations above: two rapid toggles must both land, in order, not be coalesced into one.
  "providers.nativeMutate": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // MCP auth actions (login/submitCode/logout/clearAuth/forceReauth) mutate
  // stored credentials and must not be coalesced.
  "providers.mcpAuth": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Bounded status poll for an in-flight MCP auth - a pure read, so `latest`
  // (a superseded poll carries no information the newer one lacks).
  "providers.awaitMcpAuth": {
    ...LATEST_SCHEDULING,
    poll: null,
  },
  // Cancelling an in-flight MCP auth tears down host-side pending state.
  "providers.cancelMcpAuth": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Reading the upstream LLM provider catalog for a provider - a pure read, so `latest`.
  // `poll: null`: the catalog only changes as a result of an auth mutation on this same surface, which invalidates the query directly.
  "providers.listModelProviders": {
    ...LATEST_SCHEDULING,
    poll: null,
  },
  // Upstream credential writes (connect / start OAuth / submit code / disconnect) - `fifo` for the same reason as `providers.mcpAuth`: two rapid actions must both land, in order, not be coalesced into one.
  "providers.modelProviderAuth": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Bounded status poll for an in-flight OAuth attempt - a pure read, so
  // `latest` (a superseded poll carries no information the newer one lacks).
  "providers.awaitModelProviderAuth": {
    ...LATEST_SCHEDULING,
    poll: null,
  },
  // Cancelling an in-flight OAuth attempt tears down host-side pending state.
  "providers.cancelModelProviderAuth": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // A user-initiated "get this provider's managed pack ready" kick.
  // `fifo` because it mutates host-side scheduling state (clears the cell's backoff, promotes it to the front of the install queue) and two rapid retry taps must not be coalesced into one.
  "providers.ensurePack": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // The four per-pack version-manager methods.
  // All `fifo` for the reason `providers.ensurePack` above is: each mutates durable host state (bytes on disk, the shared pin/policy record), so coalescing two rapid taps into one would drop a user action - and unlike a read, replaying the survivor is not.
  "providers.installPackVersion": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "providers.removePackVersion": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "providers.usePackVersion": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "providers.setPackPolicy": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // The on-demand "Check for updates" in the same popover.
  // `fifo` for a different reason than the four above - it writes no durable state - but the same consequence: each press is answered with its own outcome, so two rapid taps must not coalesce into one answer.
  "providers.refreshPackDiscovery": {
    mode: "fifo",
    joinResponseTimeoutMs: PROVIDER_PACK_DISCOVERY_CHECK_TIMEOUT_MS,
    poll: null,
  },
  "worktree.listBindingsForEpic": { ...LATEST_SCHEDULING, poll: null },
  // Pure holder read for teardown disclosures - fetched at gesture time by
  // the delete/rebind confirm flows, never on a cadence.
  "worktree.listHolders": { ...LATEST_SCHEDULING, poll: null },
  "speech.getModelStatus": {
    ...LATEST_SCHEDULING,
    poll: defineConditionPolicy("speech.getModelStatus", {
      classify: (data) =>
        data?.downloadState === "downloading"
          ? SPEECH_MODEL_DOWNLOADING_POLL_LANE
          : false,
      initialErrorLane: SPEECH_MODEL_INITIAL_ERROR_POLL_LANE,
      staleDataErrorLane: SPEECH_MODEL_STALE_ERROR_POLL_LANE,
      resetLaneIds: NO_RESET_LANES,
    }),
  },
  // Ensuring a model starts or advances a host-side model download.
  "speech.ensureModel": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "agent.listProviderProfiles": { ...LATEST_SCHEDULING, poll: null },
  "agent.getProviderProfileRateLimits": { ...LATEST_SCHEDULING, poll: null },
  // Configuring an agent persists its execution settings.
  "agent.configure": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  // Shutdown claim, commit, and release change admission state and must be
  // ordered against one another.
  "lifecycle.claimShutdown": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "lifecycle.commitShutdown": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "lifecycle.releaseShutdown": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // Config reads and bounded diagnostics reads can coalesce safely; config
  // writes are ordered so rapid user changes are all persisted in sequence.
  "config.shell.get": { ...LATEST_SCHEDULING, poll: null },
  "config.shell.set": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  "config.shell.reset": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "config.shell.add": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  "config.shell.remove": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "config.shell.revertArgs": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "config.shell.listDetected": { ...LATEST_SCHEDULING, poll: null },
  "config.shell.probe": { ...LATEST_SCHEDULING, poll: null },
  "config.env.list": { ...LATEST_SCHEDULING, poll: null },
  "config.env.set": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  "config.env.delete": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "config.logLevels.get": { ...LATEST_SCHEDULING, poll: null },
  "config.logLevels.set": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "diagnostics.logs.list": { ...LATEST_SCHEDULING, poll: null },
  "diagnostics.logs.tail": { ...LATEST_SCHEDULING, poll: null },
  // A bounded read over settled facts (Usage page + epic cost badge).
  // The Settings panel controls its own refetch (window/metric change, manual retry) and opts out of polling; the ambient epic cost badge opts in (matching `host.getRateLimitUsage`'s cadence below) so it self-heals within a bounded time from a.
  "host.usage.summary": {
    ...LATEST_SCHEDULING,
    poll: { kind: "fixed", intervalMs: 15 * MINUTE_MS },
  },
} satisfies HostMethodPolicyTable;

const hostMethodPolicyTable: HostMethodPolicyTable = HOST_METHOD_POLL_TABLE;

export const hostRpcSchedulingPolicy: RpcSchedulingPolicy<HostRpcRegistry> = {
  modeFor(method, params) {
    const mode = hostMethodPolicyTable[method].mode;
    return typeof mode === "function" ? mode(params) : mode;
  },
  joinResponseTimeoutMs(method) {
    return hostMethodPolicyTable[method].joinResponseTimeoutMs;
  },
};

type HostRpcMethodMeta<Method extends keyof HostRpcRegistry & string> = {
  readonly hostRpcMethod: Method;
};

export function stampHostRpcMethod<
  Method extends keyof HostRpcRegistry & string,
>(
  meta: Record<string, unknown> | undefined,
  method: Method,
): Record<string, unknown> & HostRpcMethodMeta<Method> {
  return { ...meta, hostRpcMethod: method };
}

export function assertExactHostMethodPollTableKeys(
  table: HostMethodPolicyTable,
): void {
  const registryKeys = Object.keys(hostRpcRegistry).sort();
  const tableKeys = Object.keys(table).sort();
  const hasExactKeys =
    registryKeys.length === tableKeys.length &&
    registryKeys.every((key, index) => key === tableKeys[index]);

  if (!hasExactKeys) {
    throw new Error(
      `Host method poll table must exactly match hostRpcRegistry. Registry: ${registryKeys.join(", ")}. Table: ${tableKeys.join(", ")}.`,
    );
  }
}

assertExactHostMethodPollTableKeys(HOST_METHOD_POLL_TABLE);
