import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  RpcSchedulingMode,
  RpcSchedulingPolicy,
} from "@traycer-clients/shared/host-client/rpc-scheduling-policy";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";

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
  // Stopping an agent terminates its active execution.
  "agent.stop": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  // Migrating a phase changes the epic's persisted workflow state.
  "phase.migrateToEpic": {
    mode: "fifo",
    joinResponseTimeoutMs: null,
    poll: null,
  },
  "epic.listTasks": { ...LATEST_SCHEDULING, poll: null },
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
  "workspace.readFile": { ...LATEST_SCHEDULING, poll: null },
  "workspace.mentionFiles": { ...LATEST_SCHEDULING, poll: null },
  "workspace.mentionFolders": { ...LATEST_SCHEDULING, poll: null },
  "workspace.mentionWorktrees": { ...LATEST_SCHEDULING, poll: null },
  "workspace.mentionGitRoot": { ...LATEST_SCHEDULING, poll: null },
  "workspace.mentionGitBranches": { ...LATEST_SCHEDULING, poll: null },
  "workspace.mentionGitCommits": { ...LATEST_SCHEDULING, poll: null },
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
  "git.getCapabilities": { ...LATEST_SCHEDULING, poll: null },
  // Creating a terminal allocates a host PTY session.
  "terminal.create": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  // Killing a terminal terminates a host PTY session.
  "terminal.kill": { mode: "fifo", joinResponseTimeoutMs: null, poll: null },
  "terminal.list": { ...LATEST_SCHEDULING, poll: null },
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
