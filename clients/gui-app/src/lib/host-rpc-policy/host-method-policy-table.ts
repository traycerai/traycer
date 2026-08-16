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

export type HostMethodPollPolicy<
  Method extends keyof HostRpcRegistry & string,
> =
  | null
  | { readonly kind: "fixed"; readonly intervalMs: number }
  | ErasedConditionPollPolicy<Method>;

export type HostMethodScheduling<
  Method extends keyof HostRpcRegistry & string,
> = {
  readonly mode:
    | RpcSchedulingMode
    | ((params: RequestOfMethod<HostRpcRegistry, Method>) => RpcSchedulingMode);
  readonly joinResponseTimeoutMs: number | null;
  readonly poll: HostMethodPollPolicy<Method>;
};

export type HostMethodPolicyTable = {
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
 * A managed provider pack is actively downloading. Mirrors the speech model's
 * download lane below (1.5s → 5s), for the same reason: `providers.list` is
 * the ONLY source of install progress, so its cadence IS the progress bar's
 * frame rate.
 *
 * A tighter cap than `providers.pending` on purpose. A shell probe that has
 * not settled after half a minute is genuinely worth backing off from; a
 * download is not - the wire sits at `downloading` with a full fraction
 * through the entire extract-and-verify phase, so a 30s (let alone 15min)
 * cadence leaves a finished-looking bar frozen on screen for the exact stretch
 * where the user is most likely to conclude the install is hung.
 */
export const PROVIDERS_INSTALLING_POLL_LANE: ConditionPollLane = {
  id: "providers.installing",
  initialDelayMs: 1_500,
  maxDelayMs: 5 * SECOND_MS,
};
/**
 * A managed pack failed and the host has scheduled another attempt.
 *
 * Without this lane an `error` cell falls straight to `providers.steady`, so a
 * wifi blip that the host recovers from in a minute keeps "Setup failed" on
 * screen for up to fifteen. That is the wrong direction for a transient
 * failure: the steady lane's cadence is chosen for state that is not expected
 * to change, and a cell carrying `retryAtMs` is state that is.
 *
 * Deliberately looser than the installing lane. Nothing here has to animate -
 * this lane exists to notice ONE transition (error → downloading, or error
 * with a fresh `retryAtMs`) shortly after it happens, and 30s of staleness on
 * a failure notice is not the same cost as 30s of frozen progress bar.
 */
export const PROVIDERS_RETRY_SCHEDULED_POLL_LANE: ConditionPollLane = {
  id: "providers.retry-scheduled",
  initialDelayMs: 5 * SECOND_MS,
  maxDelayMs: 30 * SECOND_MS,
};

/**
 * How long after `retryAtMs` the lane keeps watching.
 *
 * A window is needed rather than a bare `retryAtMs > now` because nothing on
 * the host fires AT `retryAtMs`. The field is the manager's backoff memo -
 * "this cell becomes eligible again at T" - and the attempt itself rides on
 * the next kick: a turn resolving the provider, an explicit `ensurePack`, or
 * the reconvergence tick. So the transition this lane exists to see lands
 * shortly AFTER `retryAtMs`, never before it, and dropping to the steady lane
 * the instant eligibility arrives would miss precisely the moment it was
 * added for.
 *
 * It is also what bounds the lane. Past the window the cell is not "about to
 * heal", it is waiting for a kick nobody has scheduled - and the kick's own
 * arrival (a turn) already refreshes the list through
 * `useRefreshProvidersListOnTurn`. Polling a quiescent failure every 30
 * seconds forever would buy nothing and cost it on every wedged host.
 */
export const PROVIDERS_RETRY_OBSERVATION_GRACE_MS = 60 * SECOND_MS;

function isRetryWorthWatching(
  state: ProviderManagedInstallState | null | undefined,
  nowMs: number,
): boolean {
  if (state === null || state === undefined) return false;
  if (state.status !== "error") return false;
  // `retryAtMs: null` is the terminal case - `unrepairable`, or a failure the
  // manager deliberately declined to memo. Nothing is coming, so watching is
  // not cheaper than the steady lane, it is only more expensive.
  if (state.retryAtMs === null) return false;
  return nowMs < state.retryAtMs + PROVIDERS_RETRY_OBSERVATION_GRACE_MS;
}

/**
 * True when any managed-pack transfer is in flight for this provider row —
 * automatic lane (`managedInstallState`) or user-lane version-manager rows
 * (`managedVersions.available[].installState`).
 *
 * User-lane downloads are independent of the automatic target: after
 * `providers.installPackVersion` returns non-blocking, only the version row
 * sits at `downloading` while the automatic slot may remain `installed` /
 * `absent`. The installing poll lane must still fire, or progress freezes on
 * the 15-minute steady cadence.
 *
 * There is no `queued` status on either wire install-state union today, so
 * this predicate only inspects `downloading` (including `percent: null`).
 */
function providerHasManagedInstallInFlight(provider: {
  readonly managedInstallState?: ProviderManagedInstallState | null;
  // The protocol type, not a structural stand-in. The row shape used to be
  // spelled out with `status: string`, which widened the wire union to any
  // string: rename `downloading` upstream and the comparison below silently
  // returns false, dropping every user-lane download onto the 15-minute steady
  // lane with no compile error to notice it.
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
 * `host.update.check` answered `cli-unavailable`. That answer retires the
 * whole update region and the retired region hides Check now, so with no
 * focus/reconnect refetch in production nothing would ever notice the Traycer
 * CLI being reinstalled — the region stayed retired until the user left the
 * host scope and came back. The probe fails fast on the host while the CLI is
 * genuinely absent, and the first ok answer revives the region and ends the
 * lane.
 */
/**
 * A fork boundary waiting on the publisher: the chat has not been backed up
 * yet, or the chosen turn is not covered by the last receipt.
 *
 * Backs off because the thing being waited on is a publish sweep rather than a
 * transport fault - it lands when it lands, and the dialog is a foreground
 * surface someone is looking at, so the first few asks are the ones worth
 * making promptly.
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
 * The check itself failed — a transport fault, not an answer. Same recovery
 * reasoning as the lane above ("Couldn't ask …" has no retry button either),
 * on a quieter cadence: reachability is the scope's problem first, this query
 * only needs to catch up once the host is back.
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
  // Opt-in polling (`poll: true`), for one caller: the Overview's drain
  // affordance. Its `busySessionCount` is the number "Apply now — ends N
  // sessions" promises and then destroys, so the question is not whether the
  // cached value may be reused but whether it is still TRUE. Going stale does
  // not refetch on its own, so without a cadence a focused Overview served the
  // count it read on mount indefinitely.
  //
  // Under the query's `staleTime` (30s), deliberately: this interval keeps a
  // healthy read fresh while `isStale` demotes an unhealthy one to `null`. The
  // two numbers are one mechanism and must move together.
  "host.status": {
    ...LATEST_SCHEDULING,
    poll: { kind: "fixed", intervalMs: 10_000 },
  },
  // Restart commits host admission state before its deferred teardown.
  "host.restart": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  // The host's own name: a bounded read that can coalesce. It has no poll —
  // the host watches `host-name.json`, so a rename made anywhere else lands on
  // the next read (or the next explicit invalidation) rather than needing one.
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
  "host.getInstallationInfo": { ...LATEST_SCHEDULING, poll: null },
  "host.service.status": { ...LATEST_SCHEDULING, poll: null },
  // FIFO, like `host.update.install` and for the same reason: these mutate the
  // host's own lifecycle, so two in flight must never collapse to "the latest".
  // Unpolled — a service registration changes only when someone changes it, and
  // the status read above is what refreshes after a write.
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
  "host.getRateLimitUsage": {
    ...LATEST_SCHEDULING,
    poll: { kind: "fixed", intervalMs: 15 * MINUTE_MS },
  },
  // Consuming a reset credit changes the provider's persisted quota state.
  "providers.consumeRateLimitResetCredit": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
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
  // Shell lifecycle from the Shells list and the output window header.
  // `fifo` is what buys these three the guarantees the
  // coordinator reserves for commands: `selectJob` refuses to coalesce a fifo
  // job, `snapshotHostTransition` refuses to abort one, and `cancelActiveRead`
  // refuses to cancel one. A delete destroys the command's entire output
  // history, so it must never be collapsed into another in-flight request or
  // silently dropped on a host swap - the human pressed it once and it either
  // happens or reports why.
  //
  // (Not for cross-method ordering: the coordinator keys queues by
  // [hostId, userId, method, params], so a start and a stop never share a
  // queue and fifo cannot sequence one against the other.)
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
  // Read-only cross-profile fork-admission preflight; no host-side state
  // changes, but each call answers a specific candidate profile so requests
  // are not superseded by one another.
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
  // Optional replacement for the recordActivity start edge: records the
  // activity edge and pulls the role-registry digest cursor forward when
  // behind (roles-snapshot-delivery). Same scheduling as its sibling hooks.
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
  // Optional host capability, read-only: does the source chat's publication
  // cover a chosen fork boundary? Asked when the fork dialog OPENS, and only
  // when the account has a host other than the source, so a single-host user
  // never pays for it.
  "epic.chatPublicationState": {
    // A pure read with no ordering requirement, like every other read here.
    ...LATEST_SCHEDULING,
    // Polled only while the answer is one the FORK DIALOG'S COPY promises will
    // resolve on its own - "It backs up automatically - try again shortly" and
    // "Still syncing this turn - retry shortly". `staleTime` alone only marks
    // the cache stale and issues nothing for a mounted, idle observer, so an
    // open dialog sitting on either answer would wait forever on a sentence
    // that told the user waiting was enough.
    //
    // `false` for a covered chat: that is terminal for this boundary, and a
    // host too old to answer at all never gets here (the read is gated on
    // `useHostSupportsMethod`).
    poll: defineConditionPolicy("epic.chatPublicationState", {
      classify: (data) => {
        if (data === undefined) return false;
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
  // Visibility mutations. Optional host capability. The coordinator's queue
  // identity is method + full params, so these two methods never share a
  // queue and two per-chat flips of different chats do not either. fifo
  // only serializes identical retries of the SAME call. Cross-surface
  // ordering (master toggle vs per-chat) is a client-side one-in-flight
  // gate per (task, viewer) — subsequent requests are refused, not queued.
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
  "epic.listCommentThreads": { ...LATEST_SCHEDULING, poll: null },
  "epic.resolveArtifactByPath": { ...LATEST_SCHEDULING, poll: null },
  "epic.searchArtifacts": { ...LATEST_SCHEDULING, poll: null },
  // The cloud-chat READ surface. All five are reads, so `latest` - and the two
  // properties that follow from the coordinator keying on PARAMS are exactly
  // what this fan-out wants: a read of part A never supersedes a concurrent
  // read of part B (different params, different queue), while two readers
  // asking for the SAME digest at the same time coalesce onto one request.
  // `fifo` would serialize a p99 chat's ~165 parts behind each other for no
  // property gained, since none of these writes anything.
  //
  // No polling. A published head changes only when its owning host publishes
  // again, and this reader has no signal for that; an interval would spend
  // requests on an answer that is almost always identical. A newer head is
  // picked up by reopening.
  "epic.listCloudChats": { ...LATEST_SCHEDULING, poll: null },
  "epic.resolveCloudChatHead": { ...LATEST_SCHEDULING, poll: null },
  "epic.readCloudChatPart": { ...LATEST_SCHEDULING, poll: null },
  "epic.listCloudChatPayloads": { ...LATEST_SCHEDULING, poll: null },
  "epic.readCloudChatPayload": { ...LATEST_SCHEDULING, poll: null },
  // One chat image attachment's bytes. Not polled, and it must not be: the
  // answer is content-addressed, so a hash that resolved once resolves to the
  // same bytes forever and a hash that missed is re-driven by the image blob
  // cache's own retry ladder (`use-image-blob-url.ts`), not by a cadence. An
  // interval here would re-fetch megabytes to re-learn a constant.
  "epic.readChatAttachment": { ...LATEST_SCHEDULING, poll: null },
  // Not polled, and this is a deliberate freshness choice rather than a copy of
  // the row above it. The answer is "which cloud row does this local chat
  // publish into", which changes exactly once in a chat's life - when a fork
  // sends its lineage into a clone row - and never again. A cadence would spend
  // a request per interval per open sidebar to re-learn a constant.
  //
  // What it costs: between a fork's auto-resolution and the next refetch, one
  // sidebar row can be stale - the chat's OLD publication row briefly shows as
  // a separate entry. That is a duplicate-looking row for a moment, not wrong
  // content: the transcript a locked row renders comes from the head read, not
  // from this mapping, so nothing a user is reading goes stale with it. The
  // fork's own notification is the signal that something changed, and a
  // reopened task picks the new mapping up.
  "epic.listChatPublicationTargets": { ...LATEST_SCHEDULING, poll: null },
  // One-shot read: the doc content of an unreachable owner's chat cannot
  // change while its owner is away.
  "epic.chatReplicaRead": { ...LATEST_SCHEDULING, poll: null },
  // The store-backed chat RECORD channel (chat-sync-v2 ticket 49).
  //
  // POLLED, at a cadence, and the reason is that there is no invalidation edge
  // to ride. The facts this serves - a chat was created, renamed, re-parented,
  // archived, deleted - are committed to the chat DATABASE and, since the
  // single-write pivot, are written NOWHERE the renderer already listens: not
  // into the epic Y.Doc (whose update stream is the only per-epic push channel
  // a client has), and not into any per-epic frame on `epic.subscribe`. The
  // host's registry does emit a change stream internally, but it has no wire
  // surface, and giving it one is a new STREAM method - handshake-fatal against
  // a released peer on a surface whose whole point here is to degrade quietly.
  //
  // A condition policy was the alternative and does not fit: `defineConditionPolicy`
  // classifies from THIS method's own response, and nothing in a list of chat
  // rows says whether another one is about to appear. The honest classification
  // is "always maybe", which is a fixed interval wearing a lane's clothes.
  //
  // 20s: a local in-memory registry read, one per open epic. It bounds how long
  // a chat created on ANOTHER device (or by an agent, or by the CLI) stays
  // missing from this renderer's tree - the same staleness the sidebar's own
  // cloud list already tolerates at 30s - and the client's own mutations do not
  // wait for it, since they invalidate this key on success.
  "epic.listChatRecords": {
    ...LATEST_SCHEDULING,
    poll: { kind: "fixed", intervalMs: 20 * SECOND_MS },
  },
  // UNPOLLED, unlike the list above, and for the opposite reason: the list has
  // to notice a chat that appeared elsewhere, while this answers a question
  // whose subject cannot change without a user action. Run settings move when
  // somebody moves them, and the surfaces that move them invalidate this key.
  // Its caller unmounts on close, so a re-open is a fresh read once the entry
  // goes stale - a cadence would only re-ask the host about a card nobody is
  // looking at.
  "epic.getChatRunSettings": {
    ...LATEST_SCHEDULING,
    poll: null,
  },
  // The publisher's own convergence sweep is 30s, so a 45s local read is
  // responsive without asking faster than the underlying state can change.
  "epic.chatBackupStatus": {
    ...LATEST_SCHEDULING,
    poll: { kind: "fixed", intervalMs: 45_000 },
  },
  // Polled: no host-pushed invalidation channel exists for this event today
  // (see the implementation report), so without a cadence a fork detected
  // after this query first cached would never surface. 45s sits between the
  // publisher's own ~30s detection sweep and "expensive enough to matter" -
  // the point of a fork prompt is time-to-resolution, not zero-latency, and
  // this is a single small unary call.
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
  // No poll: the PR detail stream is what notices a new push, and a re-render
  // off a changed `headRefOid` re-keys the query on its own.
  "pr.getLocalDiff": { ...LATEST_SCHEDULING, poll: null },
  // The split form of the same read: one metadata frame when the tile opens,
  // then one small patch per visible row. Same no-poll reasoning - the detail
  // stream notices pushes, and the per-file queries are keyed by immutable
  // OIDs, so there is nothing a cadence could learn.
  "pr.getLocalDiffSummary": { ...LATEST_SCHEDULING, poll: null },
  "pr.getLocalFileDiff": { ...LATEST_SCHEDULING, poll: null },
  // The composer's PR/issue mention sections. Both are latest-wins with no
  // poll: the menu is open for seconds at a time and drives every fetch
  // explicitly (open, refresh click, filter change), so there is no cadence
  // to keep - and a superseded read has nothing worth waiting for.
  "mention.githubCatalog": { ...LATEST_SCHEDULING, poll: null },
  // Latest-wins is load-bearing here rather than incidental: the section
  // searches as the user types, and a queued query that has already been
  // retyped past must not be the one that lands.
  "mention.githubSearch": { ...LATEST_SCHEDULING, poll: null },
  // Creating a terminal allocates a host PTY session.
  "terminal.create": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  // Killing a terminal terminates a host PTY session.
  "terminal.kill": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  "terminal.list": { ...LATEST_SCHEDULING, poll: null },
  // A read that materializes the terminal's output to a file on the host.
  // Latest-wins with no poll: it is issued on demand, and a superseded read
  // has nothing worth waiting for - the next one rewrites the same file.
  "terminal.readOutput": { ...LATEST_SCHEDULING, poll: null },
  // Renaming a terminal persists its display name.
  "terminal.rename": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
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
        // `providers.list` is also the carrier for the native (MCP/plugins/
        // skills) queries, which cache a MAPPED shape under their own
        // `cacheKeyIdentity` rather than the raw response. Those entries have
        // no `providers` array; they opt out of table-owned polling
        // (`poll: false`) and must never drive the classic lanes. This guard
        // has to precede every `data.providers` read below.
        if (!Array.isArray(data.providers)) return false;
        // Ahead of the probe lane deliberately. Both can be true at once on a
        // first boot, and `providers.pending` decays to 30s while an install
        // needs a bounded 5s - taking the faster, tighter-capped lane while
        // bytes are moving is the only ordering that keeps progress readable.
        //
        // Both lanes: automatic (`managedInstallState`) AND user-lane version
        // manager rows (`managedVersions.available[].installState`). A
        // non-blocking installPackVersion leaves only the user-lane row as
        // `downloading` while the automatic lane stays settled — missing that
        // would drop progress onto the 15-minute steady lane.
        // `percent: null` still counts: a sibling-owned transfer needs the
        // fast lane to notice completion.
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
  // Opening a sign-in terminal kills the previous one and spawns a PTY, so
  // ordering is load-bearing: a "latest wins" policy could drop the call that
  // actually left a terminal behind. Concurrent clicks are collapsed
  // host-side, which is where that decision belongs.
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
  // Native MCP/plugins/skills mutations write provider config files, so they
  // are `fifo` for the same reason as the classic provider mutations above:
  // two rapid toggles must both land, in order, not be coalesced into one.
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
  // Reading the upstream LLM provider catalog for a provider - a pure read, so
  // `latest`. `poll: null`: the catalog only changes as a result of an auth
  // mutation on this same surface, which invalidates the query directly.
  "providers.listModelProviders": {
    ...LATEST_SCHEDULING,
    poll: null,
  },
  // Upstream credential writes (connect / start OAuth / submit code /
  // disconnect) - `fifo` for the same reason as `providers.mcpAuth`: two rapid
  // actions must both land, in order, not be coalesced into one.
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
  // A user-initiated "get this provider's managed pack ready" kick. `fifo`
  // because it mutates host-side scheduling state (clears the cell's backoff,
  // promotes it to the front of the install queue) and two rapid retry taps
  // must not be coalesced into one. `poll: null` because the method is a kick,
  // not a status source - progress is read from `providers.list`, which
  // already carries `managedInstallState`.
  "providers.ensurePack": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  // The four per-pack version-manager methods. All `fifo` for the reason
  // `providers.ensurePack` above is: each mutates durable host state (bytes on
  // disk, the shared pin/policy record), so coalescing two rapid taps into one
  // would drop a user action - and unlike a read, replaying the survivor is not
  // equivalent. `poll: null` on all four: none is a status source. Progress and
  // the resulting version list are read from `providers.list`, which carries
  // `managedVersions`; polling the mutation would re-run it.
  //
  // These entries exist because this table is EXHAUSTIVE over the registry's
  // method names - adding a method to `@traycer/protocol` without adding a row
  // here is a gui-app compile error, which is the intended tripwire.
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
  "worktree.listBindingsForEpic": { ...LATEST_SCHEDULING, poll: null },
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
  // A bounded read over settled facts (Usage page + epic cost badge). The
  // Settings panel controls its own refetch (window/metric change, manual
  // retry) and opts out of polling; the ambient epic cost badge opts in
  // (matching `host.getRateLimitUsage`'s cadence below) so it self-heals
  // within a bounded time from a silently-reverted fetch instead of staying
  // stuck pending forever with no other trigger (ticket-7 fixup-01).
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

export type HostRpcMethodMeta<Method extends keyof HostRpcRegistry & string> = {
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
