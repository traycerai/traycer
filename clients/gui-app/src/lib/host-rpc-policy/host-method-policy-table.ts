import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  RpcSchedulingMode,
  RpcSchedulingPolicy,
} from "@traycer-clients/shared/host-client/rpc-scheduling-policy";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type { ProviderManagedInstallState } from "@traycer/protocol/host/provider-schemas";

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
  "host.status": { ...LATEST_SCHEDULING, poll: null },
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
  // Dismissing an attention row resolves it (persists the acknowledgement).
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
  // Monitor/shell lifecycle from the "Monitors & Shells" list and the output
  // window header. `fifo` is what buys these three the guarantees the
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
  // Archiving a chat or terminal-agent record persists its archived flag
  // (optional host capability).
  "epic.setChatArchived": {
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
        const hasInstallInFlight = data.providers.some(
          (provider) => provider.managedInstallState?.status === "downloading",
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
