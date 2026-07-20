import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
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

export type HostMethodPollTable = {
  readonly [
    Method in keyof HostRpcRegistry & string
  ]: HostMethodPollPolicy<Method>;
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

export const HOST_METHOD_POLL_TABLE = {
  "host.status": null,
  "host.getRuntimeCapabilities": null,
  "host.getRateLimitUsage": {
    kind: "fixed",
    intervalMs: 15 * MINUTE_MS,
  },
  "providers.consumeRateLimitResetCredit": null,
  "host.notifications.list": null,
  "host.notificationHooks.status": null,
  "host.notificationHooks.test": null,
  "host.notificationHooks.save": null,
  "host.notifications.getConfig": null,
  "host.notifications.setConfig": null,
  "host.notifications.markRead": null,
  "host.notifications.markAllRead": null,
  "host.notifications.clearAll": null,
  "host.notifications.indicatorState": defineConditionPolicy(
    "host.notifications.indicatorState",
    {
      classify: () => false,
      initialErrorLane: NOTIFICATION_INDICATOR_ERROR_POLL_LANE,
      staleDataErrorLane: NOTIFICATION_INDICATOR_ERROR_POLL_LANE,
      resetLaneIds: NO_RESET_LANES,
    },
  ),
  "comments.listThreads": null,
  "comments.setThreadStatus": null,
  "snapshots.getLocalStorageSize": null,
  "snapshots.readSnapshotDiff": null,
  "snapshots.clearLocalSnapshots": null,
  "agent.gui.listHarnesses": defineConditionPolicy("agent.gui.listHarnesses", {
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
  "agent.gui.listModels": null,
  "agent.gui.listCommands": null,
  "agent.gui.getPlan": null,
  "agent.tui.listHarnesses": null,
  "agent.tui.prepareLaunch": null,
  "agent.tui.generateTitle": null,
  "agent.tui.turnEnded": null,
  "agent.tui.recordActivity": null,
  "agent.create": null,
  "agent.selectionGuide": null,
  "agent.selectionGuide.getGlobal": null,
  "agent.selectionGuide.getGlobalOnboardingDraft": defineConditionPolicy(
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
  "agent.selectionGuide.setGlobal": null,
  "agent.selectionGuide.resetGlobalToDefault": null,
  "agent.listHarnessModels": null,
  "agent.list": null,
  "agent.sendMessage": null,
  "agent.getTranscript": null,
  "agent.inbox.read": null,
  "agent.stop": null,
  "phase.migrateToEpic": null,
  "epic.listTasks": null,
  "epic.setPinned": null,
  "epic.getTaskContexts": null,
  "epic.create": null,
  "epic.batchDelete": null,
  "workspace.prepareFolders": null,
  "workspace.listFileTree": null,
  "workspace.listDirectory": null,
  "workspace.readFile": null,
  "workspace.mentionFiles": null,
  "workspace.mentionFolders": null,
  "workspace.mentionWorktrees": null,
  "workspace.mentionGitRoot": null,
  "workspace.mentionGitBranches": null,
  "workspace.mentionGitCommits": null,
  "workspace.resolvePathsByRepoIdentifiers": null,
  "epic.removeRepo": null,
  "epic.mentionEpics": null,
  "epic.mentionSpecs": null,
  "epic.mentionTickets": null,
  "epic.mentionStories": null,
  "epic.mentionReviews": null,
  "epic.listCollaborators": {
    kind: "fixed",
    intervalMs: 5 * MINUTE_MS,
  },
  "epic.createArtifact": null,
  "epic.deleteArtifact": null,
  "epic.updateArtifactStatus": null,
  "epic.renameArtifact": null,
  "epic.reparentArtifact": null,
  "epic.createChat": null,
  "epic.renameChat": null,
  "epic.updateChatRunSettings": null,
  "epic.deleteChat": null,
  "epic.reparentChat": null,
  "epic.createTuiAgent": null,
  "epic.deleteTuiAgent": null,
  "epic.renameTuiAgent": null,
  "epic.updateTitle": null,
  "epic.grantAccess": null,
  "epic.batchUpdateRoles": null,
  "epic.revokeCollaborator": null,
  "epic.createCommentThread": null,
  "epic.replyToCommentThread": null,
  "epic.editComment": null,
  "epic.deleteComment": null,
  "epic.setCommentThreadResolved": null,
  "epic.deleteCommentThread": null,
  "epic.listCommentThreads": null,
  "epic.resolveArtifactByPath": null,
  "editor.openPaths": null,
  "git.listChangedFiles": defineConditionPolicy("git.listChangedFiles", {
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
  "git.getFileDiff": null,
  "git.getFileDiffs": null,
  "git.getCapabilities": null,
  "terminal.create": null,
  "terminal.kill": null,
  "terminal.list": null,
  "terminal.rename": null,
  "worktree.listByWorkspacePaths": null,
  "worktree.listBranches": null,
  "worktree.create": null,
  "worktree.createPaths": null,
  "worktree.import": null,
  "worktree.setEntryMode": null,
  "workspaceBinding.removeEntry": null,
  "worktree.retrySetup": null,
  "worktree.delete": null,
  "worktree.listAllForHost": null,
  "worktree.setRepoScripts": null,
  "worktree.getBinding": defineConditionPolicy("worktree.getBinding", {
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
  "providers.list": defineConditionPolicy("providers.list", {
    classify: (data) => {
      if (data === undefined) return false;
      const hasPendingProbe = data.providers.some(
        (provider) =>
          provider.enabled &&
          (provider.authPending ||
            provider.availabilityPending ||
            provider.candidates.some((candidate) => candidate.versionPending)),
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
  "providers.setSelection": null,
  "providers.addCustomPath": null,
  "providers.removeCustomPath": null,
  "providers.detectVersion": null,
  "providers.startLogin": null,
  "providers.awaitLogin": null,
  "providers.cancelLogin": null,
  "providers.submitLoginCode": null,
  "providers.touchLogin": null,
  "providers.setApiKey": null,
  "providers.clearApiKey": null,
  "providers.setTerminalAgentArgs": null,
  "providers.setEnvOverride": null,
  "providers.deleteEnvOverride": null,
  "providers.setEnabled": null,
  "worktree.listBindingsForEpic": null,
  "speech.getModelStatus": defineConditionPolicy("speech.getModelStatus", {
    classify: (data) =>
      data?.downloadState === "downloading"
        ? SPEECH_MODEL_DOWNLOADING_POLL_LANE
        : false,
    initialErrorLane: SPEECH_MODEL_INITIAL_ERROR_POLL_LANE,
    staleDataErrorLane: SPEECH_MODEL_STALE_ERROR_POLL_LANE,
    resetLaneIds: NO_RESET_LANES,
  }),
  "speech.ensureModel": null,
  "agent.listProviderProfiles": null,
  "agent.getProviderProfileRateLimits": null,
  "agent.configure": null,
} satisfies HostMethodPollTable;

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
  table: HostMethodPollTable,
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
