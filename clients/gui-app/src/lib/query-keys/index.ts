import { cloudQueryKeys } from "@/lib/query-keys/cloud-query-keys";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { uiQueryKeys } from "@/lib/query-keys/ui-query-keys";

export {
  cloudQueryKeys,
  isCloudEpicTasksQueryKey,
} from "@/lib/query-keys/cloud-query-keys";
export {
  hostQueryKeys,
  isEpicTaskContextsQueryKey,
} from "@/lib/query-keys/host-query-keys";
export { uiQueryKeys } from "@/lib/query-keys/ui-query-keys";
export { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
export { gitMutationKeys } from "@/lib/query-keys/git-mutation-keys";
export { workspaceMutationKeys } from "@/lib/query-keys/workspace-mutation-keys";
export { workspaceQueryKeys } from "@/lib/query-keys/workspace-query-keys";
export { authQueryKeys } from "@/lib/query-keys/auth-query-keys";
export { authMutationKeys } from "@/lib/query-keys/auth-mutation-keys";
export {
  runnerMutationKeys,
  runnerQueryKeys,
  supportBridgeQueryScopeId,
} from "@/lib/query-keys/runner-mutation-keys";
export { configMutationKeys } from "@/lib/query-keys/config-mutation-keys";
export { hostMaintenanceMutationKeys } from "@/lib/query-keys/host-maintenance-mutation-keys";
export { epicMutationKeys } from "@/lib/query-keys/epic-mutation-keys";
export { migrationMutationKeys } from "@/lib/query-keys/migration-mutation-keys";
export {
  editorMutationKeys,
  editorQueryKeys,
} from "@/lib/query-keys/editor-mutation-keys";
export { terminalMutationKeys } from "@/lib/query-keys/terminal-mutation-keys";
export { resourcesMutationKeys } from "@/lib/query-keys/resources-mutation-keys";
export { managedCommandMutationKeys } from "@/lib/query-keys/managed-command-mutation-keys";
export { agentMutationKeys } from "@/lib/query-keys/agent-mutation-keys";
export { worktreeMutationKeys } from "@/lib/query-keys/worktree-mutation-keys";
export { snapshotsMutationKeys } from "@/lib/query-keys/snapshots-mutation-keys";
export { providersMutationKeys } from "@/lib/query-keys/providers-mutation-keys";
export { providersListQueryKey } from "@/lib/query-keys/providers-query-keys";
export {
  CLASSIC_PROVIDERS_LIST_PARAMS,
  isNativeMcpListQueryKey,
  isNativePluginsListQueryKey,
  isNativeSkillsListQueryKey,
  nativeMcpDiscoverParams,
  nativeMcpListParams,
  nativePluginsListParams,
  nativeSkillsListParams,
  providersNativeQueryKeys,
} from "@/lib/query-keys/providers-native-query-keys";
export { modelProvidersQueryKeys } from "@/lib/query-keys/model-providers-query-keys";
export { speechMutationKeys } from "@/lib/query-keys/speech-mutation-keys";
export { notificationsMutationKeys } from "@/lib/query-keys/notifications-mutation-keys";
export { notificationsQueryKeys } from "@/lib/query-keys/notifications-query-keys";
export { prQueryKeys } from "@/lib/query-keys/pr-query-keys";
export { mentionQueryKeys } from "@/lib/query-keys/mention-query-keys";
export { imageMutationKeys } from "@/lib/query-keys/image-mutation-keys";

export const queryKeys = {
  hostBase: hostQueryKeys.base,
  hostScope: hostQueryKeys.scope,
  hostMethodScope: hostQueryKeys.methodScope,
  hostMethod: hostQueryKeys.method,
  hostResolveArtifactByPath: hostQueryKeys.resolveArtifactByPath,
  hostTraycerRateLimitUsage: hostQueryKeys.traycerRateLimitUsage,
  hostUsageSummary: hostQueryKeys.usageSummary,
  hostEpicTaskContexts: hostQueryKeys.epicTaskContexts,
  cloudEpicTasks: cloudQueryKeys.epicTasks,
  cloudEpicTasksLastKnown: cloudQueryKeys.epicTasksLastKnown,
  workspaceEntries: uiQueryKeys.workspaceEntries,
  hostPicker: uiQueryKeys.hostPicker,
  hostPickerMissing: uiQueryKeys.hostPickerMissing,
  cloudEpicTasksDisabled: uiQueryKeys.cloudEpicTasksDisabled,
};
