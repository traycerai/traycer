import {
  defineDowngradePath,
  defineFloorAwareVersionedRpcRegistry,
  type VersionedRpcRegistry,
  defineUpgradePath,
  type DowngradeResult,
} from "@traycer/protocol/framework/index";
import {
  defineVersionedStreamRpcRegistry,
  type UncheckedStreamMethodVersionRegistry,
  type VersionedStreamRpcRegistry,
} from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  agentCreateV10,
  agentCreateV20,
  agentCreateV30,
  agentCreateDowngradeV20ToV10,
  agentCreateDowngradeV30ToV10,
  agentCreateDowngradeV30ToV20,
  agentCreateUpgradeV10ToV20,
  agentCreateUpgradeV20ToV30,
  agentGetTranscriptV10,
  agentListHarnessModelsDowngradeV2ToV1,
  agentListHarnessModelsV10,
  agentListHarnessModelsV20,
  agentListHarnessModelsUpgradeV1ToV2,
  agentListDowngradeV2ToV1,
  agentListDowngradeV3ToV1,
  agentListDowngradeV3ToV2,
  agentListDowngradeV4ToV1,
  agentListDowngradeV4ToV2,
  agentListDowngradeV4ToV3,
  agentListDowngradeV5ToV1,
  agentListDowngradeV5ToV2,
  agentListDowngradeV5ToV3,
  agentListDowngradeV5ToV4,
  agentListDowngradeV6ToV1,
  agentListDowngradeV6ToV2,
  agentListDowngradeV6ToV3,
  agentListDowngradeV6ToV4,
  agentListDowngradeV6ToV5,
  agentListDowngradeV7ToV1,
  agentListDowngradeV7ToV2,
  agentListDowngradeV7ToV3,
  agentListDowngradeV7ToV4,
  agentListDowngradeV7ToV5,
  agentListDowngradeV7ToV6,
  agentListDowngradeV8ToV1,
  agentListDowngradeV8ToV2,
  agentListDowngradeV8ToV3,
  agentListDowngradeV8ToV4,
  agentListDowngradeV8ToV5,
  agentListDowngradeV8ToV6,
  agentListDowngradeV8ToV7,
  agentListUpgradeV1ToV2,
  agentListUpgradeV2ToV3,
  agentListUpgradeV3ToV4,
  agentListUpgradeV4ToV5,
  agentListUpgradeV5ToV6,
  agentListUpgradeV6ToV7,
  agentListUpgradeV7ToV8,
  agentListV10,
  agentListV20,
  agentListV30,
  agentListV40,
  agentListV50,
  agentListV60,
  agentListV70,
  agentListV80,
  agentSelectionGuideV10,
  agentSelectionGuideGlobalGetV10,
  agentSelectionGuideGlobalOnboardingDraftGetV10,
  agentSelectionGuideGlobalResetV10,
  agentSelectionGuideGlobalSetV10,
  agentSendMessageV10,
  agentStopV10,
  agentForkV10,
} from "@traycer/protocol/host/agent/contracts";
import {
  agentConfigureDowngradeV20ToV10,
  agentConfigureDowngradeV30ToV10,
  agentConfigureDowngradeV30ToV20,
  agentConfigureDowngradeV40ToV10,
  agentConfigureDowngradeV40ToV20,
  agentConfigureDowngradeV40ToV30,
  agentConfigureDowngradeV50ToV10,
  agentConfigureDowngradeV50ToV20,
  agentConfigureDowngradeV50ToV30,
  agentConfigureDowngradeV50ToV40,
  agentConfigureV10,
  agentConfigureV20,
  agentConfigureV30,
  agentConfigureV40,
  agentConfigureV50,
  agentConfigureUpgradeV10ToV20,
  agentConfigureUpgradeV20ToV30,
  agentConfigureUpgradeV30ToV40,
  agentConfigureUpgradeV40ToV50,
  agentGetProviderProfileRateLimitsDowngradeV20ToV10,
  agentGetProviderProfileRateLimitsDowngradeV30ToV10,
  agentGetProviderProfileRateLimitsDowngradeV30ToV20,
  agentGetProviderProfileRateLimitsDowngradeV40ToV10,
  agentGetProviderProfileRateLimitsDowngradeV40ToV20,
  agentGetProviderProfileRateLimitsDowngradeV40ToV30,
  agentGetProviderProfileRateLimitsDowngradeV50ToV10,
  agentGetProviderProfileRateLimitsDowngradeV50ToV20,
  agentGetProviderProfileRateLimitsDowngradeV50ToV30,
  agentGetProviderProfileRateLimitsDowngradeV50ToV40,
  agentGetProviderProfileRateLimitsV10,
  agentGetProviderProfileRateLimitsV20,
  agentGetProviderProfileRateLimitsV30,
  agentGetProviderProfileRateLimitsV40,
  agentGetProviderProfileRateLimitsV50,
  agentGetProviderProfileRateLimitsUpgradeV10ToV20,
  agentGetProviderProfileRateLimitsUpgradeV20ToV30,
  agentGetProviderProfileRateLimitsUpgradeV30ToV40,
  agentGetProviderProfileRateLimitsUpgradeV40ToV50,
  agentListProviderProfilesDowngradeV20ToV10,
  agentListProviderProfilesDowngradeV30ToV10,
  agentListProviderProfilesDowngradeV30ToV20,
  agentListProviderProfilesDowngradeV40ToV10,
  agentListProviderProfilesDowngradeV40ToV20,
  agentListProviderProfilesDowngradeV40ToV30,
  agentListProviderProfilesDowngradeV50ToV10,
  agentListProviderProfilesDowngradeV50ToV20,
  agentListProviderProfilesDowngradeV50ToV30,
  agentListProviderProfilesDowngradeV50ToV40,
  agentListProviderProfilesV10,
  agentListProviderProfilesV20,
  agentListProviderProfilesV30,
  agentListProviderProfilesV40,
  agentListProviderProfilesV50,
  agentListProviderProfilesUpgradeV10ToV20,
  agentListProviderProfilesUpgradeV20ToV30,
  agentListProviderProfilesUpgradeV30ToV40,
  agentListProviderProfilesUpgradeV40ToV50,
} from "@traycer/protocol/host/agent/profiles";
import {
  agentInboxAckV10,
  agentInboxReadDowngradeV20ToV10,
  agentInboxReadV10,
  agentInboxReadUpgradeV10ToV20,
  agentInboxReadV20,
  agentInboxSubscribeV10,
  agentInboxSubscribeV11,
  agentInboxSubscribeV12,
  agentInboxSubscribeV13,
} from "@traycer/protocol/host/agent/inbox";
import {
  agentActivitySubscribeV10,
  agentActivitySubscribeV11,
} from "@traycer/protocol/host/agent/activity";
import {
  agentRolesClaimUpgradeV10ToV11,
  agentRolesClaimV10,
  agentRolesClaimV11,
  agentRolesListV10,
  agentRolesRelinquishUpgradeV10ToV11,
  agentRolesRelinquishV10,
  agentRolesRelinquishV11,
} from "@traycer/protocol/host/agent/roles";
import {
  agentGuiGetPlanV10,
  agentGuiListCommandsV10,
  agentGuiListHarnessesDowngradeV2ToV1,
  agentGuiListHarnessesDowngradeV3ToV1,
  agentGuiListHarnessesDowngradeV3ToV2,
  agentGuiListHarnessesDowngradeV4ToV1,
  agentGuiListHarnessesDowngradeV4ToV2,
  agentGuiListHarnessesDowngradeV4ToV3,
  agentGuiListHarnessesDowngradeV5ToV1,
  agentGuiListHarnessesDowngradeV5ToV2,
  agentGuiListHarnessesDowngradeV5ToV3,
  agentGuiListHarnessesDowngradeV5ToV4,
  agentGuiListHarnessesDowngradeV6ToV1,
  agentGuiListHarnessesDowngradeV6ToV2,
  agentGuiListHarnessesDowngradeV6ToV3,
  agentGuiListHarnessesDowngradeV6ToV4,
  agentGuiListHarnessesDowngradeV6ToV5,
  agentGuiListHarnessesDowngradeV7ToV1,
  agentGuiListHarnessesDowngradeV7ToV2,
  agentGuiListHarnessesDowngradeV7ToV3,
  agentGuiListHarnessesDowngradeV7ToV4,
  agentGuiListHarnessesDowngradeV7ToV5,
  agentGuiListHarnessesDowngradeV7ToV6,
  agentGuiListHarnessesDowngradeV8ToV1,
  agentGuiListHarnessesDowngradeV8ToV2,
  agentGuiListHarnessesDowngradeV8ToV3,
  agentGuiListHarnessesDowngradeV8ToV4,
  agentGuiListHarnessesDowngradeV8ToV5,
  agentGuiListHarnessesDowngradeV8ToV6,
  agentGuiListHarnessesDowngradeV8ToV7,
  agentGuiListHarnessesUpgradeV1ToV2,
  agentGuiListHarnessesUpgradeV20ToV21,
  agentGuiListHarnessesUpgradeV2ToV3,
  agentGuiListHarnessesUpgradeV3ToV4,
  agentGuiListHarnessesUpgradeV4ToV5,
  agentGuiListHarnessesUpgradeV5ToV6,
  agentGuiListHarnessesUpgradeV6ToV7,
  agentGuiListHarnessesUpgradeV70ToV71,
  agentGuiListHarnessesUpgradeV71ToV80,
  agentGuiListHarnessesV10,
  agentGuiListHarnessesV20,
  agentGuiListHarnessesV21,
  agentGuiListHarnessesV30,
  agentGuiListHarnessesV40,
  agentGuiListHarnessesV50,
  agentGuiListHarnessesV60,
  agentGuiListHarnessesV70,
  agentGuiListHarnessesV71,
  agentGuiListHarnessesV80,
  agentGuiListModelsV10,
  chatSubscribeV10,
  chatSubscribeV11,
  chatSubscribeV12,
  chatSubscribeV13,
  chatSubscribeV14,
  chatSubscribeV15,
  chatSubscribeV16,
  chatSubscribeV17,
  chatSubscribeV18,
} from "@traycer/protocol/host/agent/gui/contracts";
import {
  agentTuiGenerateTitleV10,
  agentTuiTurnEndedV10,
  agentTuiListHarnessesV10,
  agentTuiPrepareLaunchV10,
  agentTuiPrepareLaunchV11,
  agentTuiPrepareLaunchUpgradeV10ToV11,
  agentTuiPromptSubmittedV10,
  agentTuiPromptSubmittedV11,
  agentTuiPromptSubmittedUpgradeV10ToV11,
  agentTuiRecordActivityV10,
  agentTuiRecordActivityV11,
  agentTuiRecordActivityUpgradeV10ToV11,
  agentTuiValidateForkProfileV10,
} from "@traycer/protocol/host/agent/tui/contracts";
import {
  commentsListThreadsV10,
  commentsSetThreadStatusV10,
} from "@traycer/protocol/host/comments/contracts";
import {
  hostStatusV10,
  hostStatusV11,
  hostStatusV12,
  hostStatusV13,
  hostStatusUpgradeV10ToV11,
  hostStatusUpgradeV11ToV12,
  hostStatusUpgradeV12ToV13,
} from "@traycer/protocol/host/status/contracts";
import {
  hostRestartUpgradeV10ToV11,
  hostRestartUpgradeV11ToV12,
  hostRestartV10,
  hostRestartV11,
  hostRestartV12,
} from "@traycer/protocol/host/restart/contracts";
import {
  hostIdentityGetV10,
  hostIdentitySetV10,
} from "@traycer/protocol/host/identity/contracts";
import {
  hostDoctorV10,
  hostGetInstallationInfoUpgradeV10ToV11,
  hostGetInstallationInfoV10,
  hostGetInstallationInfoV11,
  hostServiceDeregisterV10,
  hostServiceRegisterV10,
  hostServiceStatusV10,
  hostUpdateCheckUpgradeV10ToV11,
  hostUpdateCheckV10,
  hostUpdateCheckV11,
  hostUpdateInstallV10,
  hostUpdateInstallV11,
  hostUpdateInstallV12,
  hostUpdateInstallUpgradeV11ToV12,
  hostUpdateInstallUpgradeV10ToV11,
} from "@traycer/protocol/host/maintenance/contracts";
import {
  lifecycleClaimShutdownUpgradeV10ToV11,
  lifecycleClaimShutdownV10,
  lifecycleClaimShutdownV11,
  lifecycleCommitShutdownV10,
  lifecycleReleaseShutdownV10,
} from "@traycer/protocol/host/lifecycle/contracts";
import {
  configEnvDeleteV10,
  configEnvListV10,
  configEnvSetV10,
  configLogLevelsGetV10,
  configLogLevelsSetV10,
  configShellAddV10,
  configShellGetV10,
  configShellListDetectedUpgradeV10ToV11,
  configShellListDetectedV10,
  configShellListDetectedV11,
  configShellProbeV10,
  configShellRemoveV10,
  configShellResetV10,
  configShellRevertArgsV10,
  configShellSetV10,
} from "@traycer/protocol/host/config/contracts";
import {
  diagnosticsLogsListV10,
  diagnosticsLogsTailV10,
} from "@traycer/protocol/host/diagnostics/contracts";
import {
  managedCommandConfigureV10,
  managedCommandDeleteV10,
  managedCommandDeliverHeldV10,
  managedCommandStartUpgradeV10ToV11,
  managedCommandStartV10,
  managedCommandStartV11,
  managedCommandStopUpgradeV10ToV11,
  managedCommandStopV10,
  managedCommandStopV11,
  managedCommandSubscribeOutputV10,
  managedCommandSubscribeOutputV11,
} from "@traycer/protocol/host/managed-command/contracts";
import { hostGetRuntimeCapabilitiesV10 } from "@traycer/protocol/host/runtime-capabilities/contracts";
import { chatForkGetV10 } from "@traycer/protocol/host/chat-fork/contracts";
import {
  chatLocateRowV10,
  chatReadAccumulatedFileChangeV10,
} from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import { hostUsageSummaryV10 } from "@traycer/protocol/host/usage-analytics/contracts";
import {
  hostGetRateLimitUsageV10,
  hostGetRateLimitUsageV11,
  hostGetRateLimitUsageV12,
  hostGetRateLimitUsageV20,
  hostGetRateLimitUsageV21,
  hostGetRateLimitUsageV30,
  hostGetRateLimitUsageV40,
  hostGetRateLimitUsageUpgradeV10ToV11,
  hostGetRateLimitUsageUpgradeV11ToV12,
  hostGetRateLimitUsageUpgradeV12ToV20,
  hostGetRateLimitUsageUpgradeV20ToV21,
  hostGetRateLimitUsageUpgradeV21ToV30,
  hostGetRateLimitUsageUpgradeV30ToV40,
  hostGetRateLimitUsageDowngradeV2ToV1,
  hostGetRateLimitUsageDowngradeV3ToV2,
  hostGetRateLimitUsageDowngradeV3ToV1,
  hostGetRateLimitUsageDowngradeV4ToV1,
  hostGetRateLimitUsageDowngradeV4ToV2,
  hostGetRateLimitUsageDowngradeV4ToV3,
  providersConsumeRateLimitResetCreditV10,
  providersRefreshProfileStatusV10,
} from "@traycer/protocol/host/rate-limit/contracts";
import {
  epicBatchDeleteV10,
  epicBatchUpdateRolesV10,
  epicCreateArtifactV10,
  epicCreateChatUpgradeV10ToV11,
  epicCreateChatV10,
  epicCreateChatV11,
  epicCreateCommentThreadV10,
  epicCreateTuiAgentV10,
  epicCreateTuiAgentV11,
  epicCreateV10,
  epicDeleteArtifactV10,
  epicDeleteChatV10,
  epicDeleteCommentThreadV10,
  epicDeleteCommentV10,
  epicDeleteTuiAgentV10,
  epicEditCommentV10,
  epicFinishArtifactImageV10,
  epicGetTaskContextsV10,
  epicGetTaskContextsV11,
  epicGetTaskContextsV12,
  epicGetTaskContextsUpgradeV10ToV11,
  epicGetTaskContextsUpgradeV11ToV12,
  epicGrantAccessV10,
  epicChatBackupStatusV10,
  epicChatReplicaReadV10,
  epicFetchArtifactAttachmentV10,
  epicListChatRecordsUpgradeV10ToV11,
  epicListChatRecordsV10,
  epicListChatRecordsV11,
  epicGetChatRunSettingsDowngradeV20ToV10,
  epicGetChatRunSettingsUpgradeV10ToV20,
  epicGetChatRunSettingsV10,
  epicGetChatRunSettingsV20,
  epicListChatPublicationTargetsV10,
  epicListCloudChatPayloadsV10,
  epicListCloudChatsV10,
  epicListCollaboratorsV10,
  epicListCommentThreadsV10,
  epicReadChatAttachmentV10,
  epicReadCloudChatPartV10,
  epicReadCloudChatPayloadV10,
  epicResolveCloudChatHeadV10,
  epicListTasksV10,
  epicListTasksV11,
  epicListTasksV12,
  epicListTasksV13,
  epicListTasksUpgradeV10ToV11,
  epicListTasksUpgradeV11ToV12,
  epicListTasksUpgradeV12ToV13,
  epicMentionEpicsV10,
  epicMentionReviewsV10,
  epicMentionSpecsV10,
  epicMentionStoriesV10,
  epicMentionTicketsV10,
  epicPrepareArtifactImageV10,
  epicRemoveRepoV10,
  epicRecordViewedV10,
  epicRenameArtifactV10,
  epicRenameChatV10,
  epicUpdateChatProfileV10,
  epicUpdateChatRunSettingsUpgradeV10ToV11,
  epicUpdateChatRunSettingsV10,
  epicUpdateChatRunSettingsV11,
  epicRenameTuiAgentV10,
  epicReparentArtifactV10,
  epicReparentChatV10,
  epicReplyToCommentThreadV10,
  epicResolveArtifactByPathV10,
  epicSearchArtifactsV10,
  epicRevokeCollaboratorV10,
  epicChatPublicationStateV10,
  epicSetChatArchivedV10,
  epicSetChatSharingDefaultV10,
  epicSetCloudChatVisibilityV10,
  epicSetCommentThreadResolvedV10,
  epicSetPinnedV10,
  epicSubscribeV10,
  epicSubscribeV11,
  epicSubscribeV12,
  epicSubscribeV13,
  epicUpdateArtifactStatusV10,
  epicUpdateTitleV10,
} from "@traycer/protocol/host/epic/contracts";
import {
  epicListTuiAgentsUpgradeV10ToV11,
  epicListTuiAgentsUpgradeV11ToV12,
  epicListTuiAgentsV10,
  epicListTuiAgentsV11,
  epicListTuiAgentsV12,
} from "@traycer/protocol/host/epic/tui-agent-records";
import { epicStateSubscribeV10 } from "@traycer/protocol/host/epic/state-subscribe";
import { epicStatusSubscribeV10 } from "@traycer/protocol/host/epic/status-subscribe";
import { artifactSubscribeV10 } from "@traycer/protocol/host/epic/artifact-subscribe";
import {
  epicGetWorkspaceContextV10,
  epicRetryMigrationV10,
} from "@traycer/protocol/host/epic/lane-unaries";
import {
  workspaceBrowseFoldersV10,
  workspaceBrowseFoldersV11,
  workspaceMentionFilesV10,
  workspaceMentionFoldersV10,
  workspaceMentionWorktreesV10,
  workspaceMentionGitBranchesV10,
  workspaceMentionGitCommitsV10,
  workspaceMentionGitRootV10,
  workspaceListDirectoryV10,
  workspaceListFileTreeV10,
  workspacePrepareFoldersV10,
  workspacePrepareFoldersV11,
  workspacePrepareFoldersV12,
  workspacePrepareFoldersV13,
  workspacePrepareFoldersV14,
  workspaceReadFileV10,
  workspaceWriteFileV10,
  workspaceResolvePathsByRepoIdentifiersV10,
  workspaceSearchPathsV10,
  workspaceSearchTextV10,
} from "@traycer/protocol/host/workspace/contracts";
import { workspaceSubscribeFileListV10 } from "@traycer/protocol/host/workspace/subscribe";
import {
  workspaceStreamAssetV10,
  workspaceStreamAssetV11,
} from "@traycer/protocol/host/workspace/asset-stream";
import {
  gitStreamFileAssetV10,
  gitStreamFileAssetV11,
} from "@traycer/protocol/host/git-asset-stream";
import {
  terminalCreateDowngradeV21ToV10,
  terminalCreateV10,
  terminalCreateV20,
  terminalCreateV21,
  terminalCreateUpgradeV10ToV20,
  terminalCreateUpgradeV20ToV21,
  terminalKillV10,
  terminalListDowngradeV23ToV10,
  terminalListV10,
  terminalListV20,
  terminalListV21,
  terminalListV22,
  terminalListV23,
  terminalListUpgradeV10ToV20,
  terminalListUpgradeV20ToV21,
  terminalListUpgradeV21ToV22,
  terminalListUpgradeV22ToV23,
  terminalReadOutputV10,
  terminalRenameV10,
  terminalSubscribeV10,
  terminalSubscribeV11,
  terminalSubscribeV12,
  terminalSubscribeV13,
  terminalSubscribeV14,
  terminalSubscribeV15,
  terminalSubscribeV16,
} from "@traycer/protocol/host/terminal/contracts";
import {
  browserSavedLoginSitesV10,
  browserScreencastV1,
  browserSessionsV1,
} from "@traycer/protocol/host/browser/contracts";
import {
  terminalPlainCloseDowngradeV21ToV10,
  terminalPlainCloseUpgradeV10ToV21,
  terminalPlainCloseV10,
  terminalPlainCloseV21,
  terminalPlainCreateDowngradeV21ToV10,
  terminalPlainCreateUpgradeV10ToV21,
  terminalPlainCreateV10,
  terminalPlainCreateV21,
  terminalPlainEnsureRunningDowngradeV21ToV10,
  terminalPlainEnsureRunningUpgradeV10ToV21,
  terminalPlainEnsureRunningV10,
  terminalPlainEnsureRunningV21,
  terminalPlainImportLegacyDowngradeV21ToV10,
  terminalPlainImportLegacyUpgradeV10ToV21,
  terminalPlainImportLegacyV10,
  terminalPlainImportLegacyV21,
  terminalPlainListDowngradeV21ToV10,
  terminalPlainListUpgradeV10ToV21,
  terminalPlainListV10,
  terminalPlainListV21,
  terminalPlainRenameDowngradeV21ToV10,
  terminalPlainRenameUpgradeV10ToV21,
  terminalPlainRenameV10,
  terminalPlainRenameV21,
} from "@traycer/protocol/host/terminal/plain-contracts";
import {
  terminalPlainSubscribeListV10,
  terminalPlainSubscribeListV21,
} from "@traycer/protocol/host/terminal/plain-subscribe-list";
import {
  hostNotificationHooksSave,
  hostNotificationHooksStatus,
  hostNotificationHooksTest,
  hostNotificationsClearAll,
  hostNotificationsGetConfig,
  hostNotificationsIndicatorState,
  hostNotificationsIndicatorStateUpgradeV10ToV11,
  hostNotificationsIndicatorStateV10,
  hostNotificationsListDowngradeV22ToV10,
  hostNotificationsListUpgradeV10ToV20,
  hostNotificationsListUpgradeV20ToV21,
  hostNotificationsListUpgradeV21ToV22,
  hostNotificationsListV10,
  hostNotificationsListV20,
  hostNotificationsListV21,
  hostNotificationsListV22,
  hostNotificationsMarkAllRead,
  hostNotificationsMarkRead,
  hostNotificationsResolve,
  hostNotificationsSetConfig,
  hostNotificationsFeedSubscribeV10,
  hostNotificationsFeedSubscribeV11,
  hostNotificationsFeedSubscribeV12,
  hostNotificationsCloudFeedSubscribeV10,
  hostNotificationsCloudFeedSubscribeV11,
  hostNotificationsCloudFeedMarkRead,
  hostNotificationsCloudFeedMarkAllRead,
  hostNotificationsCloudFeedResolve,
  hostNotificationsCloudFeedClear,
  hostNotificationsCloudFeedClearAll,
  hostNotificationsSubscribeV10,
  notificationsSubscribeV10,
  notificationsSubscribeV11,
} from "@traycer/protocol/host/notifications/contracts";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  resourcesSubscribeV10,
  resourcesSubscribeV11,
  resourcesSubscribeV12,
  resourcesSubscribeV13,
  resourcesSubscribeV14,
  resourcesSubscribeV15,
  resourcesKillV10,
  resourcesListLocalServersV10,
} from "@traycer/protocol/host/resources/subscribe";
import {
  speechEnsureModelV10,
  speechGetModelStatusV10,
} from "@traycer/protocol/host/speech/contracts";
import { speechDictateV10 } from "@traycer/protocol/host/speech/subscribe";
import {
  migrationRunV10,
  phaseMigrateToEpicV10,
} from "@traycer/protocol/host/migration/contracts";
import { sessionImportScanV10 } from "@traycer/protocol/host/session-import/scan";
import { sessionImportRunV10 } from "@traycer/protocol/host/session-import/run";
import { sessionImportStatusV10 } from "@traycer/protocol/host/session-import/contracts";
import {
  worktreeDeleteBatchByPathStreamV10,
  worktreeDeleteBatchByPathStreamV11,
} from "@traycer/protocol/host/worktree-delete-batch-stream";
import {
  worktreeDeleteByPathStreamV10,
  worktreeDeleteByPathStreamV11,
  worktreeDeleteByPathStreamV12,
} from "@traycer/protocol/host/worktree-delete-stream";
import { worktreeChangedV10 } from "@traycer/protocol/host/worktree-changed-stream";
import { providersChangedV10 } from "@traycer/protocol/host/providers-changed-stream";
import {
  epicCommunicationGraphSubscribeV10,
  hostCommunicationGraphCloudFeedSubscribeV10,
} from "@traycer/protocol/host/epic/communication-graph";
import {
  hostChatRecordsSubscribeV10,
  hostChatRecordsSubscribeV11,
  hostChatRecordsSubscribeV12,
} from "@traycer/protocol/host/epic/chat-records";
import {
  editorOpenPathsUpgradeV10ToV11,
  editorOpenPathsV10,
  editorOpenPathsV11,
} from "@traycer/protocol/host/editor/contracts";
import {
  gitListChangedFilesV10,
  gitListChangedFilesV11,
  gitListChangedFilesUpgradeV10ToV11,
  gitGetFileDiffV10,
  gitGetFileDiffsV10,
  gitGetFileContentsV10,
  gitGetCapabilitiesV10,
  gitSubscribeStatusV10,
  gitSubscribeStatusV11,
  gitSubscribeStatusV12,
  gitSubscribeStatusV13,
} from "@traycer/protocol/host/git-contracts";
import {
  prSubscribeListForEpicV10,
  prSubscribeDetailV10,
  prGetLocalDiffV10,
  prGetLocalDiffSummaryV10,
  prGetLocalFileDiffV10,
} from "@traycer/protocol/host/pr-contracts";
import {
  mentionGithubCatalogV10,
  mentionGithubSearchV10,
} from "@traycer/protocol/host/mention-contracts";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import {
  worktreeCreateRequestSchema,
  worktreeCreateRequestSchemaV10,
  worktreeCreateResponseSchema,
  worktreeCreatePathsRequestSchema,
  worktreeCreatePathsRequestSchemaV10,
  worktreeCreatePathsResponseSchema,
  worktreeDeleteRequestSchema,
  worktreeDeleteRequestSchemaV11,
  worktreeDeleteRequestSchemaV12,
  worktreeDeleteResponseSchema,
  worktreeListHoldersRequestSchema,
  worktreeListHoldersResponseSchema,
  worktreeListAllForHostRequestSchema,
  worktreeListAllForHostResponseSchema,
  worktreeListAllForHostRequestSchemaV11,
  worktreeListAllForHostResponseSchemaV11,
  worktreeListAllForHostRequestSchemaV12,
  worktreeListAllForHostResponseSchemaV12,
  worktreeListAllForHostRequestSchemaV13,
  worktreeListAllForHostResponseSchemaV13,
  worktreeListAllForHostRequestSchemaV14,
  worktreeListAllForHostResponseSchemaV14,
  worktreeListAllForHostRequestSchemaV15,
  worktreeListAllForHostResponseSchemaV15,
  worktreeListAllForHostRequestSchemaV16,
  worktreeListAllForHostResponseSchemaV16,
  worktreeImportRequestSchema,
  worktreeImportResponseSchema,
  worktreeListBranchesRequestSchema,
  worktreeListBranchesResponseSchema,
  worktreeListByWorkspacePathsRequestSchema,
  worktreeListByWorkspacePathsResponseSchema,
  worktreeListByWorkspacePathsRequestSchemaV11,
  worktreeListByWorkspacePathsResponseSchemaV11,
  worktreeListByWorkspacePathsRequestSchemaV12,
  worktreeListByWorkspacePathsResponseSchemaV12,
  worktreeListByWorkspacePathsRequestSchemaV13,
  worktreeListByWorkspacePathsResponseSchemaV13,
  worktreeListByWorkspacePathsRequestSchemaV14,
  worktreeListByWorkspacePathsResponseSchemaV14,
  worktreeListBindingsForEpicRequestSchema,
  worktreeListBindingsForEpicResponseSchema,
  worktreeListBindingsForEpicResponseSchemaV11,
  worktreeListBindingsForEpicResponseSchemaV12,
  worktreeRetrySetupRequestSchema,
  worktreeRetrySetupResponseSchema,
  workspaceBindingRemoveEntryRequestSchema,
  workspaceBindingRemoveEntryResponseSchema,
  worktreeSetEntryModeRequestSchema,
  worktreeSetEntryModeResponseSchema,
  worktreeSetRepoScriptsRequestSchema,
  worktreeSetRepoScriptsResponseSchema,
  worktreeSetRepoBranchPrefixRequestSchema,
  worktreeSetRepoBranchPrefixResponseSchema,
  worktreeGetBindingRequestSchema,
  worktreeGetBindingResponseSchema,
  LEGACY_HOST_RESOLVED_AT,
} from "@traycer/protocol/host/worktree-schemas";
import {
  snapshotsClearLocalSnapshotsRequestSchema,
  snapshotsClearLocalSnapshotsResponseSchema,
  snapshotsGetLocalStorageSizeRequestSchema,
  snapshotsGetLocalStorageSizeResponseSchema,
  snapshotsReadSnapshotDiffRequestSchema,
  snapshotsReadSnapshotDiffResponseSchema,
} from "@traycer/protocol/host/snapshot-schemas";
import {
  providersAddCustomPathRequestSchema,
  providersAddCustomPathRequestSchemaV10,
  providersAddCustomPathResponseSchema,
  providersAddCustomPathResponseSchemaV10,
  providersAddCustomPathResponseSchemaV20,
  providersAwaitLoginRequestSchema,
  providersAwaitLoginRequestSchemaV10,
  providersAwaitLoginRequestSchemaV20,
  providersAwaitLoginResponseSchema,
  providersAwaitLoginResponseSchemaV10,
  providersAwaitLoginResponseSchemaV20,
  providersCancelLoginRequestSchemaV10,
  providersAwaitMcpAuthRequestSchema,
  providersAwaitMcpAuthResponseSchema,
  providersCancelLoginRequestSchemaV11,
  providersCancelLoginResponseSchema,
  providersCancelMcpAuthRequestSchema,
  providersCancelMcpAuthResponseSchema,
  providersMcpAuthRequestSchema,
  providersMcpAuthResponseSchema,
  providersNativeMutateRequestSchema,
  providersNativeMutateResponseSchema,
  providersCancelLoginResponseSchemaV10,
  providersClearApiKeyRequestSchema,
  providersClearApiKeyRequestSchemaV10,
  providersClearApiKeyResponseSchema,
  providersClearApiKeyResponseSchemaV10,
  providersClearApiKeyResponseSchemaV20,
  providersDeleteEnvOverrideRequestSchema,
  providersDeleteEnvOverrideRequestSchemaV10,
  providersDeleteEnvOverrideResponseSchema,
  providersDeleteEnvOverrideResponseSchemaV10,
  providersDeleteEnvOverrideResponseSchemaV20,
  providersDetectVersionRequestSchema,
  providersDetectVersionResponseSchema,
  providersStartLoginRequestSchemaV10,
  providersStartLoginRequestSchemaV11,
  providersStartLoginResponseSchemaV10,
  providersStartLoginResponseSchemaV11,
  providersSubmitLoginCodeRequestSchema,
  providersSubmitLoginCodeResponseSchema,
  providersTouchLoginRequestSchema,
  providersTouchLoginResponseSchema,
  providersStartTerminalLoginRequestSchema,
  providersStartTerminalLoginRequestSchemaV20,
  providersStartTerminalLoginResponseSchema,
  providersEnsurePackRequestSchema,
  providersEnsurePackResponseSchema,
  // The canonical schemas back the v8.0 head; every older line names a frozen
  // shape.
  providersListRequestSchema,
  providersListResponseSchema,
  providersListRequestSchemaBeforeV70,
  providersListResponseSchemaV10,
  providersListResponseSchemaV20,
  providersListResponseSchemaV30,
  providersListResponseSchemaV40,
  providersListResponseSchemaV50,
  providersListResponseSchemaV60,
  providersListResponseSchemaV70,
  isProfileEnabled,
  providersListModelProvidersRequestSchema,
  providersListModelProvidersResponseSchema,
  providersModelProviderAuthRequestSchema,
  providersModelProviderAuthResponseSchema,
  providersAwaitModelProviderAuthRequestSchema,
  providersAwaitModelProviderAuthResponseSchema,
  providersCancelModelProviderAuthRequestSchema,
  providersCancelModelProviderAuthResponseSchema,
  downgradeProviderCliStateToV10,
  downgradeProviderCliStateListToV20,
  downgradeProviderCliStateListToV30,
  downgradeProviderCliStateToMutationV20,
  downgradeProviderCliStateListToV40,
  downgradeProviderCliStateListToV50,
  downgradeProviderCliStateListToV60,
  downgradeProviderCliStateListToV70,
  providersInstallPackVersionRequestSchema,
  providersInstallPackVersionResponseSchema,
  providersRemovePackVersionRequestSchema,
  providersRemovePackVersionResponseSchema,
  providersUsePackVersionRequestSchema,
  providersUsePackVersionResponseSchema,
  providersSetPackPolicyRequestSchema,
  providersSetPackPolicyResponseSchema,
  providersRefreshPackDiscoveryRequestSchema,
  providersRefreshPackDiscoveryResponseSchema,
  upgradeProviderCliStateV10ToV20,
  upgradeProviderCliStateListToV70Preimage,
  upgradeProviderCliStateV10ToMutationV20,
  providersRemoveCustomPathRequestSchema,
  providersRemoveCustomPathRequestSchemaV10,
  providersRemoveCustomPathResponseSchema,
  providersRemoveCustomPathResponseSchemaV10,
  providersRemoveCustomPathResponseSchemaV20,
  providersSetApiKeyRequestSchema,
  providersSetApiKeyRequestSchemaV10,
  providersSetApiKeyResponseSchema,
  providersSetApiKeyResponseSchemaV10,
  providersSetApiKeyResponseSchemaV20,
  providersSetEnabledRequestSchemaV10,
  providersSetEnabledRequestSchemaV20,
  providersSetEnabledRequestSchemaV21,
  providersSetEnabledResponseSchema,
  providersSetEnabledResponseSchemaV10,
  providersSetEnabledResponseSchemaV20,
  providersSetProfileEnabledRequestSchema,
  providersSetProfileEnabledResponseSchema,
  providersSetEnvOverrideRequestSchema,
  providersSetEnvOverrideRequestSchemaV10,
  providersSetEnvOverrideResponseSchema,
  providersSetEnvOverrideResponseSchemaV10,
  providersSetEnvOverrideResponseSchemaV20,
  providersSetSelectionRequestSchema,
  providersSetSelectionRequestSchemaV10,
  providersSetSelectionResponseSchema,
  providersSetSelectionResponseSchemaV10,
  providersSetSelectionResponseSchemaV20,
  providersSetTerminalAgentArgsRequestSchema,
  providersSetTerminalAgentArgsRequestSchemaV10,
  providersSetTerminalAgentArgsResponseSchema,
  providersSetTerminalAgentArgsResponseSchemaV10,
  providersSetTerminalAgentArgsResponseSchemaV20,
  type DowngradableToV10ProviderState,
  type ProviderCliState,
  type ProviderCliStateV10,
  type ProviderMutationCliStateV20,
  type ProviderLoginCapability,
  type ProviderLoginCapabilityV10,
  type ProviderLoginCapabilityV40,
} from "@traycer/protocol/host/provider-schemas";

export { hostGetRuntimeCapabilitiesV10 };
export { hostGetRateLimitUsageV10 };
export { hostUsageSummaryV10 };

/**
 * Traycer 3.0 host RPC protocol.
 * Add new minors within a major line for backward-compatible changes; each non-initial minor must declare `upgradeFromPreviousVersion`.
 */
// `snapshots.*@1.0` - local-only snapshot storage management.
export const snapshotsGetLocalStorageSizeV10 = defineRpcContract({
  method: "snapshots.getLocalStorageSize",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: snapshotsGetLocalStorageSizeRequestSchema,
  responseSchema: snapshotsGetLocalStorageSizeResponseSchema,
});

export const snapshotsClearLocalSnapshotsV10 = defineRpcContract({
  method: "snapshots.clearLocalSnapshots",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: snapshotsClearLocalSnapshotsRequestSchema,
  responseSchema: snapshotsClearLocalSnapshotsResponseSchema,
});

export const snapshotsReadSnapshotDiffV10 = defineRpcContract({
  method: "snapshots.readSnapshotDiff",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: snapshotsReadSnapshotDiffRequestSchema,
  responseSchema: snapshotsReadSnapshotDiffResponseSchema,
});

// `worktree.*@1.0` - local-only worktree binding lifecycle.
export const worktreeListByWorkspacePathsV10 = defineRpcContract({
  method: "worktree.listByWorkspacePaths",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: worktreeListByWorkspacePathsRequestSchema,
  responseSchema: worktreeListByWorkspacePathsResponseSchema,
});

// v1.1 adds the per-ref committed-scripts preview (`scriptRefs` -> `scriptsAtRefs`) the create-worktree Environment editor uses.
// Folded onto this existing method instead of a standalone `worktree.readScriptsAtRef` so the wire method-set stays identical to v1.0.0 - a new method name fatally fails the equal-set handshake against an already-shipped.
export const worktreeListByWorkspacePathsV11 = defineRpcContract({
  method: "worktree.listByWorkspacePaths",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: worktreeListByWorkspacePathsRequestSchemaV11,
  responseSchema: worktreeListByWorkspacePathsResponseSchemaV11,
});

// Additive upgrade from v1.0: an older peer carries no ref-scripts, so the new fields default to empty.
export const worktreeListByWorkspacePathsUpgradeV10ToV11 = defineUpgradePath<
  typeof worktreeListByWorkspacePathsV10,
  typeof worktreeListByWorkspacePathsV11
>({
  from: worktreeListByWorkspacePathsV10.schemaVersion,
  to: worktreeListByWorkspacePathsV11.schemaVersion,
  upgradeRequest: (request) => ({
    workspacePaths: request.workspacePaths,
    scriptRefs: [],
  }),
  upgradeResponse: (response) => ({
    workspaces: response.workspaces,
    scriptsAtRefs: [],
  }),
});

// v1.2 adds `forceRefresh`, the manual-refresh escape hatch over the minutes-scale TTL cache `WorktreeService` now serves `listForWorkspace` summaries from.
export const worktreeListByWorkspacePathsV12 = defineRpcContract({
  method: "worktree.listByWorkspacePaths",
  schemaVersion: { major: 1, minor: 2 } as const,
  requestSchema: worktreeListByWorkspacePathsRequestSchemaV12,
  responseSchema: worktreeListByWorkspacePathsResponseSchemaV12,
});

// Additive upgrade from v1.1: an older peer never asks for a forced recompute, so the request defaults `forceRefresh: false` (cached-read behavior, unchanged from what v1.1 always did).
export const worktreeListByWorkspacePathsUpgradeV11ToV12 = defineUpgradePath<
  typeof worktreeListByWorkspacePathsV11,
  typeof worktreeListByWorkspacePathsV12
>({
  from: worktreeListByWorkspacePathsV11.schemaVersion,
  to: worktreeListByWorkspacePathsV12.schemaVersion,
  upgradeRequest: (request) => ({
    ...request,
    forceRefresh: false,
  }),
  upgradeResponse: (response) => response,
});

// v1.3 adds per-summary `resolvedAt`, allowing clients to distinguish a
// schema-safe unresolved fallback from facts the host has actually derived.
export const worktreeListByWorkspacePathsV13 = defineRpcContract({
  method: "worktree.listByWorkspacePaths",
  schemaVersion: { major: 1, minor: 3 } as const,
  requestSchema: worktreeListByWorkspacePathsRequestSchemaV13,
  responseSchema: worktreeListByWorkspacePathsResponseSchemaV13,
});

// A v1.2 host predates `resolvedAt` and never emits one, so its rows bridge to the resolved sentinel (NOT `null`): its summaries are authoritative, and stamping `null` would strand every folder as perpetually pending in.
export const worktreeListByWorkspacePathsUpgradeV12ToV13 = defineUpgradePath<
  typeof worktreeListByWorkspacePathsV12,
  typeof worktreeListByWorkspacePathsV13
>({
  from: worktreeListByWorkspacePathsV12.schemaVersion,
  to: worktreeListByWorkspacePathsV13.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    ...response,
    workspaces: response.workspaces.map((workspace) => ({
      ...workspace,
      resolvedAt: LEGACY_HOST_RESOLVED_AT,
    })),
  }),
});

// v1.4 adds per-summary `repoBranchPrefix`, the resolved repository-local worktree branch-prefix override read from `.traycer/environment.json`.
export const worktreeListByWorkspacePathsV14 = defineRpcContract({
  method: "worktree.listByWorkspacePaths",
  schemaVersion: { major: 1, minor: 4 } as const,
  requestSchema: worktreeListByWorkspacePathsRequestSchemaV14,
  responseSchema: worktreeListByWorkspacePathsResponseSchemaV14,
});

// A v1.3 host predates the repository branch-prefix override entirely and never emits one, so its rows bridge to `{ status: "absent" }` - the same answer a git-eligible workspace with no override gets on a current host -.
export const worktreeListByWorkspacePathsUpgradeV13ToV14 = defineUpgradePath<
  typeof worktreeListByWorkspacePathsV13,
  typeof worktreeListByWorkspacePathsV14
>({
  from: worktreeListByWorkspacePathsV13.schemaVersion,
  to: worktreeListByWorkspacePathsV14.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    ...response,
    workspaces: response.workspaces.map((workspace) => ({
      ...workspace,
      repoBranchPrefix: { status: "absent" as const },
      presence: "present" as const,
    })),
  }),
});

export const worktreeListBranchesV10 = defineRpcContract({
  method: "worktree.listBranches",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: worktreeListBranchesRequestSchema,
  responseSchema: worktreeListBranchesResponseSchema,
});

export const worktreeCreateV10 = defineRpcContract({
  method: "worktree.create",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: worktreeCreateRequestSchemaV10,
  responseSchema: worktreeCreateResponseSchema,
});

export const worktreeCreateV11 = defineRpcContract({
  method: "worktree.create",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: worktreeCreateRequestSchema,
  responseSchema: worktreeCreateResponseSchema,
});

export const worktreeCreateUpgradeV10ToV11 = defineUpgradePath<
  typeof worktreeCreateV10,
  typeof worktreeCreateV11
>({
  from: worktreeCreateV10.schemaVersion,
  to: worktreeCreateV11.schemaVersion,
  upgradeRequest: (request) => ({
    ...request,
    entries: request.entries.map((entry) => {
      if (entry.kind !== "worktree") return entry;
      if (entry.branch.type === "existing") {
        return { ...entry, branch: { ...entry.branch } };
      }
      return {
        ...entry,
        branch: {
          type: "new" as const,
          name: entry.branch.name,
          source: entry.branch.source,
          carryUncommittedChanges: entry.branch.carryUncommittedChanges,
          collision: "fail" as const,
        },
      };
    }),
  }),
  upgradeResponse: (response) => response,
});

export const worktreeCreatePathsV10 = defineRpcContract({
  method: "worktree.createPaths",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: worktreeCreatePathsRequestSchemaV10,
  responseSchema: worktreeCreatePathsResponseSchema,
});

export const worktreeCreatePathsV11 = defineRpcContract({
  method: "worktree.createPaths",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: worktreeCreatePathsRequestSchema,
  responseSchema: worktreeCreatePathsResponseSchema,
});

export const worktreeCreatePathsUpgradeV10ToV11 = defineUpgradePath<
  typeof worktreeCreatePathsV10,
  typeof worktreeCreatePathsV11
>({
  from: worktreeCreatePathsV10.schemaVersion,
  to: worktreeCreatePathsV11.schemaVersion,
  upgradeRequest: (request) => ({
    entries: request.entries.map((entry) => {
      if (entry.branch.type === "existing") {
        return { ...entry, branch: { ...entry.branch } };
      }
      return {
        ...entry,
        branch: {
          type: "new" as const,
          name: entry.branch.name,
          source: entry.branch.source,
          carryUncommittedChanges: entry.branch.carryUncommittedChanges,
          collision: "fail" as const,
        },
      };
    }),
  }),
  upgradeResponse: (response) => response,
});

export const worktreeImportV10 = defineRpcContract({
  method: "worktree.import",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: worktreeImportRequestSchema,
  responseSchema: worktreeImportResponseSchema,
});

// Per-folder mode flip.
export const worktreeSetEntryModeV10 = defineRpcContract({
  method: "worktree.setEntryMode",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: worktreeSetEntryModeRequestSchema,
  responseSchema: worktreeSetEntryModeResponseSchema,
});

export const workspaceBindingRemoveEntryV10 = defineRpcContract({
  method: "workspaceBinding.removeEntry",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: workspaceBindingRemoveEntryRequestSchema,
  responseSchema: workspaceBindingRemoveEntryResponseSchema,
});

export const worktreeRetrySetupV10 = defineRpcContract({
  method: "worktree.retrySetup",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: worktreeRetrySetupRequestSchema,
  responseSchema: worktreeRetrySetupResponseSchema,
});

export const worktreeDeleteV10 = defineRpcContract({
  method: "worktree.delete",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: worktreeDeleteRequestSchema,
  responseSchema: worktreeDeleteResponseSchema,
});

/** `worktree.delete@1.1` - optional `stopOwners`. */
export const worktreeDeleteV11 = defineRpcContract({
  method: "worktree.delete",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: worktreeDeleteRequestSchemaV11,
  responseSchema: worktreeDeleteResponseSchema,
});

export const worktreeDeleteUpgradeV10ToV11 = defineUpgradePath<
  typeof worktreeDeleteV10,
  typeof worktreeDeleteV11
>({
  from: worktreeDeleteV10.schemaVersion,
  to: worktreeDeleteV11.schemaVersion,
  upgradeRequest: (request) => ({
    ...request,
    stopOwners: false,
  }),
  upgradeResponse: (response) => response,
});

/** `worktree.delete@1.2` - optional `expectedHoldersRevision`. */
export const worktreeDeleteV12 = defineRpcContract({
  method: "worktree.delete",
  schemaVersion: { major: 1, minor: 2 } as const,
  requestSchema: worktreeDeleteRequestSchemaV12,
  responseSchema: worktreeDeleteResponseSchema,
});

export const worktreeDeleteUpgradeV11ToV12 = defineUpgradePath<
  typeof worktreeDeleteV11,
  typeof worktreeDeleteV12
>({
  from: worktreeDeleteV11.schemaVersion,
  to: worktreeDeleteV12.schemaVersion,
  upgradeRequest: (request) => ({
    ...request,
    expectedHoldersRevision: undefined,
  }),
  upgradeResponse: (response) => response,
});

/**
 * Brand-new v1.0 method (not part of `RELEASED_FLOOR_METHOD_NAMES`), registered with `degrade: { kind: "unsupported" }`: an old host simply lacks it, and callers get per-call upgrade guidance instead of a fatal handshake.
 */
export const worktreeListHoldersV10 = defineRpcContract({
  method: "worktree.listHolders",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: worktreeListHoldersRequestSchema,
  responseSchema: worktreeListHoldersResponseSchema,
});

// Host-wide worktree surface for Settings ▸ Worktrees.
export const worktreeListAllForHostV10 = defineRpcContract({
  method: "worktree.listAllForHost",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: worktreeListAllForHostRequestSchema,
  responseSchema: worktreeListAllForHostResponseSchema,
});

// v1.1 adds caller-bounded pagination (`cursor`, `limit`, `nextCursor`), the staleness signals (`includeActivity` request flag; per-entry `lastActivityAt`, `owners`, `branchStatus`, `createdAt`) the housekeeping skill.
// Folded onto this existing method - never a new method name - so the wire method-set stays identical to v1.0.0; see `worktreeListByWorkspacePathsV11` and the RPC backward-compat decision log.
export const worktreeListAllForHostV11 = defineRpcContract({
  method: "worktree.listAllForHost",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: worktreeListAllForHostRequestSchemaV11,
  responseSchema: worktreeListAllForHostResponseSchemaV11,
});

// v1.2 adds `submodules[].atPinnedCommit`, a positive proof that the submodule branch/tip equals the superproject's pinned gitlink.
export const worktreeListAllForHostV12 = defineRpcContract({
  method: "worktree.listAllForHost",
  schemaVersion: { major: 1, minor: 2 } as const,
  requestSchema: worktreeListAllForHostRequestSchemaV12,
  responseSchema: worktreeListAllForHostResponseSchemaV12,
});

export const worktreeListAllForHostUpgradeV10ToV11 = defineUpgradePath<
  typeof worktreeListAllForHostV10,
  typeof worktreeListAllForHostV11
>({
  from: worktreeListAllForHostV10.schemaVersion,
  to: worktreeListAllForHostV11.schemaVersion,
  upgradeRequest: () => ({
    includeActivity: false,
    activityPaths: null,
    cursor: null,
    limit: null,
  }),
  upgradeResponse: (response) => ({
    worktrees: response.worktrees.map((entry) => ({
      ...entry,
      lastActivityAt: null,
      owners: [],
      branchStatus: null,
      createdAt: null,
      prState: null,
      prNumber: null,
      prUrl: null,
      mergedHeadShaMatches: false,
      submodules: [],
      atBaseCommit: false,
    })),
    nextCursor: null,
  }),
});

export const worktreeListAllForHostUpgradeV11ToV12 = defineUpgradePath<
  typeof worktreeListAllForHostV11,
  typeof worktreeListAllForHostV12
>({
  from: worktreeListAllForHostV11.schemaVersion,
  to: worktreeListAllForHostV12.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    worktrees: response.worktrees.map((entry) => ({
      ...entry,
      submodules: entry.submodules.map((fact) => ({
        ...fact,
        atPinnedCommit: false,
        unmergedCommitCount: null,
        unmergedCommitSubjects: null,
      })),
    })),
    nextCursor: response.nextCursor,
  }),
});

export const worktreeListAllForHostV13 = defineRpcContract({
  method: "worktree.listAllForHost",
  schemaVersion: { major: 1, minor: 3 } as const,
  requestSchema: worktreeListAllForHostRequestSchemaV13,
  responseSchema: worktreeListAllForHostResponseSchemaV13,
});

// Additive upgrade from v1.2: an older peer never asks for a forced recompute, so the request defaults `forceRefresh: false` (cached-read behavior, unchanged from what v1.2 always did).
export const worktreeListAllForHostUpgradeV12ToV13 = defineUpgradePath<
  typeof worktreeListAllForHostV12,
  typeof worktreeListAllForHostV13
>({
  from: worktreeListAllForHostV12.schemaVersion,
  to: worktreeListAllForHostV13.schemaVersion,
  upgradeRequest: (request) => ({
    ...request,
    forceRefresh: false,
  }),
  upgradeResponse: (response) => response,
});

// v1.4 adds per-row `resolvedAt`, allowing clients to distinguish a
// schema-safe unresolved fallback from facts the host has actually derived.
export const worktreeListAllForHostV14 = defineRpcContract({
  method: "worktree.listAllForHost",
  schemaVersion: { major: 1, minor: 4 } as const,
  requestSchema: worktreeListAllForHostRequestSchemaV14,
  responseSchema: worktreeListAllForHostResponseSchemaV14,
});

// A v1.3 host predates `resolvedAt` and never emits one, so its rows bridge to the resolved sentinel (NOT `null`): stamping `null` would strand every worktree in the settings panel as perpetually "checking" -.
export const worktreeListAllForHostUpgradeV13ToV14 = defineUpgradePath<
  typeof worktreeListAllForHostV13,
  typeof worktreeListAllForHostV14
>({
  from: worktreeListAllForHostV13.schemaVersion,
  to: worktreeListAllForHostV14.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    ...response,
    worktrees: response.worktrees.map((worktree) => ({
      ...worktree,
      resolvedAt: LEGACY_HOST_RESOLVED_AT,
    })),
  }),
});

// v1.5 adds the same `presence` fact to the host-wide worktree listing.
// Do not "re-pair" them by reopening a `listByWorkspacePaths@1.5` - the fact rides `@1.4` there.
export const worktreeListAllForHostV15 = defineRpcContract({
  method: "worktree.listAllForHost",
  schemaVersion: { major: 1, minor: 5 } as const,
  requestSchema: worktreeListAllForHostRequestSchemaV15,
  responseSchema: worktreeListAllForHostResponseSchemaV15,
});

export const worktreeListAllForHostUpgradeV14ToV15 = defineUpgradePath<
  typeof worktreeListAllForHostV14,
  typeof worktreeListAllForHostV15
>({
  from: worktreeListAllForHostV14.schemaVersion,
  to: worktreeListAllForHostV15.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    ...response,
    worktrees: response.worktrees.map((worktree) => ({
      ...worktree,
      presence: "present" as const,
    })),
  }),
});

export const worktreeListAllForHostV16 = defineRpcContract({
  method: "worktree.listAllForHost",
  schemaVersion: { major: 1, minor: 6 } as const,
  requestSchema: worktreeListAllForHostRequestSchemaV16,
  responseSchema: worktreeListAllForHostResponseSchemaV16,
});

export const worktreeListAllForHostUpgradeV15ToV16 = defineUpgradePath<
  typeof worktreeListAllForHostV15,
  typeof worktreeListAllForHostV16
>({
  from: worktreeListAllForHostV15.schemaVersion,
  to: worktreeListAllForHostV16.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    ...response,
    worktrees: response.worktrees.map((worktree) => ({
      ...worktree,
      gitUnreadable: false,
    })),
  }),
});

export const worktreeSetRepoScriptsV10 = defineRpcContract({
  method: "worktree.setRepoScripts",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: worktreeSetRepoScriptsRequestSchema,
  responseSchema: worktreeSetRepoScriptsResponseSchema,
});

// `worktree.setRepoBranchPrefix@1.0` - a brand-new method (not a version bump of an existing one: there is no floor method this naturally extends), added AFTER the released floor was frozen.
export const worktreeSetRepoBranchPrefixV10 = defineRpcContract({
  method: "worktree.setRepoBranchPrefix",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: worktreeSetRepoBranchPrefixRequestSchema,
  responseSchema: worktreeSetRepoBranchPrefixResponseSchema,
});

// `worktree.getBinding@1.0` - owner-scoped binding read used by GUI surfaces that do not subscribe to a chat (TUI-agent toolbar).
export const worktreeGetBindingV10 = defineRpcContract({
  method: "worktree.getBinding",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: worktreeGetBindingRequestSchema,
  responseSchema: worktreeGetBindingResponseSchema,
});

// `providers.*@1.0` - per-device provider CLI resolution.
// `providers.list` always returns every provider; v1.0 is frozen without the ACP GUI harness providers, v2.0 carries them, and the v2→v1 bridge drops them for v1.0 clients.
export const providersListV10 = defineRpcContract({
  method: "providers.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersListRequestSchemaBeforeV70,
  responseSchema: providersListResponseSchemaV10,
});

export const providersListV20 = defineRpcContract({
  method: "providers.list",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: providersListRequestSchemaBeforeV70,
  responseSchema: providersListResponseSchemaV20,
});

function unsupportedProviderStateDowngrade(
  providerId: ProviderCliState["providerId"],
): DowngradeResult<never> {
  return {
    ok: false,
    error: {
      code: "DOWNGRADE_UNSUPPORTED",
      message: `Provider ${providerId} is not available in providers.*@1.0`,
    },
  };
}

// `DowngradableToV10ProviderState` (imported) accepts either the live (latest) state or the frozen v2.0 state - see `downgradeProviderCliStateToV10`'s comment, which owns the shape.
function downgradeProviderStateForV10(
  state: DowngradableToV10ProviderState,
): DowngradeResult<ProviderCliStateV10> {
  const downgraded = downgradeProviderCliStateToV10(state);
  if (downgraded === null) {
    return unsupportedProviderStateDowngrade(state.providerId);
  }
  return { ok: true, value: downgraded };
}

function downgradeProviderStateListForV10(
  states: readonly DowngradableToV10ProviderState[],
): ProviderCliStateV10[] {
  return states.flatMap((state) => {
    const downgraded = downgradeProviderCliStateToV10(state);
    return downgraded === null ? [] : [downgraded];
  });
}

// Upgrades a v1.0 state to the frozen major-2 mutation-response shape - shared by every provider.* state-echo mutation's v1.0 -> v2.0 bridge (`providers.list` freezes its own v2.0 shape and upgrades via.
// Like the v1.0 host itself, the frozen 2.0 shape predates `profiles`; each method's 2.0 -> 2.1 upgrade fills `profiles: []` for the caller's canonical.
function upgradeProviderStateFromV10(
  state: ProviderCliStateV10,
): ProviderMutationCliStateV20 {
  return upgradeProviderCliStateV10ToMutationV20(state);
}

// Applied where `providers.list`'s pre-v4.0 line upgrades to the live shape, alongside the existing `profiles: []` fill.
const PROVIDER_LIVE_FIELDS_PRE_REGISTRY = {
  managedInstallState: null,
  versionVisibility: null,
  advisory: null,
} as const;

// Fills the code-paste capability slot a frozen pre-`codePaste` state (v1.0, v2.0, v3.0) never carries - same "old host never had this feature" semantics as the `profiles: []` fill these upgrade bridges already apply to.
function upgradeLoginCapabilityFromV10(
  loginCapability: ProviderLoginCapabilityV10 | null,
): ProviderLoginCapabilityV40 | null {
  return loginCapability === null
    ? null
    : { ...loginCapability, codePaste: null };
}

// Fills the terminal-login capability slot a frozen V40-shaped state (the v4.0/v5.0/v6.0 list lines and every @2.1 mutation echo) never carries - same "old host never had this feature" semantics as the `codePaste` fill.
// `terminalLogin` ships with the v7.0 line, so a v6.0 host either predates it or never reported it, and "sign in from a terminal is not offered" is the honest projection.
function upgradeLoginCapabilityFromV40(
  loginCapability: ProviderLoginCapabilityV40 | null,
): ProviderLoginCapability | null {
  return loginCapability === null
    ? null
    : { ...loginCapability, terminalLogin: null };
}
function downgradeProviderRequestForV10<T>(
  schema: {
    safeParse: (
      value: unknown,
    ) => { success: true; data: T } | { success: false };
  },
  request: {
    readonly providerId: ProviderCliState["providerId"];
    readonly [key: string]: unknown;
  },
): DowngradeResult<T> {
  const parsed = schema.safeParse(request);
  if (!parsed.success)
    return unsupportedProviderStateDowngrade(request.providerId);
  return { ok: true, value: parsed.data };
}

export const providersListUpgradeV1ToV2 = defineUpgradePath<
  typeof providersListV10,
  typeof providersListV20
>({
  from: { major: 1, minor: 0 },
  to: { major: 2, minor: 0 },
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    providers: response.providers.map(upgradeProviderCliStateV10ToV20),
  }),
});

export const providersListDowngradeV2ToV1 = defineDowngradePath<
  typeof providersListV20,
  typeof providersListV10
>({
  from: { major: 2, minor: 0 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => ({
    ok: true,
    value: providersListResponseSchemaV10.parse({
      providers: downgradeProviderStateListForV10(response.providers),
    }),
  }),
});

export const providersListV30 = defineRpcContract({
  method: "providers.list",
  schemaVersion: { major: 3, minor: 0 } as const,
  requestSchema: providersListRequestSchemaBeforeV70,
  responseSchema: providersListResponseSchemaV30,
});

export const providersListUpgradeV2ToV3 = defineUpgradePath<
  typeof providersListV20,
  typeof providersListV30
>({
  from: { major: 2, minor: 0 },
  to: { major: 3, minor: 0 },
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const providersListDowngradeV3ToV2 = defineDowngradePath<
  typeof providersListV30,
  typeof providersListV20
>({
  from: { major: 3, minor: 0 },
  to: { major: 2, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => ({
    ok: true,
    value: providersListResponseSchemaV20.parse({
      providers: downgradeProviderCliStateListToV20(response.providers),
    }),
  }),
});

export const providersListDowngradeV3ToV1 = defineDowngradePath<
  typeof providersListV30,
  typeof providersListV10
>({
  from: { major: 3, minor: 0 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => ({
    ok: true,
    value: providersListResponseSchemaV10.parse({
      providers: downgradeProviderStateListForV10(response.providers),
    }),
  }),
});

// v4.0 adds `profiles` (multi-profile management), `nativeCapabilities` (per- provider MCP/plugins/skills facts), Devin/Pi, and folds native list/discover onto optional `native` request/response fields.
export const providersListV40 = defineRpcContract({
  method: "providers.list",
  schemaVersion: { major: 4, minor: 0 } as const,
  // Frozen: `cli-v1.1.4` shipped this line, and `host-v1.1.10` re-froze it without `native`.
  requestSchema: providersListRequestSchemaBeforeV70,
  responseSchema: providersListResponseSchemaV40,
});

export const providersListUpgradeV3ToV4 = defineUpgradePath<
  typeof providersListV30,
  typeof providersListV40
>({
  from: { major: 3, minor: 0 },
  to: { major: 4, minor: 0 },
  // The request shape is identical - the request upgrade is identity.
  // So "the target is the live shape" identifies the head hop, never a reason a fill lands on a middle hop.)
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    providers: response.providers.map((provider) => ({
      ...provider,
      profiles: [],
      loginCapability: upgradeLoginCapabilityFromV10(provider.loginCapability),
    })),
  }),
});

export const providersListDowngradeV4ToV3 = defineDowngradePath<
  typeof providersListV40,
  typeof providersListV30
>({
  from: { major: 4, minor: 0 },
  to: { major: 3, minor: 0 },
  downgradeRequest: (request) => ({
    ok: true,
    value: providersListRequestSchemaBeforeV70.parse({
      forceAuthRefresh: request.forceAuthRefresh,
    }),
  }),
  downgradeResponse: (response) => ({
    ok: true,
    value: providersListResponseSchemaV30.parse({
      providers: downgradeProviderCliStateListToV30(response.providers),
    }),
  }),
});

export const providersListDowngradeV4ToV2 = defineDowngradePath<
  typeof providersListV40,
  typeof providersListV20
>({
  from: { major: 4, minor: 0 },
  to: { major: 2, minor: 0 },
  downgradeRequest: (request) => ({
    ok: true,
    value: providersListRequestSchemaBeforeV70.parse({
      forceAuthRefresh: request.forceAuthRefresh,
    }),
  }),
  downgradeResponse: (response) => ({
    ok: true,
    value: providersListResponseSchemaV20.parse({
      providers: downgradeProviderCliStateListToV20(response.providers),
    }),
  }),
});

export const providersListDowngradeV4ToV1 = defineDowngradePath<
  typeof providersListV40,
  typeof providersListV10
>({
  from: { major: 4, minor: 0 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) => ({
    ok: true,
    value: providersListRequestSchemaBeforeV70.parse({
      forceAuthRefresh: request.forceAuthRefresh,
    }),
  }),
  downgradeResponse: (response) => ({
    ok: true,
    value: providersListResponseSchemaV10.parse({
      providers: downgradeProviderStateListForV10(response.providers),
    }),
  }),
});

export const providersListV50 = defineRpcContract({
  method: "providers.list",
  schemaVersion: { major: 5, minor: 0 } as const,
  // Frozen without `native` for the same reason as the v4.0 line above:
  // `host-v1.1.10` shipped this request shape.
  requestSchema: providersListRequestSchemaBeforeV70,
  // Frozen: `cli-v1.1.8` shipped this line, so it must serve the v5.0 id set rather than the live one.
  responseSchema: providersListResponseSchemaV50,
});

export const providersListV60 = defineRpcContract({
  method: "providers.list",
  schemaVersion: { major: 6, minor: 0 } as const,
  // Frozen without `native` for the same reason as the v4.0 line above:
  // `host-v1.1.10` shipped this request shape.
  requestSchema: providersListRequestSchemaBeforeV70,
  // Frozen: `cli-v1.1.9` shipped this line.
  responseSchema: providersListResponseSchemaV60,
});

// `providers.list@7.0` response is frozen at `providersListResponseSchemaV70`. Freeze line N when N+1 opens, or before N ships.
// Do not regenerate frozen-catalog-lines to green. Keep `*V70Preimage` for the v6->v7 bridge; v8.0 is the live response line.
export const providersListV70 = defineRpcContract({
  method: "providers.list",
  schemaVersion: { major: 7, minor: 0 } as const,
  // The REQUEST is deliberately still the live schema: the freeze moved only the response, and `providersListRequestSchemaV70` remains the hand-copy that `provider-schemas-v70-pins.test.ts` holds equal to it.
  requestSchema: providersListRequestSchema,
  responseSchema: providersListResponseSchemaV70,
});

export const providersListV80 = defineRpcContract({
  method: "providers.list",
  schemaVersion: { major: 8, minor: 0 } as const,
  requestSchema: providersListRequestSchema,
  responseSchema: providersListResponseSchema,
});

export const providersListUpgradeV70ToV80 = defineUpgradePath<
  typeof providersListV70,
  typeof providersListV80
>({
  from: { major: 7, minor: 0 },
  to: { major: 8, minor: 0 },
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    ...response,
    providers: response.providers.map((provider) => ({
      ...provider,
      profiles: provider.profiles.map((profile) => ({
        ...profile,
        enabled: true,
      })),
    })),
  }),
});

export const providersListUpgradeV5ToV6 = defineUpgradePath<
  typeof providersListV50,
  typeof providersListV60
>({
  from: { major: 5, minor: 0 },
  to: { major: 6, minor: 0 },
  // Purely additive: a v5.0 provider set is already a valid v6.0 one (omp simply never appears).
  // That target is now frozen too, which does not move the fill: v7.0 models these fields, and freezing a shape pins what it models rather than removing it.
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const providersListUpgradeV6ToV7 = defineUpgradePath<
  typeof providersListV60,
  typeof providersListV70
>({
  from: { major: 6, minor: 0 },
  to: { major: 7, minor: 0 },
  // The fill's home for the registry fields, `native`, and per-provider `nativeCapabilities` alike, moved up one line for the same reason the registry fields moved from v3->v4 to v5->v6 before: this is now the first bridge.
  // Deleting a version is never just deleting its contract: whatever its bridge did has to land on the surviving hop.
  upgradeRequest: (request) => ({ ...request, native: null }),
  // Two passes, in order, and the order is load-bearing.
  // Then the fields v8.0 introduced, filled with "this host never had the feature" - the same honest projection every upgrade in this file applies.
  upgradeResponse: (response) => ({
    providers: upgradeProviderCliStateListToV70Preimage(
      response.providers.map((provider) => ({
        ...provider,
        ...PROVIDER_LIVE_FIELDS_PRE_REGISTRY,
        loginCapability: upgradeLoginCapabilityFromV40(
          provider.loginCapability,
        ),
      })),
    ).map((provider) => ({
      ...provider,
      packId: null,
      managedVersions: null,
      nextRunBinary: null,
      managedInstallState: null,
      // The v7-era capability descriptor predates `modelProviders`; the live
      // shape requires the key, so the same honest fill applies.
      nativeCapabilities: {
        ...provider.nativeCapabilities,
        modelProviders: null,
      },
    })),
    native: null,
  }),
});

export const providersListDowngradeV6ToV5 = defineDowngradePath<
  typeof providersListV60,
  typeof providersListV50
>({
  from: { major: 6, minor: 0 },
  to: { major: 5, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop omp so an already-shipped v5.0 client's strict decode never sees it.
  downgradeResponse: (response) => ({
    ok: true,
    value: providersListResponseSchemaV50.parse({
      providers: downgradeProviderCliStateListToV50(response.providers),
    }),
  }),
});

export const providersListDowngradeV6ToV4 = defineDowngradePath<
  typeof providersListV60,
  typeof providersListV40
>({
  from: { major: 6, minor: 0 },
  to: { major: 4, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => ({
    ok: true,
    value: providersListResponseSchemaV40.parse({
      providers: downgradeProviderCliStateListToV40(response.providers),
    }),
  }),
});

export const providersListDowngradeV6ToV3 = defineDowngradePath<
  typeof providersListV60,
  typeof providersListV30
>({
  from: { major: 6, minor: 0 },
  to: { major: 3, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => ({
    ok: true,
    value: providersListResponseSchemaV30.parse({
      providers: downgradeProviderCliStateListToV30(response.providers),
    }),
  }),
});

export const providersListDowngradeV6ToV2 = defineDowngradePath<
  typeof providersListV60,
  typeof providersListV20
>({
  from: { major: 6, minor: 0 },
  to: { major: 2, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => ({
    ok: true,
    value: providersListResponseSchemaV20.parse({
      providers: downgradeProviderCliStateListToV20(response.providers),
    }),
  }),
});

export const providersListDowngradeV6ToV1 = defineDowngradePath<
  typeof providersListV60,
  typeof providersListV10
>({
  from: { major: 6, minor: 0 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => ({
    ok: true,
    value: providersListResponseSchemaV10.parse({
      providers: downgradeProviderStateListForV10(response.providers),
    }),
  }),
});

export const providersListDowngradeV7ToV6 = defineDowngradePath<
  typeof providersListV70,
  typeof providersListV60
>({
  from: { major: 7, minor: 0 },
  to: { major: 6, minor: 0 },
  // v7.x is the only line whose request models `native`; every target below it is pinned to `providersListRequestSchemaBeforeV70`.
  // Re-parsed field by field rather than passed through, so the carrier can never reach a peer whose schema does not model it.
  downgradeRequest: (request) => ({
    ok: true,
    value: providersListRequestSchemaBeforeV70.parse({
      forceAuthRefresh: request.forceAuthRefresh,
    }),
  }),
  // Two jobs on the response: drop post-v6.0 providers (`huggingface`) and strip the provider-pack-registry fields the frozen v6.0 state does not model.
  // The shared filter-by-reparse helper does both - a row whose id is not in the frozen v6.0 enum does not survive its parse, and the keys v6.0 never modelled are dropped from the rows that do.
  downgradeResponse: (response) => ({
    ok: true,
    value: providersListResponseSchemaV60.parse({
      providers: downgradeProviderCliStateListToV60(response.providers),
    }),
  }),
});

export const providersListDowngradeV7ToV5 = defineDowngradePath<
  typeof providersListV70,
  typeof providersListV50
>({
  from: { major: 7, minor: 0 },
  to: { major: 5, minor: 0 },
  // v7.x is the only line whose request models `native`; every target below it is pinned to `providersListRequestSchemaBeforeV70`.
  // Re-parsed field by field rather than passed through, so the carrier can never reach a peer whose schema does not model it.
  downgradeRequest: (request) => ({
    ok: true,
    value: providersListRequestSchemaBeforeV70.parse({
      forceAuthRefresh: request.forceAuthRefresh,
    }),
  }),
  downgradeResponse: (response) => ({
    ok: true,
    value: providersListResponseSchemaV50.parse({
      providers: downgradeProviderCliStateListToV50(response.providers),
    }),
  }),
});

export const providersListDowngradeV7ToV4 = defineDowngradePath<
  typeof providersListV70,
  typeof providersListV40
>({
  from: { major: 7, minor: 0 },
  to: { major: 4, minor: 0 },
  // v7.x is the only line whose request models `native`; every target below it is pinned to `providersListRequestSchemaBeforeV70`.
  // Re-parsed field by field rather than passed through, so the carrier can never reach a peer whose schema does not model it.
  downgradeRequest: (request) => ({
    ok: true,
    value: providersListRequestSchemaBeforeV70.parse({
      forceAuthRefresh: request.forceAuthRefresh,
    }),
  }),
  downgradeResponse: (response) => ({
    ok: true,
    value: providersListResponseSchemaV40.parse({
      providers: downgradeProviderCliStateListToV40(response.providers),
    }),
  }),
});

export const providersListDowngradeV7ToV3 = defineDowngradePath<
  typeof providersListV70,
  typeof providersListV30
>({
  from: { major: 7, minor: 0 },
  to: { major: 3, minor: 0 },
  // v7.x is the only line whose request models `native`; every target below it is pinned to `providersListRequestSchemaBeforeV70`.
  // Re-parsed field by field rather than passed through, so the carrier can never reach a peer whose schema does not model it.
  downgradeRequest: (request) => ({
    ok: true,
    value: providersListRequestSchemaBeforeV70.parse({
      forceAuthRefresh: request.forceAuthRefresh,
    }),
  }),
  downgradeResponse: (response) => ({
    ok: true,
    value: providersListResponseSchemaV30.parse({
      providers: downgradeProviderCliStateListToV30(response.providers),
    }),
  }),
});

export const providersListDowngradeV7ToV2 = defineDowngradePath<
  typeof providersListV70,
  typeof providersListV20
>({
  from: { major: 7, minor: 0 },
  to: { major: 2, minor: 0 },
  // v7.x is the only line whose request models `native`; every target below it is pinned to `providersListRequestSchemaBeforeV70`.
  // Re-parsed field by field rather than passed through, so the carrier can never reach a peer whose schema does not model it.
  downgradeRequest: (request) => ({
    ok: true,
    value: providersListRequestSchemaBeforeV70.parse({
      forceAuthRefresh: request.forceAuthRefresh,
    }),
  }),
  downgradeResponse: (response) => ({
    ok: true,
    value: providersListResponseSchemaV20.parse({
      providers: downgradeProviderCliStateListToV20(response.providers),
    }),
  }),
});

export const providersListDowngradeV7ToV1 = defineDowngradePath<
  typeof providersListV70,
  typeof providersListV10
>({
  from: { major: 7, minor: 0 },
  to: { major: 1, minor: 0 },
  // v7.x is the only line whose request models `native`; every target below it is pinned to `providersListRequestSchemaBeforeV70`.
  // Re-parsed field by field rather than passed through, so the carrier can never reach a peer whose schema does not model it.
  downgradeRequest: (request) => ({
    ok: true,
    value: providersListRequestSchemaBeforeV70.parse({
      forceAuthRefresh: request.forceAuthRefresh,
    }),
  }),
  downgradeResponse: (response) => ({
    ok: true,
    value: providersListResponseSchemaV10.parse({
      providers: downgradeProviderStateListForV10(response.providers),
    }),
  }),
});

function enabledProviderProfilesOnly(
  providers: readonly ProviderCliState[],
): ProviderCliState[] {
  return providers.map((provider) => ({
    ...provider,
    profiles: provider.profiles.filter(isProfileEnabled),
  }));
}

export const providersListDowngradeV8ToV7 = defineDowngradePath<
  typeof providersListV80,
  typeof providersListV70
>({
  from: { major: 8, minor: 0 },
  to: { major: 7, minor: 0 },
  downgradeRequest: (request) => ({
    ok: true,
    value: providersListRequestSchema.parse(request),
  }),
  downgradeResponse: (response) => ({
    ok: true,
    value: providersListResponseSchemaV70.parse({
      ...response,
      providers: downgradeProviderCliStateListToV70(response.providers),
    }),
  }),
});

export const providersListDowngradeV8ToV6 = defineDowngradePath<
  typeof providersListV80,
  typeof providersListV60
>({
  from: { major: 8, minor: 0 },
  to: { major: 6, minor: 0 },
  downgradeRequest: (request) => ({
    ok: true,
    value: providersListRequestSchemaBeforeV70.parse(request),
  }),
  downgradeResponse: (response) => ({
    ok: true,
    value: providersListResponseSchemaV60.parse({
      providers: downgradeProviderCliStateListToV60(
        enabledProviderProfilesOnly(response.providers),
      ),
    }),
  }),
});

export const providersListDowngradeV8ToV5 = defineDowngradePath<
  typeof providersListV80,
  typeof providersListV50
>({
  from: { major: 8, minor: 0 },
  to: { major: 5, minor: 0 },
  downgradeRequest: (request) => ({
    ok: true,
    value: providersListRequestSchemaBeforeV70.parse(request),
  }),
  downgradeResponse: (response) => ({
    ok: true,
    value: providersListResponseSchemaV50.parse({
      providers: downgradeProviderCliStateListToV50(
        enabledProviderProfilesOnly(response.providers),
      ),
    }),
  }),
});

export const providersListDowngradeV8ToV4 = defineDowngradePath<
  typeof providersListV80,
  typeof providersListV40
>({
  from: { major: 8, minor: 0 },
  to: { major: 4, minor: 0 },
  downgradeRequest: (request) => ({
    ok: true,
    value: providersListRequestSchemaBeforeV70.parse(request),
  }),
  downgradeResponse: (response) => ({
    ok: true,
    value: providersListResponseSchemaV40.parse({
      providers: downgradeProviderCliStateListToV40(
        enabledProviderProfilesOnly(response.providers),
      ),
    }),
  }),
});

export const providersListDowngradeV8ToV3 = defineDowngradePath<
  typeof providersListV80,
  typeof providersListV30
>({
  from: { major: 8, minor: 0 },
  to: { major: 3, minor: 0 },
  downgradeRequest: (request) => ({
    ok: true,
    value: providersListRequestSchemaBeforeV70.parse(request),
  }),
  downgradeResponse: (response) => ({
    ok: true,
    value: providersListResponseSchemaV30.parse({
      providers: downgradeProviderCliStateListToV30(
        enabledProviderProfilesOnly(response.providers),
      ),
    }),
  }),
});

export const providersListDowngradeV8ToV2 = defineDowngradePath<
  typeof providersListV80,
  typeof providersListV20
>({
  from: { major: 8, minor: 0 },
  to: { major: 2, minor: 0 },
  downgradeRequest: (request) => ({
    ok: true,
    value: providersListRequestSchemaBeforeV70.parse(request),
  }),
  downgradeResponse: (response) => ({
    ok: true,
    value: providersListResponseSchemaV20.parse({
      providers: downgradeProviderCliStateListToV20(
        enabledProviderProfilesOnly(response.providers),
      ),
    }),
  }),
});

export const providersListDowngradeV8ToV1 = defineDowngradePath<
  typeof providersListV80,
  typeof providersListV10
>({
  from: { major: 8, minor: 0 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) => ({
    ok: true,
    value: providersListRequestSchemaBeforeV70.parse(request),
  }),
  downgradeResponse: (response) => ({
    ok: true,
    value: providersListResponseSchemaV10.parse({
      providers: enabledProviderProfilesOnly(response.providers).flatMap(
        (provider) => {
          const downgraded = downgradeProviderCliStateToV10(provider);
          return downgraded === null ? [] : [downgraded];
        },
      ),
    }),
  }),
});

export const providersListUpgradeV4ToV5 = defineUpgradePath<
  typeof providersListV40,
  typeof providersListV50
>({
  from: { major: 4, minor: 0 },
  to: { major: 5, minor: 0 },
  // A v4.0 response without Hermes is a valid v5.0 response (purely additive), and both lines are pinned to the same frozen pre-v7.0 request schema - both upgrades are identity.
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const providersListDowngradeV5ToV4 = defineDowngradePath<
  typeof providersListV50,
  typeof providersListV40
>({
  from: { major: 5, minor: 0 },
  to: { major: 4, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  // Drop Hermes so an already-shipped v4.0 client's strict decode never
  // sees it.
  downgradeResponse: (response) => ({
    ok: true,
    value: providersListResponseSchemaV40.parse({
      providers: downgradeProviderCliStateListToV40(response.providers),
    }),
  }),
});

export const providersListDowngradeV5ToV3 = defineDowngradePath<
  typeof providersListV50,
  typeof providersListV30
>({
  from: { major: 5, minor: 0 },
  to: { major: 3, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => ({
    ok: true,
    value: providersListResponseSchemaV30.parse({
      providers: downgradeProviderCliStateListToV30(response.providers),
    }),
  }),
});

export const providersListDowngradeV5ToV2 = defineDowngradePath<
  typeof providersListV50,
  typeof providersListV20
>({
  from: { major: 5, minor: 0 },
  to: { major: 2, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => ({
    ok: true,
    value: providersListResponseSchemaV20.parse({
      providers: downgradeProviderCliStateListToV20(response.providers),
    }),
  }),
});

export const providersListDowngradeV5ToV1 = defineDowngradePath<
  typeof providersListV50,
  typeof providersListV10
>({
  from: { major: 5, minor: 0 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => ({
    ok: true,
    value: providersListResponseSchemaV10.parse({
      providers: downgradeProviderStateListForV10(response.providers),
    }),
  }),
});

export const providersSetSelectionV10 = defineRpcContract({
  method: "providers.setSelection",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersSetSelectionRequestSchemaV10,
  responseSchema: providersSetSelectionResponseSchemaV10,
});

export const providersSetSelectionV20 = defineRpcContract({
  method: "providers.setSelection",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: providersSetSelectionRequestSchema,
  responseSchema: providersSetSelectionResponseSchemaV20,
});

export const providersSetSelectionUpgradeV1ToV2 = defineUpgradePath<
  typeof providersSetSelectionV10,
  typeof providersSetSelectionV20
>({
  from: { major: 1, minor: 0 },
  to: { major: 2, minor: 0 },
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    state: upgradeProviderStateFromV10(response.state),
  }),
});

// v2.1 carries the live state shape - `profiles` ships with the 2.1 line (the released 2.0 response above is frozen pre-profiles), so a released 2.0 host's response upgrades to `profiles: []` ("old host never had this.
export const providersSetSelectionV21 = defineRpcContract({
  method: "providers.setSelection",
  schemaVersion: { major: 2, minor: 1 } as const,
  requestSchema: providersSetSelectionRequestSchema,
  responseSchema: providersSetSelectionResponseSchema,
});

export const providersSetSelectionUpgradeV20ToV21 = defineUpgradePath<
  typeof providersSetSelectionV20,
  typeof providersSetSelectionV21
>({
  from: { major: 2, minor: 0 },
  to: { major: 2, minor: 1 },
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    state: {
      ...response.state,
      profiles: [],
      loginCapability: upgradeLoginCapabilityFromV10(
        response.state.loginCapability,
      ),
    },
  }),
});

export const providersSetSelectionDowngradeV21ToV20 = defineDowngradePath<
  typeof providersSetSelectionV21,
  typeof providersSetSelectionV20
>({
  from: { major: 2, minor: 1 },
  to: { major: 2, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => {
    const state = downgradeProviderCliStateToMutationV20(response.state);
    return {
      ok: true,
      value: providersSetSelectionResponseSchemaV20.parse({ state }),
    };
  },
});

export const providersSetSelectionDowngradeV21ToV10 = defineDowngradePath<
  typeof providersSetSelectionV21,
  typeof providersSetSelectionV10
>({
  from: { major: 2, minor: 1 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) =>
    downgradeProviderRequestForV10(
      providersSetSelectionRequestSchemaV10,
      request,
    ),
  downgradeResponse: (response) => {
    const state = downgradeProviderStateForV10(response.state);
    if (!state.ok) return state;
    return {
      ok: true,
      value: providersSetSelectionResponseSchemaV10.parse({
        state: state.value,
      }),
    };
  },
});

export const providersAddCustomPathV10 = defineRpcContract({
  method: "providers.addCustomPath",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersAddCustomPathRequestSchemaV10,
  responseSchema: providersAddCustomPathResponseSchemaV10,
});

export const providersAddCustomPathV20 = defineRpcContract({
  method: "providers.addCustomPath",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: providersAddCustomPathRequestSchema,
  responseSchema: providersAddCustomPathResponseSchemaV20,
});

export const providersAddCustomPathUpgradeV1ToV2 = defineUpgradePath<
  typeof providersAddCustomPathV10,
  typeof providersAddCustomPathV20
>({
  from: { major: 1, minor: 0 },
  to: { major: 2, minor: 0 },
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    state: upgradeProviderStateFromV10(response.state),
  }),
});

// v2.1 carries the live state shape - `profiles` ships with the 2.1 line (the released 2.0 response above is frozen pre-profiles), so a released 2.0 host's response upgrades to `profiles: []` ("old host never had this.
export const providersAddCustomPathV21 = defineRpcContract({
  method: "providers.addCustomPath",
  schemaVersion: { major: 2, minor: 1 } as const,
  requestSchema: providersAddCustomPathRequestSchema,
  responseSchema: providersAddCustomPathResponseSchema,
});

export const providersAddCustomPathUpgradeV20ToV21 = defineUpgradePath<
  typeof providersAddCustomPathV20,
  typeof providersAddCustomPathV21
>({
  from: { major: 2, minor: 0 },
  to: { major: 2, minor: 1 },
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    state: {
      ...response.state,
      profiles: [],
      loginCapability: upgradeLoginCapabilityFromV10(
        response.state.loginCapability,
      ),
    },
  }),
});

export const providersAddCustomPathDowngradeV21ToV20 = defineDowngradePath<
  typeof providersAddCustomPathV21,
  typeof providersAddCustomPathV20
>({
  from: { major: 2, minor: 1 },
  to: { major: 2, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => {
    const state = downgradeProviderCliStateToMutationV20(response.state);
    return {
      ok: true,
      value: providersAddCustomPathResponseSchemaV20.parse({ state }),
    };
  },
});

export const providersAddCustomPathDowngradeV21ToV10 = defineDowngradePath<
  typeof providersAddCustomPathV21,
  typeof providersAddCustomPathV10
>({
  from: { major: 2, minor: 1 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) =>
    downgradeProviderRequestForV10(
      providersAddCustomPathRequestSchemaV10,
      request,
    ),
  downgradeResponse: (response) => {
    const state = downgradeProviderStateForV10(response.state);
    if (!state.ok) return state;
    return {
      ok: true,
      value: providersAddCustomPathResponseSchemaV10.parse({
        state: state.value,
      }),
    };
  },
});

export const providersRemoveCustomPathV10 = defineRpcContract({
  method: "providers.removeCustomPath",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersRemoveCustomPathRequestSchemaV10,
  responseSchema: providersRemoveCustomPathResponseSchemaV10,
});

export const providersRemoveCustomPathV20 = defineRpcContract({
  method: "providers.removeCustomPath",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: providersRemoveCustomPathRequestSchema,
  responseSchema: providersRemoveCustomPathResponseSchemaV20,
});

export const providersRemoveCustomPathUpgradeV1ToV2 = defineUpgradePath<
  typeof providersRemoveCustomPathV10,
  typeof providersRemoveCustomPathV20
>({
  from: { major: 1, minor: 0 },
  to: { major: 2, minor: 0 },
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    state: upgradeProviderStateFromV10(response.state),
  }),
});

// v2.1 carries the live state shape - `profiles` ships with the 2.1 line (the released 2.0 response above is frozen pre-profiles), so a released 2.0 host's response upgrades to `profiles: []` ("old host never had this.
export const providersRemoveCustomPathV21 = defineRpcContract({
  method: "providers.removeCustomPath",
  schemaVersion: { major: 2, minor: 1 } as const,
  requestSchema: providersRemoveCustomPathRequestSchema,
  responseSchema: providersRemoveCustomPathResponseSchema,
});

export const providersRemoveCustomPathUpgradeV20ToV21 = defineUpgradePath<
  typeof providersRemoveCustomPathV20,
  typeof providersRemoveCustomPathV21
>({
  from: { major: 2, minor: 0 },
  to: { major: 2, minor: 1 },
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    state: {
      ...response.state,
      profiles: [],
      loginCapability: upgradeLoginCapabilityFromV10(
        response.state.loginCapability,
      ),
    },
  }),
});

export const providersRemoveCustomPathDowngradeV21ToV20 = defineDowngradePath<
  typeof providersRemoveCustomPathV21,
  typeof providersRemoveCustomPathV20
>({
  from: { major: 2, minor: 1 },
  to: { major: 2, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => {
    const state = downgradeProviderCliStateToMutationV20(response.state);
    return {
      ok: true,
      value: providersRemoveCustomPathResponseSchemaV20.parse({ state }),
    };
  },
});

export const providersRemoveCustomPathDowngradeV21ToV10 = defineDowngradePath<
  typeof providersRemoveCustomPathV21,
  typeof providersRemoveCustomPathV10
>({
  from: { major: 2, minor: 1 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) =>
    downgradeProviderRequestForV10(
      providersRemoveCustomPathRequestSchemaV10,
      request,
    ),
  downgradeResponse: (response) => {
    const state = downgradeProviderStateForV10(response.state);
    if (!state.ok) return state;
    return {
      ok: true,
      value: providersRemoveCustomPathResponseSchemaV10.parse({
        state: state.value,
      }),
    };
  },
});

export const providersDetectVersionV10 = defineRpcContract({
  method: "providers.detectVersion",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersDetectVersionRequestSchema,
  responseSchema: providersDetectVersionResponseSchema,
});

export const providersStartLoginV10 = defineRpcContract({
  method: "providers.startLogin",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersStartLoginRequestSchemaV10,
  responseSchema: providersStartLoginResponseSchemaV10,
});

// `worktree.listBindingsForEpic@1.1` - v1.1 adds `profileId` / `createProfile` to the request and `profileId` to the response - re-authenticate an existing managed profile, or mint a brand-new one, instead of a.
export const providersStartLoginV11 = defineRpcContract({
  method: "providers.startLogin",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: providersStartLoginRequestSchemaV11,
  responseSchema: providersStartLoginResponseSchemaV11,
});

export const providersStartLoginUpgradeV10ToV11 = defineUpgradePath<
  typeof providersStartLoginV10,
  typeof providersStartLoginV11
>({
  from: { major: 1, minor: 0 },
  to: { major: 1, minor: 1 },
  upgradeRequest: (request) => ({
    ...request,
    profileId: null,
    createProfile: null,
  }),
  upgradeResponse: (response) => ({
    ...response,
    profileId: null,
  }),
});

export const providersAwaitLoginV10 = defineRpcContract({
  method: "providers.awaitLogin",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersAwaitLoginRequestSchemaV10,
  responseSchema: providersAwaitLoginResponseSchemaV10,
});

export const providersAwaitLoginV20 = defineRpcContract({
  method: "providers.awaitLogin",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: providersAwaitLoginRequestSchemaV20,
  responseSchema: providersAwaitLoginResponseSchemaV20,
});

export const providersAwaitLoginUpgradeV1ToV2 = defineUpgradePath<
  typeof providersAwaitLoginV10,
  typeof providersAwaitLoginV20
>({
  from: { major: 1, minor: 0 },
  to: { major: 2, minor: 0 },
  // Frozen v2.0 request/response are byte-identical to v1.0's shape (plus the state upgrade) - `profileId`/`existingProfileId` are v2.1-only additions, see `providersAwaitLoginUpgradeV20ToV21` below.
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    state:
      response.state === null
        ? null
        : upgradeProviderStateFromV10(response.state),
  }),
});

// v2.1 adds `profileId` to the request (await the same profile-scoped login child `providers.startLogin@1.1` started) and, on the response, `profiles` on the echoed state plus `existingProfileId` (duplicate-account.
// The released 2.0 shapes above are frozen without all three; this upgrade fills the "old host never had this feature" defaults.
export const providersAwaitLoginV21 = defineRpcContract({
  method: "providers.awaitLogin",
  schemaVersion: { major: 2, minor: 1 } as const,
  requestSchema: providersAwaitLoginRequestSchema,
  responseSchema: providersAwaitLoginResponseSchema,
});

export const providersAwaitLoginUpgradeV20ToV21 = defineUpgradePath<
  typeof providersAwaitLoginV20,
  typeof providersAwaitLoginV21
>({
  from: { major: 2, minor: 0 },
  to: { major: 2, minor: 1 },
  upgradeRequest: (request) => ({
    ...request,
    profileId: null,
  }),
  upgradeResponse: (response) => ({
    state:
      response.state === null
        ? null
        : {
            ...response.state,
            profiles: [],
            loginCapability: upgradeLoginCapabilityFromV10(
              response.state.loginCapability,
            ),
          },
    existingProfileId: null,
    codeRejected: false,
  }),
});

export const providersAwaitLoginDowngradeV21ToV20 = defineDowngradePath<
  typeof providersAwaitLoginV21,
  typeof providersAwaitLoginV20
>({
  from: { major: 2, minor: 1 },
  to: { major: 2, minor: 0 },
  downgradeRequest: (request) => ({
    ok: true,
    value: providersAwaitLoginRequestSchemaV20.parse({
      providerId: request.providerId,
    }),
  }),
  downgradeResponse: (response) => {
    if (response.state === null) {
      return {
        ok: true,
        value: providersAwaitLoginResponseSchemaV20.parse({ state: null }),
      };
    }
    const state = downgradeProviderCliStateToMutationV20(response.state);
    return {
      ok: true,
      value: providersAwaitLoginResponseSchemaV20.parse({ state }),
    };
  },
});

export const providersAwaitLoginDowngradeV21ToV10 = defineDowngradePath<
  typeof providersAwaitLoginV21,
  typeof providersAwaitLoginV10
>({
  from: { major: 2, minor: 1 },
  to: { major: 1, minor: 0 },
  // Drop `profileId` before the parse: `providersAwaitLoginRequestSchemaV10` is a strict object that never learned it, so passing the full request through would fail the strict parse and drop the whole downgrade.
  downgradeRequest: (request) => {
    const { profileId, ...legacyRequest } = request;
    return downgradeProviderRequestForV10(
      providersAwaitLoginRequestSchemaV10,
      legacyRequest,
    );
  },
  downgradeResponse: (response) => {
    if (response.state === null) {
      return {
        ok: true,
        value: providersAwaitLoginResponseSchemaV10.parse({ state: null }),
      };
    }
    const state = downgradeProviderStateForV10(response.state);
    if (!state.ok) return state;
    return {
      ok: true,
      value: providersAwaitLoginResponseSchemaV10.parse({
        state: state.value,
      }),
    };
  },
});

export const providersCancelLoginV10 = defineRpcContract({
  method: "providers.cancelLogin",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersCancelLoginRequestSchemaV10,
  responseSchema: providersCancelLoginResponseSchemaV10,
});

// v1.1 adds `profileId`, mirroring `providers.startLogin@1.1` - cancel the same profile-scoped login child that was started.
export const providersCancelLoginV11 = defineRpcContract({
  method: "providers.cancelLogin",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: providersCancelLoginRequestSchemaV11,
  responseSchema: providersCancelLoginResponseSchema,
});

export const providersCancelLoginUpgradeV10ToV11 = defineUpgradePath<
  typeof providersCancelLoginV10,
  typeof providersCancelLoginV11
>({
  from: { major: 1, minor: 0 },
  to: { major: 1, minor: 1 },
  upgradeRequest: (request) => ({
    ...request,
    profileId: null,
  }),
  upgradeResponse: (response) => ({
    ...response,
  }),
});

/**
 * `providers.startLogin@1.1` - Native MCP/plugins/skills surface: four brand-new v1.0 methods, none of them on `RELEASED_FLOOR_METHOD_NAMES`, all registered below with `degrade: { kind: "unsupported" }`.
 * Released lines are frozen; new capability belongs on new methods.
 */
export const providersMcpAuthV10 = defineRpcContract({
  method: "providers.mcpAuth",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersMcpAuthRequestSchema,
  responseSchema: providersMcpAuthResponseSchema,
});

/** Bounded status poll for an in-flight MCP auth. Never a long poll. */
export const providersAwaitMcpAuthV10 = defineRpcContract({
  method: "providers.awaitMcpAuth",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersAwaitMcpAuthRequestSchema,
  responseSchema: providersAwaitMcpAuthResponseSchema,
});

/** Cancels an in-flight MCP auth. */
export const providersCancelMcpAuthV10 = defineRpcContract({
  method: "providers.cancelMcpAuth",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersCancelMcpAuthRequestSchema,
  responseSchema: providersCancelMcpAuthResponseSchema,
});

/** MCP/plugins/skills mutations. */
export const providersNativeMutateV10 = defineRpcContract({
  method: "providers.nativeMutate",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersNativeMutateRequestSchema,
  responseSchema: providersNativeMutateResponseSchema,
});

// `providers.ensurePack@1.0` - ── Per-pack version-manager methods + the on-demand discovery refresh ─────

/** User-requested download of one version, without flipping `current`. */
export const providersInstallPackVersionV10 = defineRpcContract({
  method: "providers.installPackVersion",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersInstallPackVersionRequestSchema,
  responseSchema: providersInstallPackVersionResponseSchema,
});

/** Delete one installed version's bytes. */
export const providersRemovePackVersionV10 = defineRpcContract({
  method: "providers.removePackVersion",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersRemovePackVersionRequestSchema,
  responseSchema: providersRemovePackVersionResponseSchema,
});

/** Pin the pack to a version, or clear the pin (`version: null`). */
export const providersUsePackVersionV10 = defineRpcContract({
  method: "providers.usePackVersion",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersUsePackVersionRequestSchema,
  responseSchema: providersUsePackVersionResponseSchema,
});

/** Set the per-pack auto-download policy. */
export const providersSetPackPolicyV10 = defineRpcContract({
  method: "providers.setPackPolicy",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersSetPackPolicyRequestSchema,
  responseSchema: providersSetPackPolicyResponseSchema,
});

/** Run the pack-discovery poll for one pack now, instead of waiting out the jittered ticker period. */
export const providersRefreshPackDiscoveryV10 = defineRpcContract({
  method: "providers.refreshPackDiscovery",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersRefreshPackDiscoveryRequestSchema,
  responseSchema: providersRefreshPackDiscoveryResponseSchema,
});

/**
 * Model Providers surface: four brand-new v1.0 methods, none of them on `RELEASED_FLOOR_METHOD_NAMES`, all registered below with `degrade: { kind: "unsupported" }` - the same optional-capability channel the.
 */
export const providersListModelProvidersV10 = defineRpcContract({
  method: "providers.listModelProviders",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersListModelProvidersRequestSchema,
  responseSchema: providersListModelProvidersResponseSchema,
});

/** Connect / start-OAuth / submit-code / disconnect for one upstream provider. */
export const providersModelProviderAuthV10 = defineRpcContract({
  method: "providers.modelProviderAuth",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersModelProviderAuthRequestSchema,
  responseSchema: providersModelProviderAuthResponseSchema,
});

/** Bounded status poll for an in-flight OAuth attempt. Never a long poll. */
export const providersAwaitModelProviderAuthV10 = defineRpcContract({
  method: "providers.awaitModelProviderAuth",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersAwaitModelProviderAuthRequestSchema,
  responseSchema: providersAwaitModelProviderAuthResponseSchema,
});

/** Cancels an in-flight OAuth attempt (best-effort, local). */
export const providersCancelModelProviderAuthV10 = defineRpcContract({
  method: "providers.cancelModelProviderAuth",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersCancelModelProviderAuthRequestSchema,
  responseSchema: providersCancelModelProviderAuthResponseSchema,
});

/**
 * Brand-new v1.0 method (not part of `RELEASED_FLOOR_METHOD_NAMES` - this whole code-paste surface is unreleased), registered below with `degrade: { kind: "unsupported" }`: an old host simply lacks it, and callers get.
 */
export const providersSubmitLoginCodeV10 = defineRpcContract({
  method: "providers.submitLoginCode",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersSubmitLoginCodeRequestSchema,
  responseSchema: providersSubmitLoginCodeResponseSchema,
});

/**
 * Brand-new v1.0 method, registered the same way as
 * `providers.submitLoginCode` above.
 */
export const providersTouchLoginV10 = defineRpcContract({
  method: "providers.touchLogin",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersTouchLoginRequestSchema,
  responseSchema: providersTouchLoginResponseSchema,
});

/**
 * Brand-new v1.0 method, registered the same way as `providers.submitLoginCode`/`touchLogin` above: outside `RELEASED_FLOOR_METHOD_NAMES` with `degrade: { kind: "unsupported" }`, because a new method NAME is.
 * The degrade arm covers the remaining sliver (a client that somehow calls anyway) with per-call upgrade guidance rather than a dead handshake.
 */
export const providersStartTerminalLoginV10 = defineRpcContract({
  method: "providers.startTerminalLogin",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersStartTerminalLoginRequestSchema,
  responseSchema: providersStartTerminalLoginResponseSchema,
});

/**
 * `terminal.create@2.0` - `scope` replaces the v1.0 request's `epicId` so a sign-in terminal can be minted in the landing page's independent scope.
 */
export const providersStartTerminalLoginV20 = defineRpcContract({
  method: "providers.startTerminalLogin",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: providersStartTerminalLoginRequestSchemaV20,
  responseSchema: providersStartTerminalLoginResponseSchema,
});

export const providersStartTerminalLoginUpgradeV10ToV20 = defineUpgradePath<
  typeof providersStartTerminalLoginV10,
  typeof providersStartTerminalLoginV20
>({
  from: providersStartTerminalLoginV10.schemaVersion,
  to: providersStartTerminalLoginV20.schemaVersion,
  upgradeRequest: (request) => {
    const { epicId, ...rest } = request;
    return { ...rest, scope: { kind: "epic", epicId } };
  },
  upgradeResponse: (response) => response,
});

export const providersStartTerminalLoginDowngradeV20ToV10 = defineDowngradePath<
  typeof providersStartTerminalLoginV20,
  typeof providersStartTerminalLoginV10
>({
  from: providersStartTerminalLoginV20.schemaVersion,
  to: providersStartTerminalLoginV10.schemaVersion,
  downgradeRequest: (request) => {
    const { scope, ...rest } = request;
    if (scope.kind === "independent") {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "Independent-scope sign-in terminals have no representation in providers.startTerminalLogin@1.0",
        },
      };
    }
    return { ok: true, value: { ...rest, epicId: scope.epicId } };
  },
  downgradeResponse: (response) => ({ ok: true, value: response }),
});

/**
 * Brand-new v1.0 method (outside `RELEASED_FLOOR_METHOD_NAMES` - a new method NAME is handshake-fatal against a released peer, so it rides the optional- capability channel with `degrade: { kind: "unsupported" }`, exactly.
 */
export const providersEnsurePackV10 = defineRpcContract({
  method: "providers.ensurePack",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersEnsurePackRequestSchema,
  responseSchema: providersEnsurePackResponseSchema,
});

export const providersSetEnabledV10 = defineRpcContract({
  method: "providers.setEnabled",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersSetEnabledRequestSchemaV10,
  responseSchema: providersSetEnabledResponseSchemaV10,
});

export const providersSetEnabledV20 = defineRpcContract({
  method: "providers.setEnabled",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: providersSetEnabledRequestSchemaV20,
  responseSchema: providersSetEnabledResponseSchemaV20,
});

export const providersSetEnabledUpgradeV1ToV2 = defineUpgradePath<
  typeof providersSetEnabledV10,
  typeof providersSetEnabledV20
>({
  from: { major: 1, minor: 0 },
  to: { major: 2, minor: 0 },
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    state: upgradeProviderStateFromV10(response.state),
  }),
});

// `worktree.listBindingsForEpic@1.1` - v2.1 adds `profileAction` (discriminated rename/remove/recolor of a profile) to the request - folded onto this existing "administer this provider's configuration" mutation instead.
export const providersSetEnabledV21 = defineRpcContract({
  method: "providers.setEnabled",
  schemaVersion: { major: 2, minor: 1 } as const,
  requestSchema: providersSetEnabledRequestSchemaV21,
  responseSchema: providersSetEnabledResponseSchema,
});

export const providersSetProfileEnabledV10 = defineRpcContract({
  method: "providers.setProfileEnabled",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersSetProfileEnabledRequestSchema,
  responseSchema: providersSetProfileEnabledResponseSchema,
});

export const providersSetEnabledUpgradeV20ToV21 = defineUpgradePath<
  typeof providersSetEnabledV20,
  typeof providersSetEnabledV21
>({
  from: { major: 2, minor: 0 },
  to: { major: 2, minor: 1 },
  upgradeRequest: (request) => ({
    ...request,
    profileAction: null,
  }),
  upgradeResponse: (response) => ({
    state: {
      ...response.state,
      profiles: [],
      loginCapability: upgradeLoginCapabilityFromV10(
        response.state.loginCapability,
      ),
    },
  }),
});

// Bridges from v2.1 (the latest installed version of major 2's line) down to the frozen v1.0 - not from v2.0, since v2.1 supersedes it as major 2's latest.
// Used directly by `provider-profiles-compat.test.ts` to assert `profileAction` never reaches a v1.0 caller; the registered `downgradePathsFromLatest` bridge is `providersSetEnabledDowngradeV21ToV10` below.
export const providersSetEnabledDowngradeV2ToV1 = defineDowngradePath<
  typeof providersSetEnabledV21,
  typeof providersSetEnabledV10
>({
  from: { major: 2, minor: 1 },
  to: { major: 1, minor: 0 },
  // Drop `profileAction` before the parse: `providersSetEnabledRequestSchemaV10` is a strict object that never learned it, so passing the full request through would fail the strict parse and drop the whole downgrade.
  downgradeRequest: (request) => {
    const { profileAction, ...legacyRequest } = request;
    return downgradeProviderRequestForV10(
      providersSetEnabledRequestSchemaV10,
      legacyRequest,
    );
  },
  downgradeResponse: (response) => {
    const state = downgradeProviderStateForV10(response.state);
    if (!state.ok) return state;
    return {
      ok: true,
      value: providersSetEnabledResponseSchemaV10.parse({
        state: state.value,
      }),
    };
  },
});

export const providersSetEnabledDowngradeV21ToV20 = defineDowngradePath<
  typeof providersSetEnabledV21,
  typeof providersSetEnabledV20
>({
  from: { major: 2, minor: 1 },
  to: { major: 2, minor: 0 },
  downgradeRequest: (request) => ({
    ok: true,
    value: providersSetEnabledRequestSchemaV20.parse({
      providerId: request.providerId,
      enabled: request.enabled,
    }),
  }),
  downgradeResponse: (response) => {
    const state = downgradeProviderCliStateToMutationV20(response.state);
    return {
      ok: true,
      value: providersSetEnabledResponseSchemaV20.parse({ state }),
    };
  },
});

export const providersSetEnabledDowngradeV21ToV10 = defineDowngradePath<
  typeof providersSetEnabledV21,
  typeof providersSetEnabledV10
>({
  from: { major: 2, minor: 1 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) =>
    downgradeProviderRequestForV10(providersSetEnabledRequestSchemaV10, {
      providerId: request.providerId,
      enabled: request.enabled,
    }),
  downgradeResponse: (response) => {
    const state = downgradeProviderStateForV10(response.state);
    if (!state.ok) return state;
    return {
      ok: true,
      value: providersSetEnabledResponseSchemaV10.parse({
        state: state.value,
      }),
    };
  },
});

// THERE IS NO `providers.setEnabled@2.2`.
// 2.1 is the head minor again, and `providersSetEnabledDowngradeV21ToV10` above is once more the registered bridge down to the frozen v1.0.

export const providersSetApiKeyV10 = defineRpcContract({
  method: "providers.setApiKey",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersSetApiKeyRequestSchemaV10,
  responseSchema: providersSetApiKeyResponseSchemaV10,
});

export const providersSetApiKeyV20 = defineRpcContract({
  method: "providers.setApiKey",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: providersSetApiKeyRequestSchema,
  responseSchema: providersSetApiKeyResponseSchemaV20,
});

export const providersSetApiKeyUpgradeV1ToV2 = defineUpgradePath<
  typeof providersSetApiKeyV10,
  typeof providersSetApiKeyV20
>({
  from: { major: 1, minor: 0 },
  to: { major: 2, minor: 0 },
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    state: upgradeProviderStateFromV10(response.state),
  }),
});

export const providersSetApiKeyV21 = defineRpcContract({
  method: "providers.setApiKey",
  schemaVersion: { major: 2, minor: 1 } as const,
  requestSchema: providersSetApiKeyRequestSchema,
  responseSchema: providersSetApiKeyResponseSchema,
});

export const providersSetApiKeyUpgradeV20ToV21 = defineUpgradePath<
  typeof providersSetApiKeyV20,
  typeof providersSetApiKeyV21
>({
  from: { major: 2, minor: 0 },
  to: { major: 2, minor: 1 },
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    state: {
      ...response.state,
      profiles: [],
      loginCapability: upgradeLoginCapabilityFromV10(
        response.state.loginCapability,
      ),
    },
  }),
});

export const providersSetApiKeyDowngradeV21ToV20 = defineDowngradePath<
  typeof providersSetApiKeyV21,
  typeof providersSetApiKeyV20
>({
  from: { major: 2, minor: 1 },
  to: { major: 2, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => {
    const state = downgradeProviderCliStateToMutationV20(response.state);
    return {
      ok: true,
      value: providersSetApiKeyResponseSchemaV20.parse({ state }),
    };
  },
});

export const providersSetApiKeyDowngradeV21ToV10 = defineDowngradePath<
  typeof providersSetApiKeyV21,
  typeof providersSetApiKeyV10
>({
  from: { major: 2, minor: 1 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) =>
    downgradeProviderRequestForV10(providersSetApiKeyRequestSchemaV10, request),
  downgradeResponse: (response) => {
    const state = downgradeProviderStateForV10(response.state);
    if (!state.ok) return state;
    return {
      ok: true,
      value: providersSetApiKeyResponseSchemaV10.parse({
        state: state.value,
      }),
    };
  },
});

export const providersClearApiKeyV10 = defineRpcContract({
  method: "providers.clearApiKey",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersClearApiKeyRequestSchemaV10,
  responseSchema: providersClearApiKeyResponseSchemaV10,
});

export const providersClearApiKeyV20 = defineRpcContract({
  method: "providers.clearApiKey",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: providersClearApiKeyRequestSchema,
  responseSchema: providersClearApiKeyResponseSchemaV20,
});

export const providersClearApiKeyUpgradeV1ToV2 = defineUpgradePath<
  typeof providersClearApiKeyV10,
  typeof providersClearApiKeyV20
>({
  from: { major: 1, minor: 0 },
  to: { major: 2, minor: 0 },
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    state: upgradeProviderStateFromV10(response.state),
  }),
});

export const providersClearApiKeyV21 = defineRpcContract({
  method: "providers.clearApiKey",
  schemaVersion: { major: 2, minor: 1 } as const,
  requestSchema: providersClearApiKeyRequestSchema,
  responseSchema: providersClearApiKeyResponseSchema,
});

export const providersClearApiKeyUpgradeV20ToV21 = defineUpgradePath<
  typeof providersClearApiKeyV20,
  typeof providersClearApiKeyV21
>({
  from: { major: 2, minor: 0 },
  to: { major: 2, minor: 1 },
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    state: {
      ...response.state,
      profiles: [],
      loginCapability: upgradeLoginCapabilityFromV10(
        response.state.loginCapability,
      ),
    },
  }),
});

export const providersClearApiKeyDowngradeV21ToV20 = defineDowngradePath<
  typeof providersClearApiKeyV21,
  typeof providersClearApiKeyV20
>({
  from: { major: 2, minor: 1 },
  to: { major: 2, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => {
    const state = downgradeProviderCliStateToMutationV20(response.state);
    return {
      ok: true,
      value: providersClearApiKeyResponseSchemaV20.parse({ state }),
    };
  },
});

export const providersClearApiKeyDowngradeV21ToV10 = defineDowngradePath<
  typeof providersClearApiKeyV21,
  typeof providersClearApiKeyV10
>({
  from: { major: 2, minor: 1 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) =>
    downgradeProviderRequestForV10(
      providersClearApiKeyRequestSchemaV10,
      request,
    ),
  downgradeResponse: (response) => {
    const state = downgradeProviderStateForV10(response.state);
    if (!state.ok) return state;
    return {
      ok: true,
      value: providersClearApiKeyResponseSchemaV10.parse({
        state: state.value,
      }),
    };
  },
});

export const providersSetTerminalAgentArgsV10 = defineRpcContract({
  method: "providers.setTerminalAgentArgs",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersSetTerminalAgentArgsRequestSchemaV10,
  responseSchema: providersSetTerminalAgentArgsResponseSchemaV10,
});

export const providersSetTerminalAgentArgsV20 = defineRpcContract({
  method: "providers.setTerminalAgentArgs",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: providersSetTerminalAgentArgsRequestSchema,
  responseSchema: providersSetTerminalAgentArgsResponseSchemaV20,
});

export const providersSetTerminalAgentArgsUpgradeV1ToV2 = defineUpgradePath<
  typeof providersSetTerminalAgentArgsV10,
  typeof providersSetTerminalAgentArgsV20
>({
  from: { major: 1, minor: 0 },
  to: { major: 2, minor: 0 },
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    state: upgradeProviderStateFromV10(response.state),
  }),
});

export const providersSetTerminalAgentArgsV21 = defineRpcContract({
  method: "providers.setTerminalAgentArgs",
  schemaVersion: { major: 2, minor: 1 } as const,
  requestSchema: providersSetTerminalAgentArgsRequestSchema,
  responseSchema: providersSetTerminalAgentArgsResponseSchema,
});

export const providersSetTerminalAgentArgsUpgradeV20ToV21 = defineUpgradePath<
  typeof providersSetTerminalAgentArgsV20,
  typeof providersSetTerminalAgentArgsV21
>({
  from: { major: 2, minor: 0 },
  to: { major: 2, minor: 1 },
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    state: {
      ...response.state,
      profiles: [],
      loginCapability: upgradeLoginCapabilityFromV10(
        response.state.loginCapability,
      ),
    },
  }),
});

export const providersSetTerminalAgentArgsDowngradeV21ToV20 =
  defineDowngradePath<
    typeof providersSetTerminalAgentArgsV21,
    typeof providersSetTerminalAgentArgsV20
  >({
    from: { major: 2, minor: 1 },
    to: { major: 2, minor: 0 },
    downgradeRequest: (request) => ({ ok: true, value: request }),
    downgradeResponse: (response) => {
      const state = downgradeProviderCliStateToMutationV20(response.state);
      return {
        ok: true,
        value: providersSetTerminalAgentArgsResponseSchemaV20.parse({ state }),
      };
    },
  });

export const providersSetTerminalAgentArgsDowngradeV21ToV10 =
  defineDowngradePath<
    typeof providersSetTerminalAgentArgsV21,
    typeof providersSetTerminalAgentArgsV10
  >({
    from: { major: 2, minor: 1 },
    to: { major: 1, minor: 0 },
    downgradeRequest: (request) =>
      downgradeProviderRequestForV10(
        providersSetTerminalAgentArgsRequestSchemaV10,
        request,
      ),
    downgradeResponse: (response) => {
      const state = downgradeProviderStateForV10(response.state);
      if (!state.ok) return state;
      return {
        ok: true,
        value: providersSetTerminalAgentArgsResponseSchemaV10.parse({
          state: state.value,
        }),
      };
    },
  });

export const providersSetEnvOverrideV10 = defineRpcContract({
  method: "providers.setEnvOverride",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersSetEnvOverrideRequestSchemaV10,
  responseSchema: providersSetEnvOverrideResponseSchemaV10,
});

export const providersSetEnvOverrideV20 = defineRpcContract({
  method: "providers.setEnvOverride",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: providersSetEnvOverrideRequestSchema,
  responseSchema: providersSetEnvOverrideResponseSchemaV20,
});

export const providersSetEnvOverrideUpgradeV1ToV2 = defineUpgradePath<
  typeof providersSetEnvOverrideV10,
  typeof providersSetEnvOverrideV20
>({
  from: { major: 1, minor: 0 },
  to: { major: 2, minor: 0 },
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    state: upgradeProviderStateFromV10(response.state),
  }),
});

export const providersSetEnvOverrideV21 = defineRpcContract({
  method: "providers.setEnvOverride",
  schemaVersion: { major: 2, minor: 1 } as const,
  requestSchema: providersSetEnvOverrideRequestSchema,
  responseSchema: providersSetEnvOverrideResponseSchema,
});

export const providersSetEnvOverrideUpgradeV20ToV21 = defineUpgradePath<
  typeof providersSetEnvOverrideV20,
  typeof providersSetEnvOverrideV21
>({
  from: { major: 2, minor: 0 },
  to: { major: 2, minor: 1 },
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    state: {
      ...response.state,
      profiles: [],
      loginCapability: upgradeLoginCapabilityFromV10(
        response.state.loginCapability,
      ),
    },
  }),
});

export const providersSetEnvOverrideDowngradeV21ToV20 = defineDowngradePath<
  typeof providersSetEnvOverrideV21,
  typeof providersSetEnvOverrideV20
>({
  from: { major: 2, minor: 1 },
  to: { major: 2, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => {
    const state = downgradeProviderCliStateToMutationV20(response.state);
    return {
      ok: true,
      value: providersSetEnvOverrideResponseSchemaV20.parse({ state }),
    };
  },
});

export const providersSetEnvOverrideDowngradeV21ToV10 = defineDowngradePath<
  typeof providersSetEnvOverrideV21,
  typeof providersSetEnvOverrideV10
>({
  from: { major: 2, minor: 1 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) =>
    downgradeProviderRequestForV10(
      providersSetEnvOverrideRequestSchemaV10,
      request,
    ),
  downgradeResponse: (response) => {
    const state = downgradeProviderStateForV10(response.state);
    if (!state.ok) return state;
    return {
      ok: true,
      value: providersSetEnvOverrideResponseSchemaV10.parse({
        state: state.value,
      }),
    };
  },
});

export const providersDeleteEnvOverrideV10 = defineRpcContract({
  method: "providers.deleteEnvOverride",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersDeleteEnvOverrideRequestSchemaV10,
  responseSchema: providersDeleteEnvOverrideResponseSchemaV10,
});

export const providersDeleteEnvOverrideV20 = defineRpcContract({
  method: "providers.deleteEnvOverride",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: providersDeleteEnvOverrideRequestSchema,
  responseSchema: providersDeleteEnvOverrideResponseSchemaV20,
});

export const providersDeleteEnvOverrideUpgradeV1ToV2 = defineUpgradePath<
  typeof providersDeleteEnvOverrideV10,
  typeof providersDeleteEnvOverrideV20
>({
  from: { major: 1, minor: 0 },
  to: { major: 2, minor: 0 },
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    state: upgradeProviderStateFromV10(response.state),
  }),
});

export const providersDeleteEnvOverrideV21 = defineRpcContract({
  method: "providers.deleteEnvOverride",
  schemaVersion: { major: 2, minor: 1 } as const,
  requestSchema: providersDeleteEnvOverrideRequestSchema,
  responseSchema: providersDeleteEnvOverrideResponseSchema,
});

export const providersDeleteEnvOverrideUpgradeV20ToV21 = defineUpgradePath<
  typeof providersDeleteEnvOverrideV20,
  typeof providersDeleteEnvOverrideV21
>({
  from: { major: 2, minor: 0 },
  to: { major: 2, minor: 1 },
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    state: {
      ...response.state,
      profiles: [],
      loginCapability: upgradeLoginCapabilityFromV10(
        response.state.loginCapability,
      ),
    },
  }),
});

export const providersDeleteEnvOverrideDowngradeV21ToV20 = defineDowngradePath<
  typeof providersDeleteEnvOverrideV21,
  typeof providersDeleteEnvOverrideV20
>({
  from: { major: 2, minor: 1 },
  to: { major: 2, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => {
    const state = downgradeProviderCliStateToMutationV20(response.state);
    return {
      ok: true,
      value: providersDeleteEnvOverrideResponseSchemaV20.parse({ state }),
    };
  },
});

export const providersDeleteEnvOverrideDowngradeV21ToV10 = defineDowngradePath<
  typeof providersDeleteEnvOverrideV21,
  typeof providersDeleteEnvOverrideV10
>({
  from: { major: 2, minor: 1 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) =>
    downgradeProviderRequestForV10(
      providersDeleteEnvOverrideRequestSchemaV10,
      request,
    ),
  downgradeResponse: (response) => {
    const state = downgradeProviderStateForV10(response.state);
    if (!state.ok) return state;
    return {
      ok: true,
      value: providersDeleteEnvOverrideResponseSchemaV10.parse({
        state: state.value,
      }),
    };
  },
});

export const worktreeListBindingsForEpicV10 = defineRpcContract({
  method: "worktree.listBindingsForEpic",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: worktreeListBindingsForEpicRequestSchema,
  responseSchema: worktreeListBindingsForEpicResponseSchema,
});

// v1.1 adds `folderlessCwd` - the host-owned fallback cwd for terminal launches on an epic with no bound workspace rows.
// Folded onto this existing method instead of a standalone `terminal.defaultCwd` so the wire method-set stays identical to v1.0.0 - a new method name fatally fails the equal-set handshake against an already-shipped host.
export const worktreeListBindingsForEpicV11 = defineRpcContract({
  method: "worktree.listBindingsForEpic",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: worktreeListBindingsForEpicRequestSchema,
  responseSchema: worktreeListBindingsForEpicResponseSchemaV11,
});

export const worktreeListBindingsForEpicUpgradeV10ToV11 = defineUpgradePath<
  typeof worktreeListBindingsForEpicV10,
  typeof worktreeListBindingsForEpicV11
>({
  from: worktreeListBindingsForEpicV10.schemaVersion,
  to: worktreeListBindingsForEpicV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    rows: response.rows,
    folderlessCwd: null,
  }),
});

export const worktreeListBindingsForEpicV12 = defineRpcContract({
  method: "worktree.listBindingsForEpic",
  schemaVersion: { major: 1, minor: 2 } as const,
  requestSchema: worktreeListBindingsForEpicRequestSchema,
  responseSchema: worktreeListBindingsForEpicResponseSchemaV12,
});

// Additive upgrade from v1.1: a v1.1 host has no pending concept and never emits a signal that would later clear it, so every bridged row is stamped `isGitResolvePending: false` - the old host's answer is authoritative.
// Bridging to `true` would strand every correctly-resolved old-host row in a pending state that never converges against a v1.1 host.
export const worktreeListBindingsForEpicUpgradeV11ToV12 = defineUpgradePath<
  typeof worktreeListBindingsForEpicV11,
  typeof worktreeListBindingsForEpicV12
>({
  from: worktreeListBindingsForEpicV11.schemaVersion,
  to: worktreeListBindingsForEpicV12.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    ...response,
    rows: response.rows.map((row) => ({
      ...row,
      isGitResolvePending: false,
    })),
  }),
});

// Note: git contract definitions are imported from git-contracts.ts above
// and registered inline in hostRpcRegistry and hostStreamRpcRegistry below.

export const workspacePrepareFoldersUpgradeV10ToV11 = defineUpgradePath<
  typeof workspacePrepareFoldersV10,
  typeof workspacePrepareFoldersV11
>({
  from: workspacePrepareFoldersV10.schemaVersion,
  to: workspacePrepareFoldersV11.schemaVersion,
  upgradeRequest: (request) => ({
    operation: "prepare",
    folderPaths: request.folderPaths,
    path: null,
  }),
  upgradeResponse: (response) => ({
    operation: "prepare",
    folders: response.folders,
    repoIdentifiers: response.repoIdentifiers,
    homeDir: null,
    validation: null,
    recentWorkspaces: null,
  }),
});

export const workspacePrepareFoldersUpgradeV11ToV12 = defineUpgradePath<
  typeof workspacePrepareFoldersV11,
  typeof workspacePrepareFoldersV12
>({
  from: workspacePrepareFoldersV11.schemaVersion,
  to: workspacePrepareFoldersV12.schemaVersion,
  upgradeRequest: (request) => ({
    ...request,
    bumpRecency: request.operation === "recordRecentWorkspace" ? true : null,
  }),
  upgradeResponse: (response) => response,
});

export const workspacePrepareFoldersUpgradeV12ToV13 = defineUpgradePath<
  typeof workspacePrepareFoldersV12,
  typeof workspacePrepareFoldersV13
>({
  from: workspacePrepareFoldersV12.schemaVersion,
  to: workspacePrepareFoldersV13.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const workspacePrepareFoldersUpgradeV13ToV14 = defineUpgradePath<
  typeof workspacePrepareFoldersV13,
  typeof workspacePrepareFoldersV14
>({
  from: workspacePrepareFoldersV13.schemaVersion,
  to: workspacePrepareFoldersV14.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const workspaceBrowseFoldersUpgradeV10ToV11 = defineUpgradePath<
  typeof workspaceBrowseFoldersV10,
  typeof workspaceBrowseFoldersV11
>({
  from: workspaceBrowseFoldersV10.schemaVersion,
  to: workspaceBrowseFoldersV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    ...response,
    entries: response.entries.map((entry) => ({
      ...entry,
      hidden: entry.name.startsWith("."),
    })),
  }),
});

// Additive upgrade from v1.0: a peer on the frozen v1.0 line predates fork provenance entirely, so its creates carry no fork source.
export const epicCreateTuiAgentUpgradeV10ToV11 = defineUpgradePath<
  typeof epicCreateTuiAgentV10,
  typeof epicCreateTuiAgentV11
>({
  from: epicCreateTuiAgentV10.schemaVersion,
  to: epicCreateTuiAgentV11.schemaVersion,
  upgradeRequest: (request) => ({
    ...request,
    forkSourceHarnessSessionId: null,
  }),
  upgradeResponse: (response) => response,
});

const HOST_RPC_REGISTRY_BASE_DEFINITION = {
  "browser.savedLoginSites": {
    // Settings > Browser's "Sites with saved logins" list (keychain refactor ticket 10).
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: browserSavedLoginSitesV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  // Machine-user-global config store capabilities.
  "config.shell.get": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: configShellGetV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "config.shell.set": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: configShellSetV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "config.shell.reset": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: configShellResetV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "config.shell.add": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: configShellAddV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "config.shell.remove": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: configShellRemoveV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "config.shell.revertArgs": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: configShellRevertArgsV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "config.shell.listDetected": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: configShellListDetectedV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: configShellListDetectedV11,
          upgradeFromPreviousVersion: configShellListDetectedUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "config.shell.probe": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: configShellProbeV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "config.env.list": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: configEnvListV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "config.env.set": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: configEnvSetV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "config.env.delete": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: configEnvDeleteV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "config.logLevels.get": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: configLogLevelsGetV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "config.logLevels.set": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: configLogLevelsSetV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "diagnostics.logs.list": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: diagnosticsLogsListV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "diagnostics.logs.tail": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: diagnosticsLogsTailV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.status": {
    1: {
      latestMinor: 3,
      versions: {
        0: {
          contract: hostStatusV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: hostStatusV11,
          upgradeFromPreviousVersion: hostStatusUpgradeV10ToV11,
        },
        2: {
          contract: hostStatusV12,
          upgradeFromPreviousVersion: hostStatusUpgradeV11ToV12,
        },
        3: {
          contract: hostStatusV13,
          upgradeFromPreviousVersion: hostStatusUpgradeV12ToV13,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.restart": {
    // Restart authority is meaningful only on hosts that can atomically close work admission before testing drain state; older hosts must not emulate it with a racy activity read.
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 2,
      versions: {
        0: {
          contract: hostRestartV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: hostRestartV11,
          upgradeFromPreviousVersion: hostRestartUpgradeV10ToV11,
        },
        2: {
          contract: hostRestartV12,
          upgradeFromPreviousVersion: hostRestartUpgradeV11ToV12,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.identity.get": {
    // The host is the master copy of its own name.
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostIdentityGetV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.identity.set": {
    // Renaming over RPC requires the host-side writer; on an older host the
    // desktop's direct-file path is the only writer, and it is local-only.
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostIdentitySetV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.doctor": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostDoctorV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  // v1.1 adds the tri-state catalog override and the resolved-inclusion + provenance the Settings copy reads.
  "host.update.check": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: hostUpdateCheckV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: hostUpdateCheckV11,
          upgradeFromPreviousVersion: hostUpdateCheckUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.update.install": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 2,
      versions: {
        0: {
          contract: hostUpdateInstallV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: hostUpdateInstallV11,
          upgradeFromPreviousVersion: hostUpdateInstallUpgradeV10ToV11,
          // The `dispatch-indeterminate` arm is response VALUE growth: a `@1.0` peer parses with its own schema, and a discriminated union refuses an unknown discriminator outright rather than ignoring it.
          // So the arm is only safe if the host never sends it to such a peer, and this annotation is the reviewed claim that it does not.
          responseGrowthProjectionGated: true,
        },
        2: {
          contract: hostUpdateInstallV12,
          upgradeFromPreviousVersion: hostUpdateInstallUpgradeV11ToV12,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.getInstallationInfo": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: hostGetInstallationInfoV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: hostGetInstallationInfoV11,
          upgradeFromPreviousVersion: hostGetInstallationInfoUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  // The three OS-service methods: brand-new v1.0, outside `RELEASED_FLOOR_METHOD_NAMES`, `unsupported` degrade.
  // A host that predates them simply lacks them and the client hides the OS service section on the handshake answer rather than offering buttons that cannot land.
  "host.service.status": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostServiceStatusV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.service.register": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostServiceRegisterV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.service.deregister": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostServiceDeregisterV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.usage.summary": {
    // Brand-new v1.0 method (not part of `RELEASED_FLOOR_METHOD_NAMES` - this whole usage-summary surface is unreleased), registered like `snapshots.getLocalStorageSize` above: an old host simply lacks it, and the client.
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostUsageSummaryV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "lifecycle.claimShutdown": {
    // Hosts predating the lifecycle layer cannot safely emulate a shutdown
    // claim, so reconciliation must re-probe and use its legacy-safe path.
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: lifecycleClaimShutdownV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: lifecycleClaimShutdownV11,
          upgradeFromPreviousVersion: lifecycleClaimShutdownUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "lifecycle.commitShutdown": {
    // A commit token has authority only on the host that granted it; there is
    // no meaningful fallback on an older host.
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: lifecycleCommitShutdownV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "lifecycle.releaseShutdown": {
    // Release authority is meaningful only to the host that minted the token;
    // an older host cannot emulate this recovery arm safely.
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: lifecycleReleaseShutdownV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.getRuntimeCapabilities": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostGetRuntimeCapabilitiesV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.getRateLimitUsage": {
    1: {
      latestMinor: 2,
      versions: {
        0: {
          contract: hostGetRateLimitUsageV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: hostGetRateLimitUsageV11,
          upgradeFromPreviousVersion: hostGetRateLimitUsageUpgradeV10ToV11,
        },
        2: {
          contract: hostGetRateLimitUsageV12,
          upgradeFromPreviousVersion: hostGetRateLimitUsageUpgradeV11ToV12,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 1,
      versions: {
        0: {
          contract: hostGetRateLimitUsageV20,
          upgradeFromPreviousVersion: hostGetRateLimitUsageUpgradeV12ToV20,
        },
        1: {
          contract: hostGetRateLimitUsageV21,
          upgradeFromPreviousVersion: hostGetRateLimitUsageUpgradeV20ToV21,
        },
      },
      downgradePathsFromLatest: { 1: hostGetRateLimitUsageDowngradeV2ToV1 },
    },
    3: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostGetRateLimitUsageV30,
          upgradeFromPreviousVersion: hostGetRateLimitUsageUpgradeV21ToV30,
        },
      },
      downgradePathsFromLatest: {
        2: hostGetRateLimitUsageDowngradeV3ToV2,
        1: hostGetRateLimitUsageDowngradeV3ToV1,
      },
    },
    4: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostGetRateLimitUsageV40,
          upgradeFromPreviousVersion: hostGetRateLimitUsageUpgradeV30ToV40,
        },
      },
      downgradePathsFromLatest: {
        1: hostGetRateLimitUsageDowngradeV4ToV1,
        2: hostGetRateLimitUsageDowngradeV4ToV2,
        3: hostGetRateLimitUsageDowngradeV4ToV3,
      },
    },
  },
  "providers.consumeRateLimitResetCredit": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersConsumeRateLimitResetCreditV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.refreshProfileStatus": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersRefreshProfileStatusV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.notifications.list": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostNotificationsListV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 2,
      versions: {
        0: {
          contract: hostNotificationsListV20,
          upgradeFromPreviousVersion: hostNotificationsListUpgradeV10ToV20,
        },
        1: {
          contract: hostNotificationsListV21,
          upgradeFromPreviousVersion: hostNotificationsListUpgradeV20ToV21,
          // The `host.operation.finished` arm added in 2.1 is emission-gated by design: the resolver derives arm inclusion from the version the caller negotiated, and the entry union's own contract (host-notifications.ts) mandates.
          responseGrowthProjectionGated: true,
        },
        // 2.2 adds `browser.human.needed` under the same projection gate. It is
        // a new minor rather than a widening of 2.1 because 2.1 has shipped.
        2: {
          contract: hostNotificationsListV22,
          upgradeFromPreviousVersion: hostNotificationsListUpgradeV21ToV22,
          responseGrowthProjectionGated: true,
        },
      },
      downgradePathsFromLatest: {
        1: hostNotificationsListDowngradeV22ToV10,
      },
    },
  },
  "host.notificationHooks.status": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostNotificationHooksStatus,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.notificationHooks.test": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostNotificationHooksTest,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.notificationHooks.save": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostNotificationHooksSave,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.notifications.getConfig": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostNotificationsGetConfig,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.notifications.setConfig": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostNotificationsSetConfig,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.notifications.markRead": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostNotificationsMarkRead,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.notifications.resolve": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostNotificationsResolve,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.notifications.markAllRead": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostNotificationsMarkAllRead,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.notifications.clearAll": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostNotificationsClearAll,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.notifications.cloudFeed.markRead": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostNotificationsCloudFeedMarkRead,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.notifications.cloudFeed.resolve": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostNotificationsCloudFeedResolve,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.notifications.cloudFeed.markAllRead": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostNotificationsCloudFeedMarkAllRead,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.notifications.cloudFeed.clear": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostNotificationsCloudFeedClear,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.notifications.cloudFeed.clearAll": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostNotificationsCloudFeedClearAll,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.notifications.indicatorState": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: hostNotificationsIndicatorStateV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: hostNotificationsIndicatorState,
          upgradeFromPreviousVersion:
            hostNotificationsIndicatorStateUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "comments.listThreads": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: commentsListThreadsV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "comments.setThreadStatus": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: commentsSetThreadStatusV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "snapshots.getLocalStorageSize": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: snapshotsGetLocalStorageSizeV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "snapshots.readSnapshotDiff": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: snapshotsReadSnapshotDiffV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "snapshots.clearLocalSnapshots": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: snapshotsClearLocalSnapshotsV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.chatFork.get": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: chatForkGetV10, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
  // The contents behind an accumulated-change summary on the windowed `chat.subscribe` line, which ships summaries and leaves the file bodies to be fetched on demand.
  // A unary method flips no negotiation - a client that never calls it cannot tell it exists.
  "chat.readAccumulatedFileChange": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: chatReadAccumulatedFileChangeV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  // Where a cross-tile jump target sits, for the two target kinds a client identifies by walking rendered models - which a COLD row does not have.
  "chat.locateRow": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: chatLocateRowV10, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
  "agent.gui.listHarnesses": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentGuiListHarnessesV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 1,
      versions: {
        0: {
          contract: agentGuiListHarnessesV20,
          upgradeFromPreviousVersion: agentGuiListHarnessesUpgradeV1ToV2,
        },
        1: {
          contract: agentGuiListHarnessesV21,
          upgradeFromPreviousVersion: agentGuiListHarnessesUpgradeV20ToV21,
        },
      },
      downgradePathsFromLatest: { 1: agentGuiListHarnessesDowngradeV2ToV1 },
    },
    3: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentGuiListHarnessesV30,
          upgradeFromPreviousVersion: agentGuiListHarnessesUpgradeV2ToV3,
        },
      },
      downgradePathsFromLatest: {
        1: agentGuiListHarnessesDowngradeV3ToV1,
        2: agentGuiListHarnessesDowngradeV3ToV2,
      },
    },
    4: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentGuiListHarnessesV40,
          upgradeFromPreviousVersion: agentGuiListHarnessesUpgradeV3ToV4,
        },
      },
      downgradePathsFromLatest: {
        1: agentGuiListHarnessesDowngradeV4ToV1,
        2: agentGuiListHarnessesDowngradeV4ToV2,
        3: agentGuiListHarnessesDowngradeV4ToV3,
      },
    },
    5: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentGuiListHarnessesV50,
          upgradeFromPreviousVersion: agentGuiListHarnessesUpgradeV4ToV5,
        },
      },
      downgradePathsFromLatest: {
        1: agentGuiListHarnessesDowngradeV5ToV1,
        2: agentGuiListHarnessesDowngradeV5ToV2,
        3: agentGuiListHarnessesDowngradeV5ToV3,
        4: agentGuiListHarnessesDowngradeV5ToV4,
      },
    },
    6: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentGuiListHarnessesV60,
          upgradeFromPreviousVersion: agentGuiListHarnessesUpgradeV5ToV6,
        },
      },
      downgradePathsFromLatest: {
        1: agentGuiListHarnessesDowngradeV6ToV1,
        2: agentGuiListHarnessesDowngradeV6ToV2,
        3: agentGuiListHarnessesDowngradeV6ToV3,
        4: agentGuiListHarnessesDowngradeV6ToV4,
        5: agentGuiListHarnessesDowngradeV6ToV5,
      },
    },
    7: {
      latestMinor: 1,
      versions: {
        0: {
          contract: agentGuiListHarnessesV70,
          upgradeFromPreviousVersion: agentGuiListHarnessesUpgradeV6ToV7,
        },
        1: {
          contract: agentGuiListHarnessesV71,
          upgradeFromPreviousVersion: agentGuiListHarnessesUpgradeV70ToV71,
        },
      },
      downgradePathsFromLatest: {
        1: agentGuiListHarnessesDowngradeV7ToV1,
        2: agentGuiListHarnessesDowngradeV7ToV2,
        3: agentGuiListHarnessesDowngradeV7ToV3,
        4: agentGuiListHarnessesDowngradeV7ToV4,
        5: agentGuiListHarnessesDowngradeV7ToV5,
        6: agentGuiListHarnessesDowngradeV7ToV6,
      },
    },
    8: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentGuiListHarnessesV80,
          upgradeFromPreviousVersion: agentGuiListHarnessesUpgradeV71ToV80,
        },
      },
      downgradePathsFromLatest: {
        1: agentGuiListHarnessesDowngradeV8ToV1,
        2: agentGuiListHarnessesDowngradeV8ToV2,
        3: agentGuiListHarnessesDowngradeV8ToV3,
        4: agentGuiListHarnessesDowngradeV8ToV4,
        5: agentGuiListHarnessesDowngradeV8ToV5,
        6: agentGuiListHarnessesDowngradeV8ToV6,
        7: agentGuiListHarnessesDowngradeV8ToV7,
      },
    },
  },
  "agent.gui.listModels": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentGuiListModelsV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "agent.gui.listCommands": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentGuiListCommandsV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "agent.gui.getPlan": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentGuiGetPlanV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "agent.tui.listHarnesses": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentTuiListHarnessesV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "agent.tui.prepareLaunch": {
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: agentTuiPrepareLaunchV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: agentTuiPrepareLaunchV11,
          upgradeFromPreviousVersion: agentTuiPrepareLaunchUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  // Optional (non-floor) capability: read-only cross-profile fork-admission preflight (tech plan governing mechanism 2).
  // The `degrade: unsupported` strategy EXCLUDES it from the released floor and the released-method- names snapshot - adding it to the floor would be handshake-fatal for existing clients.
  "agent.tui.validateForkProfile": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentTuiValidateForkProfileV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  "agent.tui.generateTitle": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentTuiGenerateTitleV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "agent.tui.turnEnded": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentTuiTurnEndedV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "agent.tui.recordActivity": {
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: agentTuiRecordActivityV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: agentTuiRecordActivityV11,
          upgradeFromPreviousVersion: agentTuiRecordActivityUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  // Optional (non-floor) capability: the `UserPromptSubmit` hook's combined activity-edge + roles-digest-pull call (roles-snapshot-delivery pull point 1).
  // The `degrade: unsupported` strategy EXCLUDES it from the released floor and the released-method-names snapshot - adding it to the floor would be handshake-fatal for existing clients.
  "agent.tui.promptSubmitted": {
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: agentTuiPromptSubmittedV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: agentTuiPromptSubmittedV11,
          upgradeFromPreviousVersion: agentTuiPromptSubmittedUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  "agent.create": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentCreateV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentCreateV20,
          upgradeFromPreviousVersion: agentCreateUpgradeV10ToV20,
        },
      },
      downgradePathsFromLatest: { 1: agentCreateDowngradeV20ToV10 },
    },
    3: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentCreateV30,
          upgradeFromPreviousVersion: agentCreateUpgradeV20ToV30,
        },
      },
      downgradePathsFromLatest: {
        1: agentCreateDowngradeV30ToV10,
        2: agentCreateDowngradeV30ToV20,
      },
    },
  },
  "agent.selectionGuide": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentSelectionGuideV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "agent.selectionGuide.getGlobal": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentSelectionGuideGlobalGetV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "agent.selectionGuide.getGlobalOnboardingDraft": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentSelectionGuideGlobalOnboardingDraftGetV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "agent.selectionGuide.setGlobal": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentSelectionGuideGlobalSetV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "agent.selectionGuide.resetGlobalToDefault": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentSelectionGuideGlobalResetV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "agent.listHarnessModels": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentListHarnessModelsV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentListHarnessModelsV20,
          upgradeFromPreviousVersion: agentListHarnessModelsUpgradeV1ToV2,
        },
      },
      downgradePathsFromLatest: {
        1: agentListHarnessModelsDowngradeV2ToV1,
      },
    },
  },
  "agent.list": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentListV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentListV20,
          upgradeFromPreviousVersion: agentListUpgradeV1ToV2,
        },
      },
      downgradePathsFromLatest: { 1: agentListDowngradeV2ToV1 },
    },
    3: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentListV30,
          upgradeFromPreviousVersion: agentListUpgradeV2ToV3,
        },
      },
      downgradePathsFromLatest: {
        1: agentListDowngradeV3ToV1,
        2: agentListDowngradeV3ToV2,
      },
    },
    4: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentListV40,
          upgradeFromPreviousVersion: agentListUpgradeV3ToV4,
        },
      },
      downgradePathsFromLatest: {
        1: agentListDowngradeV4ToV1,
        2: agentListDowngradeV4ToV2,
        3: agentListDowngradeV4ToV3,
      },
    },
    5: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentListV50,
          upgradeFromPreviousVersion: agentListUpgradeV4ToV5,
        },
      },
      downgradePathsFromLatest: {
        1: agentListDowngradeV5ToV1,
        2: agentListDowngradeV5ToV2,
        3: agentListDowngradeV5ToV3,
        4: agentListDowngradeV5ToV4,
      },
    },
    6: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentListV60,
          upgradeFromPreviousVersion: agentListUpgradeV5ToV6,
        },
      },
      downgradePathsFromLatest: {
        1: agentListDowngradeV6ToV1,
        2: agentListDowngradeV6ToV2,
        3: agentListDowngradeV6ToV3,
        4: agentListDowngradeV6ToV4,
        5: agentListDowngradeV6ToV5,
      },
    },
    7: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentListV70,
          upgradeFromPreviousVersion: agentListUpgradeV6ToV7,
        },
      },
      downgradePathsFromLatest: {
        1: agentListDowngradeV7ToV1,
        2: agentListDowngradeV7ToV2,
        3: agentListDowngradeV7ToV3,
        4: agentListDowngradeV7ToV4,
        5: agentListDowngradeV7ToV5,
        6: agentListDowngradeV7ToV6,
      },
    },
    8: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentListV80,
          upgradeFromPreviousVersion: agentListUpgradeV7ToV8,
        },
      },
      downgradePathsFromLatest: {
        1: agentListDowngradeV8ToV1,
        2: agentListDowngradeV8ToV2,
        3: agentListDowngradeV8ToV3,
        4: agentListDowngradeV8ToV4,
        5: agentListDowngradeV8ToV5,
        6: agentListDowngradeV8ToV6,
        7: agentListDowngradeV8ToV7,
      },
    },
  },
  "agent.sendMessage": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentSendMessageV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "agent.getTranscript": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentGetTranscriptV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  // Agent role claims.
  // Registered here in the SAME change that adds the resolvers - advertising a method the host cannot dispatch is exactly how `agent.tui.listHarnesses` shipped broken.
  "agent.roles.claim": {
    1: {
      // @1.1 adds `deferredToPrompt` on the awareness report. @1.0 stays installed and FROZEN; a negotiated v1.0 peer gets deferred ids folded into `unreachable` at host dispatch after canonical v1.1 validation (not via a.
      latestMinor: 1,
      versions: {
        0: {
          contract: agentRolesClaimV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: agentRolesClaimV11,
          upgradeFromPreviousVersion: agentRolesClaimUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  "agent.roles.list": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentRolesListV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  "agent.roles.relinquish": {
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: agentRolesRelinquishV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: agentRolesRelinquishV11,
          upgradeFromPreviousVersion: agentRolesRelinquishUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  "agent.inbox.read": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentInboxReadV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentInboxReadV20,
          upgradeFromPreviousVersion: agentInboxReadUpgradeV10ToV20,
        },
      },
      downgradePathsFromLatest: { 1: agentInboxReadDowngradeV20ToV10 },
    },
  },
  "agent.inbox.ack": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentInboxAckV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  "agent.stop": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentStopV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  // Brand-new v1.0 method on the same `degrade: unsupported` channel as `terminal.readOutput` above: a host predating the wrapper fork RPC simply lacks it, so a caller (the CLI) gets per-call upgrade guidance instead of a.
  "agent.fork": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentForkV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "phase.migrateToEpic": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: phaseMigrateToEpicV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.listTasks": {
    1: {
      latestMinor: 3,
      versions: {
        0: {
          contract: epicListTasksV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: epicListTasksV11,
          upgradeFromPreviousVersion: epicListTasksUpgradeV10ToV11,
        },
        2: {
          contract: epicListTasksV12,
          upgradeFromPreviousVersion: epicListTasksUpgradeV11ToV12,
        },
        3: {
          contract: epicListTasksV13,
          upgradeFromPreviousVersion: epicListTasksUpgradeV12ToV13,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.setPinned": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicSetPinnedV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  "epic.recordViewed": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicRecordViewedV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  // Optional (non-floor): batch task-context by id for title resolution.
  "epic.getTaskContexts": {
    1: {
      // @1.1's new row-union values are projection-gated in host dispatch:
      // a v1.0 caller receives its released nullable rows, never a union arm.
      latestMinor: 2,
      versions: {
        0: {
          contract: epicGetTaskContextsV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: epicGetTaskContextsV11,
          upgradeFromPreviousVersion: epicGetTaskContextsUpgradeV10ToV11,
          responseGrowthProjectionGated: true,
        },
        2: {
          contract: epicGetTaskContextsV12,
          upgradeFromPreviousVersion: epicGetTaskContextsUpgradeV11ToV12,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  "epic.create": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicCreateV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.batchDelete": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicBatchDeleteV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "workspace.prepareFolders": {
    1: {
      latestMinor: 4,
      versions: {
        0: {
          contract: workspacePrepareFoldersV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: workspacePrepareFoldersV11,
          upgradeFromPreviousVersion: workspacePrepareFoldersUpgradeV10ToV11,
        },
        2: {
          contract: workspacePrepareFoldersV12,
          upgradeFromPreviousVersion: workspacePrepareFoldersUpgradeV11ToV12,
          responseGrowthProjectionGated: true,
        },
        3: {
          contract: workspacePrepareFoldersV13,
          upgradeFromPreviousVersion: workspacePrepareFoldersUpgradeV12ToV13,
          responseGrowthProjectionGated: true,
        },
        4: {
          contract: workspacePrepareFoldersV14,
          upgradeFromPreviousVersion: workspacePrepareFoldersUpgradeV13ToV14,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "workspace.listFileTree": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: workspaceListFileTreeV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "workspace.listDirectory": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: workspaceListDirectoryV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  // Additive, post-v1.0.0 optional method: pre-workspace folder browsing for the remote folder picker.
  // It rides the optional-capability channel (`degrade: unsupported`) and stays out of the released floor / baseline surface.
  "workspace.browseFolders": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: workspaceBrowseFoldersV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: workspaceBrowseFoldersV11,
          upgradeFromPreviousVersion: workspaceBrowseFoldersUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "workspace.readFile": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: workspaceReadFileV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  // Additive, post-v1.0.0 optional method: a host that predates it simply lacks it and the renderer falls back to its local file-tree filter, so it rides the optional-capability channel (`degrade: unsupported`) and stays.
  "workspace.searchPaths": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: workspaceSearchPathsV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  // Additive, post-v1.0.0 optional method: scoped code TEXT search.
  // A host that predates it simply lacks it and the renderer disables the text-search flow, so it rides the optional-capability channel (`degrade: unsupported`) and stays out of the released floor / baseline surface.
  "workspace.searchText": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: workspaceSearchTextV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "workspace.mentionFiles": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: workspaceMentionFilesV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "workspace.mentionFolders": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: workspaceMentionFoldersV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "workspace.mentionWorktrees": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: workspaceMentionWorktreesV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "workspace.mentionGitRoot": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: workspaceMentionGitRootV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "workspace.mentionGitBranches": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: workspaceMentionGitBranchesV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "workspace.mentionGitCommits": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: workspaceMentionGitCommitsV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "workspace.resolvePathsByRepoIdentifiers": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: workspaceResolvePathsByRepoIdentifiersV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.removeRepo": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicRemoveRepoV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.mentionEpics": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicMentionEpicsV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.mentionSpecs": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicMentionSpecsV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.mentionTickets": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicMentionTicketsV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.mentionStories": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicMentionStoriesV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.mentionReviews": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicMentionReviewsV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.listCollaborators": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicListCollaboratorsV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.createArtifact": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicCreateArtifactV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.deleteArtifact": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicDeleteArtifactV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.updateArtifactStatus": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicUpdateArtifactStatusV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.renameArtifact": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicRenameArtifactV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.reparentArtifact": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicReparentArtifactV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.createChat": {
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: epicCreateChatV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: epicCreateChatV11,
          upgradeFromPreviousVersion: epicCreateChatUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.renameChat": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicRenameChatV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  // Optional (non-floor) capability: settings-only chat update, no send.
  "epic.updateChatRunSettings": {
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: epicUpdateChatRunSettingsV10,
          upgradeFromPreviousVersion: null,
        },
        // v1.1: wire-strict settings tuple - a subset-field patch fails validation at the canonical minor instead of silently null- clobbering omitted fields.
        1: {
          contract: epicUpdateChatRunSettingsV11,
          upgradeFromPreviousVersion: epicUpdateChatRunSettingsUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
} as const;

// The tail of the base literal, cut out for one reason only: `.d.ts` emission.
// The `_NoOverlappingHostRpcMethods` assertion below is what keeps a method from silently existing in more than one of them.
const HOST_RPC_REGISTRY_BASE_TAIL_DEFINITION = {
  // Optional (non-floor) capability: narrow profile-only update of a chat's persisted run settings - the host patches its own authoritative tuple, so clients never rebuild (and stale-patch) the full tuple to move a chat's.
  "epic.updateChatProfile": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicUpdateChatProfileV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  // Optional (non-floor) capability: the only way to ask whether a session import is in flight without subscribing to `sessionImport.run` and thereby attaching to (or starting) one.
  // `unsupported` degrade because a host that predates session import cannot be running an import, and the surface that reads this is hidden anyway when the stream methods are missing.
  "sessionImport.status": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: sessionImportStatusV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.deleteChat": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicDeleteChatV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.reparentChat": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicReparentChatV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  // Optional (non-floor) capability: on-demand publication coverage for a chat this host OWNS, so the fork dialog can tell a user BEFORE they fork that a cross-host target could not read the transcript.
  "epic.chatPublicationState": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicChatPublicationStateV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  // Optional (non-floor) capability: durable host-backed archive toggle for a chat OR terminal-agent record (single method keyed by id).
  // The `degrade: unsupported` strategy EXCLUDES it from the released floor and the released-method-names snapshot - adding it to the floor would be handshake-fatal for existing clients.
  "epic.setChatArchived": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicSetChatArchivedV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  "epic.prepareArtifactImage": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicPrepareArtifactImageV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  "epic.finishArtifactImage": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicFinishArtifactImageV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  "epic.createTuiAgent": {
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: epicCreateTuiAgentV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: epicCreateTuiAgentV11,
          upgradeFromPreviousVersion: epicCreateTuiAgentUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.deleteTuiAgent": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicDeleteTuiAgentV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.renameTuiAgent": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicRenameTuiAgentV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.updateTitle": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicUpdateTitleV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.grantAccess": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicGrantAccessV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.batchUpdateRoles": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicBatchUpdateRolesV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.revokeCollaborator": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicRevokeCollaboratorV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.createCommentThread": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicCreateCommentThreadV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.replyToCommentThread": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicReplyToCommentThreadV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.editComment": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicEditCommentV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.deleteComment": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicDeleteCommentV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.setCommentThreadResolved": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicSetCommentThreadResolvedV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.deleteCommentThread": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicDeleteCommentThreadV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.listCommentThreads": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicListCommentThreadsV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic.resolveArtifactByPath": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicResolveArtifactByPathV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  // Optional (non-floor) capability: Epic-scoped artifact search.
  "epic.searchArtifacts": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicSearchArtifactsV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  // Optional (non-floor) cloud-chat READ surface: the host is a byte pipe and the client does every interpretation.
  "epic.listCloudChats": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicListCloudChatsV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  "epic.resolveCloudChatHead": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicResolveCloudChatHeadV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  "epic.readCloudChatPart": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicReadCloudChatPartV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  "epic.listCloudChatPayloads": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicListCloudChatPayloadsV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  "epic.readCloudChatPayload": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicReadCloudChatPayloadV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  // Visibility mutations.
  // Same optional-channel / hide-the-affordance rule as the five reads above (new names, so they must not enter the released floor).
  "epic.setCloudChatVisibility": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicSetCloudChatVisibilityV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  "epic.setChatSharingDefault": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicSetChatSharingDefaultV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  "epic.listChatPublicationTargets": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicListChatPublicationTargetsV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  // Optional local observability.
  "epic.chatBackupStatus": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicChatBackupStatusV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  // Doc-replica fallback for the unreachable-owner view (chat-sync-v2 ticket 34A).
  "epic.chatReplicaRead": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicChatReplicaReadV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  // The store-backed chat RECORD channel (chat-sync-v2 ticket 49).
  "epic.listChatRecords": {
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: epicListChatRecordsV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: epicListChatRecordsV11,
          upgradeFromPreviousVersion: epicListChatRecordsUpgradeV10ToV11,
          // The chat half of the doc-remainder union, and deliberately the SAME registry shape as `epic.listTuiAgents@1.1` - including what it does NOT declare.
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  // The workspace context a tab needs before any lane can answer - repos, workspaces, repo mapping, resolved folders, `epicLight`, permission role.
  // Optional and never on the released floor (a new floor name is handshake-fatal against every released peer).
  "epic.getWorkspaceContext": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicGetWorkspaceContextV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  // Re-run a failed major migration.
  // Optional, off the released floor, same degrade story as the read above: an older host still understands the frame, so the legacy adapter covers it and a client must not surface a dead Retry button.
  "epic.retryMigration": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicRetryMigrationV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  // One chat image attachment's bytes off the CHAT plane, resolved by the viewer's tab host (its own disk store, else a bearer pass-through to the published cloud blob).
  "epic.readChatAttachment": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicReadChatAttachmentV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  // Artifact attachment bytes still live in the root-doc attachment map, but @2 does not replicate that map to clients.
  // This optional read keeps the artifact/epic authorization subject on the request; a hash alone is never a capability.
  "epic.fetchArtifactAttachment": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicFetchArtifactAttachmentV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  // The per-chat run-settings tuple the record row above summarises down to a harness id.
  "epic.getChatRunSettings": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicGetChatRunSettingsV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    // Major 2 carries the post-v1.2.0 harness ids. v1.0 is frozen at the id set those tags shipped: its response embeds the PERSISTED harness enum, so it absorbed every new id silently until the tag-based gate caught it.
    2: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicGetChatRunSettingsV20,
          upgradeFromPreviousVersion: epicGetChatRunSettingsUpgradeV10ToV20,
        },
      },
      downgradePathsFromLatest: {
        1: epicGetChatRunSettingsDowngradeV20ToV10,
      },
    },
    degrade: { kind: "unsupported" },
  },
  // The terminal-agent record read (the TUI eviction).
  "epic.listTuiAgents": {
    1: {
      latestMinor: 2,
      versions: {
        0: {
          contract: epicListTuiAgentsV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: epicListTuiAgentsV11,
          upgradeFromPreviousVersion: epicListTuiAgentsUpgradeV10ToV11,
          // `epic.subscribe@1.3` - 1.1 grows BOTH halves, and only the request half needs anything from this table.
          // Declaring it anyway is not inert: `assertSchemaCompatibility` rejects an annotation it cannot justify, and it runs at MODULE IMPORT, so the registry throws for every consumer - the app, not just a test.
        },
        2: {
          contract: epicListTuiAgentsV12,
          upgradeFromPreviousVersion: epicListTuiAgentsUpgradeV11ToV12,
          // 1.2 DOES declare it, and the contrast with 1.1 above is the whole rule rather than an inconsistency.
          responseGrowthProjectionGated: true,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  "editor.openPaths": {
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: editorOpenPathsV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: editorOpenPathsV11,
          upgradeFromPreviousVersion: editorOpenPathsUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "git.listChangedFiles": {
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: gitListChangedFilesV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: gitListChangedFilesV11,
          upgradeFromPreviousVersion: gitListChangedFilesUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "git.getFileDiff": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: gitGetFileDiffV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "git.getFileDiffs": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: gitGetFileDiffsV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "git.getCapabilities": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: gitGetCapabilitiesV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "terminal.create": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: terminalCreateV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 1,
      versions: {
        0: {
          contract: terminalCreateV20,
          upgradeFromPreviousVersion: terminalCreateUpgradeV10ToV20,
        },
        1: {
          contract: terminalCreateV21,
          upgradeFromPreviousVersion: terminalCreateUpgradeV20ToV21,
        },
      },
      downgradePathsFromLatest: { 1: terminalCreateDowngradeV21ToV10 },
    },
  },
  "terminal.kill": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: terminalKillV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  // Brand-new v1.0 method (not on `RELEASED_FLOOR_METHOD_NAMES`): an old host simply lacks it, so callers get per-call upgrade guidance instead of a fatal handshake mismatch.
  "resources.kill": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: resourcesKillV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "resources.listLocalServers": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: resourcesListLocalServersV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  // The human lifecycle controls for monitors and shells.
  "managedCommand.start": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: managedCommandStartV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: managedCommandStartV11,
          upgradeFromPreviousVersion: managedCommandStartUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "managedCommand.stop": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: managedCommandStopV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: managedCommandStopV11,
          upgradeFromPreviousVersion: managedCommandStopUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "managedCommand.delete": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: managedCommandDeleteV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  // The one human-editable setting: relaunch after a host restart.
  "managedCommand.configure": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: managedCommandConfigureV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  // Releasing a Stop fence's durable holds.
  // The client renders the held rows (they ride `chat.subscribe`, which negotiates separately) with the action disabled rather than offering one that cannot be served.
  "managedCommand.deliverHeld": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: managedCommandDeliverHeldV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "terminal.list": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: terminalListV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 3,
      versions: {
        0: {
          contract: terminalListV20,
          upgradeFromPreviousVersion: terminalListUpgradeV10ToV20,
        },
        1: {
          contract: terminalListV21,
          upgradeFromPreviousVersion: terminalListUpgradeV20ToV21,
        },
        2: {
          contract: terminalListV22,
          upgradeFromPreviousVersion: terminalListUpgradeV21ToV22,
        },
        3: {
          contract: terminalListV23,
          upgradeFromPreviousVersion: terminalListUpgradeV22ToV23,
        },
      },
      downgradePathsFromLatest: { 1: terminalListDowngradeV23ToV10 },
    },
  },
  // Brand-new v1.0 method on the same `degrade: unsupported` channel as `resources.kill` above: a host predating agent terminal reads simply lacks it, so the CLI gets per-call upgrade guidance instead of a fatal handshake.
  "terminal.readOutput": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: terminalReadOutputV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "terminal.rename": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: terminalRenameV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  // v1.0 is the frozen local-only RC family; v2.1 is the fleet family. They
  // negotiate as a whole so callers never compose incompatible topologies.
  "terminal.plain.create": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: terminalPlainCreateV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 1,
      versions: {
        1: {
          contract: terminalPlainCreateV21,
          upgradeFromPreviousVersion: terminalPlainCreateUpgradeV10ToV21,
          semanticMajorBreakFromPreviousMajor: true,
        },
      },
      downgradePathsFromLatest: { 1: terminalPlainCreateDowngradeV21ToV10 },
    },
  },
  "terminal.plain.list": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: terminalPlainListV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 1,
      versions: {
        1: {
          contract: terminalPlainListV21,
          upgradeFromPreviousVersion: terminalPlainListUpgradeV10ToV21,
        },
      },
      downgradePathsFromLatest: { 1: terminalPlainListDowngradeV21ToV10 },
    },
  },
  "terminal.plain.rename": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: terminalPlainRenameV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 1,
      versions: {
        1: {
          contract: terminalPlainRenameV21,
          upgradeFromPreviousVersion: terminalPlainRenameUpgradeV10ToV21,
        },
      },
      downgradePathsFromLatest: { 1: terminalPlainRenameDowngradeV21ToV10 },
    },
  },
  "terminal.plain.ensureRunning": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: terminalPlainEnsureRunningV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 1,
      versions: {
        1: {
          contract: terminalPlainEnsureRunningV21,
          upgradeFromPreviousVersion: terminalPlainEnsureRunningUpgradeV10ToV21,
          semanticMajorBreakFromPreviousMajor: true,
        },
      },
      downgradePathsFromLatest: {
        1: terminalPlainEnsureRunningDowngradeV21ToV10,
      },
    },
  },
  "terminal.plain.close": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: terminalPlainCloseV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 1,
      versions: {
        1: {
          contract: terminalPlainCloseV21,
          upgradeFromPreviousVersion: terminalPlainCloseUpgradeV10ToV21,
          semanticMajorBreakFromPreviousMajor: true,
        },
      },
      downgradePathsFromLatest: { 1: terminalPlainCloseDowngradeV21ToV10 },
    },
  },
  "terminal.plain.importLegacy": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: terminalPlainImportLegacyV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 1,
      versions: {
        1: {
          contract: terminalPlainImportLegacyV21,
          upgradeFromPreviousVersion: terminalPlainImportLegacyUpgradeV10ToV21,
          semanticMajorBreakFromPreviousMajor: true,
        },
      },
      downgradePathsFromLatest: {
        1: terminalPlainImportLegacyDowngradeV21ToV10,
      },
    },
  },
  "worktree.listByWorkspacePaths": {
    1: {
      latestMinor: 4,
      versions: {
        0: {
          contract: worktreeListByWorkspacePathsV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: worktreeListByWorkspacePathsV11,
          upgradeFromPreviousVersion:
            worktreeListByWorkspacePathsUpgradeV10ToV11,
        },
        2: {
          contract: worktreeListByWorkspacePathsV12,
          upgradeFromPreviousVersion:
            worktreeListByWorkspacePathsUpgradeV11ToV12,
        },
        3: {
          contract: worktreeListByWorkspacePathsV13,
          upgradeFromPreviousVersion:
            worktreeListByWorkspacePathsUpgradeV12ToV13,
        },
        4: {
          contract: worktreeListByWorkspacePathsV14,
          upgradeFromPreviousVersion:
            worktreeListByWorkspacePathsUpgradeV13ToV14,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "worktree.listBranches": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: worktreeListBranchesV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "worktree.create": {
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: worktreeCreateV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: worktreeCreateV11,
          upgradeFromPreviousVersion: worktreeCreateUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "worktree.createPaths": {
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: worktreeCreatePathsV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: worktreeCreatePathsV11,
          upgradeFromPreviousVersion: worktreeCreatePathsUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "worktree.import": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: worktreeImportV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "worktree.setEntryMode": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: worktreeSetEntryModeV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "workspaceBinding.removeEntry": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: workspaceBindingRemoveEntryV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "worktree.retrySetup": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: worktreeRetrySetupV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "worktree.delete": {
    1: {
      latestMinor: 2,
      versions: {
        0: {
          contract: worktreeDeleteV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: worktreeDeleteV11,
          upgradeFromPreviousVersion: worktreeDeleteUpgradeV10ToV11,
        },
        2: {
          contract: worktreeDeleteV12,
          upgradeFromPreviousVersion: worktreeDeleteUpgradeV11ToV12,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "worktree.listHolders": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: worktreeListHoldersV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "worktree.listAllForHost": {
    1: {
      latestMinor: 6,
      versions: {
        0: {
          contract: worktreeListAllForHostV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: worktreeListAllForHostV11,
          upgradeFromPreviousVersion: worktreeListAllForHostUpgradeV10ToV11,
        },
        2: {
          contract: worktreeListAllForHostV12,
          upgradeFromPreviousVersion: worktreeListAllForHostUpgradeV11ToV12,
        },
        3: {
          contract: worktreeListAllForHostV13,
          upgradeFromPreviousVersion: worktreeListAllForHostUpgradeV12ToV13,
        },
        4: {
          contract: worktreeListAllForHostV14,
          upgradeFromPreviousVersion: worktreeListAllForHostUpgradeV13ToV14,
        },
        5: {
          contract: worktreeListAllForHostV15,
          upgradeFromPreviousVersion: worktreeListAllForHostUpgradeV14ToV15,
        },
        6: {
          contract: worktreeListAllForHostV16,
          upgradeFromPreviousVersion: worktreeListAllForHostUpgradeV15ToV16,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "worktree.setRepoScripts": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: worktreeSetRepoScriptsV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "worktree.setRepoBranchPrefix": {
    // Not on the released floor (added after it was frozen) and has no sensible fallback target, so an old host simply lacks the affordance - the GUI gates it with `useHostSupportsMethod` before offering the edit.
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: worktreeSetRepoBranchPrefixV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "worktree.getBinding": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: worktreeGetBindingV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "worktree.listBindingsForEpic": {
    1: {
      latestMinor: 2,
      versions: {
        0: {
          contract: worktreeListBindingsForEpicV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: worktreeListBindingsForEpicV11,
          upgradeFromPreviousVersion:
            worktreeListBindingsForEpicUpgradeV10ToV11,
        },
        2: {
          contract: worktreeListBindingsForEpicV12,
          upgradeFromPreviousVersion:
            worktreeListBindingsForEpicUpgradeV11ToV12,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  // `speech.*@1.0` - on-device dictation model lifecycle.
  "speech.getModelStatus": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: speechGetModelStatusV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "speech.ensureModel": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: speechEnsureModelV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "agent.listProviderProfiles": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentListProviderProfilesV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentListProviderProfilesV20,
          upgradeFromPreviousVersion: agentListProviderProfilesUpgradeV10ToV20,
        },
      },
      downgradePathsFromLatest: {
        1: agentListProviderProfilesDowngradeV20ToV10,
      },
    },
    3: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentListProviderProfilesV30,
          upgradeFromPreviousVersion: agentListProviderProfilesUpgradeV20ToV30,
        },
      },
      downgradePathsFromLatest: {
        1: agentListProviderProfilesDowngradeV30ToV10,
        2: agentListProviderProfilesDowngradeV30ToV20,
      },
    },
    4: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentListProviderProfilesV40,
          upgradeFromPreviousVersion: agentListProviderProfilesUpgradeV30ToV40,
        },
      },
      downgradePathsFromLatest: {
        1: agentListProviderProfilesDowngradeV40ToV10,
        2: agentListProviderProfilesDowngradeV40ToV20,
        3: agentListProviderProfilesDowngradeV40ToV30,
      },
    },
    5: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentListProviderProfilesV50,
          upgradeFromPreviousVersion: agentListProviderProfilesUpgradeV40ToV50,
        },
      },
      downgradePathsFromLatest: {
        1: agentListProviderProfilesDowngradeV50ToV10,
        2: agentListProviderProfilesDowngradeV50ToV20,
        3: agentListProviderProfilesDowngradeV50ToV30,
        4: agentListProviderProfilesDowngradeV50ToV40,
      },
    },
  },
  "agent.getProviderProfileRateLimits": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentGetProviderProfileRateLimitsV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentGetProviderProfileRateLimitsV20,
          upgradeFromPreviousVersion:
            agentGetProviderProfileRateLimitsUpgradeV10ToV20,
        },
      },
      downgradePathsFromLatest: {
        1: agentGetProviderProfileRateLimitsDowngradeV20ToV10,
      },
    },
    3: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentGetProviderProfileRateLimitsV30,
          upgradeFromPreviousVersion:
            agentGetProviderProfileRateLimitsUpgradeV20ToV30,
        },
      },
      downgradePathsFromLatest: {
        1: agentGetProviderProfileRateLimitsDowngradeV30ToV10,
        2: agentGetProviderProfileRateLimitsDowngradeV30ToV20,
      },
    },
    4: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentGetProviderProfileRateLimitsV40,
          upgradeFromPreviousVersion:
            agentGetProviderProfileRateLimitsUpgradeV30ToV40,
        },
      },
      downgradePathsFromLatest: {
        1: agentGetProviderProfileRateLimitsDowngradeV40ToV10,
        2: agentGetProviderProfileRateLimitsDowngradeV40ToV20,
        3: agentGetProviderProfileRateLimitsDowngradeV40ToV30,
      },
    },
    5: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentGetProviderProfileRateLimitsV50,
          upgradeFromPreviousVersion:
            agentGetProviderProfileRateLimitsUpgradeV40ToV50,
        },
      },
      downgradePathsFromLatest: {
        1: agentGetProviderProfileRateLimitsDowngradeV50ToV10,
        2: agentGetProviderProfileRateLimitsDowngradeV50ToV20,
        3: agentGetProviderProfileRateLimitsDowngradeV50ToV30,
        4: agentGetProviderProfileRateLimitsDowngradeV50ToV40,
      },
    },
  },
  "agent.configure": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentConfigureV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentConfigureV20,
          upgradeFromPreviousVersion: agentConfigureUpgradeV10ToV20,
        },
      },
      downgradePathsFromLatest: { 1: agentConfigureDowngradeV20ToV10 },
    },
    3: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentConfigureV30,
          upgradeFromPreviousVersion: agentConfigureUpgradeV20ToV30,
        },
      },
      downgradePathsFromLatest: {
        1: agentConfigureDowngradeV30ToV10,
        2: agentConfigureDowngradeV30ToV20,
      },
    },
    4: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentConfigureV40,
          upgradeFromPreviousVersion: agentConfigureUpgradeV30ToV40,
        },
      },
      downgradePathsFromLatest: {
        1: agentConfigureDowngradeV40ToV10,
        2: agentConfigureDowngradeV40ToV20,
        3: agentConfigureDowngradeV40ToV30,
      },
    },
    5: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentConfigureV50,
          upgradeFromPreviousVersion: agentConfigureUpgradeV40ToV50,
        },
      },
      downgradePathsFromLatest: {
        1: agentConfigureDowngradeV50ToV10,
        2: agentConfigureDowngradeV50ToV20,
        3: agentConfigureDowngradeV50ToV30,
        4: agentConfigureDowngradeV50ToV40,
      },
    },
  },
  // Additive, post-v1.0.0 optional method: a PR's patch read from the local checkout.
  "pr.getLocalDiff": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: prGetLocalDiffV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  // The split form of `pr.getLocalDiff` - a cheap metadata frame plus one patch per file, fetched per visible row.
  // Same optional-capability posture as the monolith above (and always registered together with it): a client that finds these missing calls `pr.getLocalDiff` instead, so neither touches the released floor / baseline.
  "pr.getLocalDiffSummary": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: prGetLocalDiffSummaryV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "pr.getLocalFileDiff": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        // The request echoes the summary row's byte-path sidecars per side on
        // the only minor; a `null` still means "clean path", never "legacy".
        0: {
          contract: prGetLocalFileDiffV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  // Additive post-v1.0 unary methods. An older host lacks the GitHub mention
  // picker surface entirely, so callers feature-detect and degrade per call.
  "mention.githubCatalog": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: mentionGithubCatalogV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "mention.githubSearch": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: mentionGithubSearchV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
} as const;

const HOST_RPC_PROVIDERS_REGISTRY_DEFINITION = {
  "providers.list": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersListV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersListV20,
          upgradeFromPreviousVersion: providersListUpgradeV1ToV2,
        },
      },
      downgradePathsFromLatest: { 1: providersListDowngradeV2ToV1 },
    },
    3: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersListV30,
          upgradeFromPreviousVersion: providersListUpgradeV2ToV3,
        },
      },
      downgradePathsFromLatest: {
        1: providersListDowngradeV3ToV1,
        2: providersListDowngradeV3ToV2,
      },
    },
    4: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersListV40,
          upgradeFromPreviousVersion: providersListUpgradeV3ToV4,
        },
      },
      downgradePathsFromLatest: {
        1: providersListDowngradeV4ToV1,
        2: providersListDowngradeV4ToV2,
        3: providersListDowngradeV4ToV3,
      },
    },
    5: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersListV50,
          upgradeFromPreviousVersion: providersListUpgradeV4ToV5,
        },
      },
      downgradePathsFromLatest: {
        1: providersListDowngradeV5ToV1,
        2: providersListDowngradeV5ToV2,
        3: providersListDowngradeV5ToV3,
        4: providersListDowngradeV5ToV4,
      },
    },
    6: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersListV60,
          upgradeFromPreviousVersion: providersListUpgradeV5ToV6,
        },
      },
      downgradePathsFromLatest: {
        1: providersListDowngradeV6ToV1,
        2: providersListDowngradeV6ToV2,
        3: providersListDowngradeV6ToV3,
        4: providersListDowngradeV6ToV4,
        5: providersListDowngradeV6ToV5,
      },
    },
    7: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersListV70,
          upgradeFromPreviousVersion: providersListUpgradeV6ToV7,
        },
      },
      downgradePathsFromLatest: {
        1: providersListDowngradeV7ToV1,
        2: providersListDowngradeV7ToV2,
        3: providersListDowngradeV7ToV3,
        4: providersListDowngradeV7ToV4,
        5: providersListDowngradeV7ToV5,
        6: providersListDowngradeV7ToV6,
      },
    },
    8: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersListV80,
          upgradeFromPreviousVersion: providersListUpgradeV70ToV80,
        },
      },
      downgradePathsFromLatest: {
        1: providersListDowngradeV8ToV1,
        2: providersListDowngradeV8ToV2,
        3: providersListDowngradeV8ToV3,
        4: providersListDowngradeV8ToV4,
        5: providersListDowngradeV8ToV5,
        6: providersListDowngradeV8ToV6,
        7: providersListDowngradeV8ToV7,
      },
    },
  },

  "providers.setSelection": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersSetSelectionV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 1,
      versions: {
        0: {
          contract: providersSetSelectionV20,
          upgradeFromPreviousVersion: providersSetSelectionUpgradeV1ToV2,
        },
        1: {
          contract: providersSetSelectionV21,
          upgradeFromPreviousVersion: providersSetSelectionUpgradeV20ToV21,
        },
      },
      downgradePathsFromLatest: {
        1: providersSetSelectionDowngradeV21ToV10,
      },
    },
  },
  "providers.addCustomPath": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersAddCustomPathV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 1,
      versions: {
        0: {
          contract: providersAddCustomPathV20,
          upgradeFromPreviousVersion: providersAddCustomPathUpgradeV1ToV2,
        },
        1: {
          contract: providersAddCustomPathV21,
          upgradeFromPreviousVersion: providersAddCustomPathUpgradeV20ToV21,
        },
      },
      downgradePathsFromLatest: {
        1: providersAddCustomPathDowngradeV21ToV10,
      },
    },
  },
  "providers.removeCustomPath": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersRemoveCustomPathV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 1,
      versions: {
        0: {
          contract: providersRemoveCustomPathV20,
          upgradeFromPreviousVersion: providersRemoveCustomPathUpgradeV1ToV2,
        },
        1: {
          contract: providersRemoveCustomPathV21,
          upgradeFromPreviousVersion: providersRemoveCustomPathUpgradeV20ToV21,
        },
      },
      downgradePathsFromLatest: {
        1: providersRemoveCustomPathDowngradeV21ToV10,
      },
    },
  },
  "providers.detectVersion": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersDetectVersionV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.startLogin": {
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: providersStartLoginV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: providersStartLoginV11,
          upgradeFromPreviousVersion: providersStartLoginUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.awaitLogin": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersAwaitLoginV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 1,
      versions: {
        0: {
          contract: providersAwaitLoginV20,
          upgradeFromPreviousVersion: providersAwaitLoginUpgradeV1ToV2,
        },
        1: {
          contract: providersAwaitLoginV21,
          upgradeFromPreviousVersion: providersAwaitLoginUpgradeV20ToV21,
        },
      },
      downgradePathsFromLatest: {
        1: providersAwaitLoginDowngradeV21ToV10,
      },
    },
  },
  "providers.cancelLogin": {
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: providersCancelLoginV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: providersCancelLoginV11,
          upgradeFromPreviousVersion: providersCancelLoginUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.setProfileEnabled": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersSetProfileEnabledV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.mcpAuth": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersMcpAuthV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.awaitMcpAuth": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersAwaitMcpAuthV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.cancelMcpAuth": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersCancelMcpAuthV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.nativeMutate": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersNativeMutateV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.listModelProviders": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersListModelProvidersV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.modelProviderAuth": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersModelProviderAuthV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.awaitModelProviderAuth": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersAwaitModelProviderAuthV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.cancelModelProviderAuth": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersCancelModelProviderAuthV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  // The four per-pack version-manager methods.
  // All `degrade: unsupported`: they are new names outside `RELEASED_FLOOR_METHOD_NAMES`, so a host that predates them must fail these calls individually rather than refuse the connection.
  "providers.installPackVersion": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersInstallPackVersionV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.removePackVersion": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersRemovePackVersionV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.usePackVersion": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersUsePackVersionV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.setPackPolicy": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersSetPackPolicyV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  // The on-demand discovery poll the version popover's check button drives.
  "providers.refreshPackDiscovery": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersRefreshPackDiscoveryV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.submitLoginCode": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersSubmitLoginCodeV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.touchLogin": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersTouchLoginV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.startTerminalLogin": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersStartTerminalLoginV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersStartTerminalLoginV20,
          upgradeFromPreviousVersion:
            providersStartTerminalLoginUpgradeV10ToV20,
        },
      },
      downgradePathsFromLatest: {
        1: providersStartTerminalLoginDowngradeV20ToV10,
      },
    },
  },
  "providers.ensurePack": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersEnsurePackV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.setApiKey": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersSetApiKeyV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 1,
      versions: {
        0: {
          contract: providersSetApiKeyV20,
          upgradeFromPreviousVersion: providersSetApiKeyUpgradeV1ToV2,
        },
        1: {
          contract: providersSetApiKeyV21,
          upgradeFromPreviousVersion: providersSetApiKeyUpgradeV20ToV21,
        },
      },
      downgradePathsFromLatest: {
        1: providersSetApiKeyDowngradeV21ToV10,
      },
    },
  },
  "providers.clearApiKey": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersClearApiKeyV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 1,
      versions: {
        0: {
          contract: providersClearApiKeyV20,
          upgradeFromPreviousVersion: providersClearApiKeyUpgradeV1ToV2,
        },
        1: {
          contract: providersClearApiKeyV21,
          upgradeFromPreviousVersion: providersClearApiKeyUpgradeV20ToV21,
        },
      },
      downgradePathsFromLatest: {
        1: providersClearApiKeyDowngradeV21ToV10,
      },
    },
  },
  "providers.setTerminalAgentArgs": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersSetTerminalAgentArgsV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 1,
      versions: {
        0: {
          contract: providersSetTerminalAgentArgsV20,
          upgradeFromPreviousVersion:
            providersSetTerminalAgentArgsUpgradeV1ToV2,
        },
        1: {
          contract: providersSetTerminalAgentArgsV21,
          upgradeFromPreviousVersion:
            providersSetTerminalAgentArgsUpgradeV20ToV21,
        },
      },
      downgradePathsFromLatest: {
        1: providersSetTerminalAgentArgsDowngradeV21ToV10,
      },
    },
  },
  "providers.setEnvOverride": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersSetEnvOverrideV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 1,
      versions: {
        0: {
          contract: providersSetEnvOverrideV20,
          upgradeFromPreviousVersion: providersSetEnvOverrideUpgradeV1ToV2,
        },
        1: {
          contract: providersSetEnvOverrideV21,
          upgradeFromPreviousVersion: providersSetEnvOverrideUpgradeV20ToV21,
        },
      },
      downgradePathsFromLatest: {
        1: providersSetEnvOverrideDowngradeV21ToV10,
      },
    },
  },
  "providers.deleteEnvOverride": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersDeleteEnvOverrideV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 1,
      versions: {
        0: {
          contract: providersDeleteEnvOverrideV20,
          upgradeFromPreviousVersion: providersDeleteEnvOverrideUpgradeV1ToV2,
        },
        1: {
          contract: providersDeleteEnvOverrideV21,
          upgradeFromPreviousVersion: providersDeleteEnvOverrideUpgradeV20ToV21,
        },
      },
      downgradePathsFromLatest: {
        1: providersDeleteEnvOverrideDowngradeV21ToV10,
      },
    },
  },
  "providers.setEnabled": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersSetEnabledV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
    2: {
      latestMinor: 1,
      versions: {
        0: {
          contract: providersSetEnabledV20,
          upgradeFromPreviousVersion: providersSetEnabledUpgradeV1ToV2,
        },
        1: {
          contract: providersSetEnabledV21,
          upgradeFromPreviousVersion: providersSetEnabledUpgradeV20ToV21,
        },
      },
      downgradePathsFromLatest: {
        1: providersSetEnabledDowngradeV21ToV10,
      },
    },
  },
} as const;

const HOST_RPC_EDITING_REGISTRY_DEFINITION = {
  // Additive, post-v1.0.0 optional method. Older hosts render the same file
  // surfaces read-only; newer hosts provide conflict-safe in-place saves.
  "workspace.writeFile": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: workspaceWriteFileV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  // Optional edit hydration: full old/new/worktree text is fetched only when
  // the user enters edit mode. Older hosts keep Git diffs read-only.
  "git.getFileContents": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: gitGetFileContentsV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
} as const;

// The three literals must not declare the same method.
// `AssertNever` fails the moment this resolves to anything but `never`, and the error names the offending method.
type AssertNever<T extends never> = T;

type DuplicateHostRpcMethodNames =
  | Extract<
      keyof typeof HOST_RPC_REGISTRY_BASE_DEFINITION,
      keyof typeof HOST_RPC_REGISTRY_BASE_TAIL_DEFINITION
    >
  | Extract<
      keyof typeof HOST_RPC_REGISTRY_BASE_DEFINITION,
      keyof typeof HOST_RPC_EDITING_REGISTRY_DEFINITION
    >
  | Extract<
      keyof typeof HOST_RPC_REGISTRY_BASE_DEFINITION,
      keyof typeof HOST_RPC_PROVIDERS_REGISTRY_DEFINITION
    >
  | Extract<
      keyof typeof HOST_RPC_REGISTRY_BASE_TAIL_DEFINITION,
      keyof typeof HOST_RPC_PROVIDERS_REGISTRY_DEFINITION
    >
  | Extract<
      keyof typeof HOST_RPC_PROVIDERS_REGISTRY_DEFINITION,
      keyof typeof HOST_RPC_EDITING_REGISTRY_DEFINITION
    >
  | Extract<
      keyof typeof HOST_RPC_REGISTRY_BASE_TAIL_DEFINITION,
      keyof typeof HOST_RPC_EDITING_REGISTRY_DEFINITION
    >;

// `Record<never, never>` is `{}` while the key sets stay disjoint, so this
// intersection is a no-op in the healthy case.
type HostRpcRegistryDefinition = typeof HOST_RPC_REGISTRY_BASE_DEFINITION &
  typeof HOST_RPC_REGISTRY_BASE_TAIL_DEFINITION &
  typeof HOST_RPC_PROVIDERS_REGISTRY_DEFINITION &
  typeof HOST_RPC_EDITING_REGISTRY_DEFINITION &
  Record<AssertNever<DuplicateHostRpcMethodNames>, never>;

const HOST_RPC_REGISTRY_DEFINITION: HostRpcRegistryDefinition = {
  ...HOST_RPC_REGISTRY_BASE_DEFINITION,
  ...HOST_RPC_REGISTRY_BASE_TAIL_DEFINITION,
  ...HOST_RPC_PROVIDERS_REGISTRY_DEFINITION,
  ...HOST_RPC_EDITING_REGISTRY_DEFINITION,
};

export const hostRpcRegistry: VersionedRpcRegistry<HostRpcRegistryDefinition> =
  defineFloorAwareVersionedRpcRegistry(
    RELEASED_FLOOR_METHOD_NAMES,
    HOST_RPC_REGISTRY_DEFINITION,
  );

export type HostRpcRegistry = typeof hostRpcRegistry;

/**
 * `epic.subscribe@1.1` - Combined streaming-RPC registry for the `/stream` WS manifest.
 * Later minors within the same major line must be additive; later majors must carry a real breaking change and ship without a cross-major downgrade bridge (streams reconnect on mismatched majors in v1).
 */
// Named ahead of `hostStreamRpcRegistry` (mirrors `HOST_RPC_REGISTRY_DEFINITION` above), which still validates every entry against this literal's precise type at the `defineVersionedStreamRpcRegistry` call site below -.
// Keeping this const free of `chat.subscribe` means `typeof HOST_STREAM_RPC_REGISTRY_OTHER_DEFINITION` never has to expand it (see `HostStreamRpcMethodMap` below).
const HOST_STREAM_RPC_REGISTRY_OTHER_DEFINITION = {
  "epic.subscribe": {
    1: {
      // @1.1 adds additive `dirtySnapshot`, `artifactRoomDirty`, and `rootDirty`. @1.0 stays installed and FROZEN: a renderer that negotiated it never receives the new kinds, and the resolver gates emission on the negotiated.
      latestMinor: 3,
      versions: {
        0: {
          contract: epicSubscribeV10,
        },
        1: {
          contract: epicSubscribeV11,
        },
        2: {
          contract: epicSubscribeV12,
        },
        3: {
          contract: epicSubscribeV13,
        },
      },
    },
    // ONE major, and permanently so.
  },
  // ─── The epic LANES ───────────────────────────────────────────────────────
  // None may ever be added to the unary released floor (`released-floor.ts`), which is fail-closed on the name set.
  "epic.state.subscribe": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicStateSubscribeV10,
        },
      },
    },
  },
  "epic.status.subscribe": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicStatusSubscribeV10,
        },
      },
    },
  },
  "artifact.subscribe": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: artifactSubscribeV10,
        },
      },
    },
  },
  "notifications.subscribe": {
    1: {
      // @1.1 adds the additive, server-only `awareness` frame (agent-activity presence on the per-user notification room). @1.0 stays installed and FROZEN: a client that negotiated it must never receive the new kind - the.
      latestMinor: 1,
      versions: {
        0: {
          contract: notificationsSubscribeV10,
        },
        1: {
          contract: notificationsSubscribeV11,
        },
      },
    },
  },
  "host.notifications.subscribe": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostNotificationsSubscribeV10,
        },
      },
    },
  },
  "host.notifications.feed.subscribe": {
    1: {
      latestMinor: 2,
      versions: {
        0: {
          contract: hostNotificationsFeedSubscribeV10,
        },
        1: {
          contract: hostNotificationsFeedSubscribeV11,
        },
        2: {
          contract: hostNotificationsFeedSubscribeV12,
        },
      },
    },
  },
  "host.notifications.cloudFeed.subscribe": {
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: hostNotificationsCloudFeedSubscribeV10,
        },
        1: {
          contract: hostNotificationsCloudFeedSubscribeV11,
        },
      },
    },
  },
  "terminal.subscribe": {
    1: {
      latestMinor: 6,
      versions: {
        0: {
          contract: terminalSubscribeV10,
        },
        1: {
          contract: terminalSubscribeV11,
        },
        2: {
          contract: terminalSubscribeV12,
        },
        3: {
          contract: terminalSubscribeV13,
        },
        4: {
          contract: terminalSubscribeV14,
        },
        5: {
          contract: terminalSubscribeV15,
        },
        6: {
          contract: terminalSubscribeV16,
        },
      },
    },
  },
  // Frozen v1 snapshot/increment stream and v2 replacement-state fleet stream.
  "terminal.plain.subscribeList": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: terminalPlainSubscribeListV10,
        },
      },
    },
    2: {
      latestMinor: 1,
      versions: {
        1: {
          contract: terminalPlainSubscribeListV21,
        },
      },
    },
  },
  // `chat.subscribe@1.6` - The "Monitors & Shells" surface: one stream per command for its output.
  "managedCommand.subscribeOutput": {
    1: {
      // `1.1` adds `relaunchOnHostRestart` to the snapshot/status headers;
      // `1.0` is pinned to the shipped pre-relaunch command shape.
      latestMinor: 1,
      versions: {
        0: {
          contract: managedCommandSubscribeOutputV10,
        },
        1: {
          contract: managedCommandSubscribeOutputV11,
        },
      },
    },
  },
  "browser.sessions": {
    1: {
      // Shared-browser-runtime ticket 01: `browser.sessions` never shipped, so its prior in-repo minor history (@1.0-@1.4) is collapsed into one fresh @1.0 baseline carrying every frame kind - see the doc comment on.
      latestMinor: 0,
      versions: {
        0: {
          contract: browserSessionsV1,
        },
      },
    },
  },
  "browser.screencast": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: browserScreencastV1,
        },
      },
    },
  },
  "git.subscribeStatus": {
    1: {
      latestMinor: 3,
      versions: {
        0: {
          contract: gitSubscribeStatusV10,
        },
        // Nested-snapshot minor: `submodules[]` + `nestedFingerprint` + v1.1 file rows on server frames.
        1: {
          contract: gitSubscribeStatusV11,
        },
        // Guaranteed-fresh stream replacement: required `freshNonce` on the v1.2 open and snapshot/updated frames.
        2: {
          contract: gitSubscribeStatusV12,
        },
        3: {
          contract: gitSubscribeStatusV13,
        },
      },
    },
  },
  "workspace.subscribeFileList": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: workspaceSubscribeFileListV10,
        },
      },
    },
  },
  // Asset preview stream for the workspace file tile - no-degrade rationale in `asset-stream.ts`'s file-level doc. 1.1 adds PDF.
  "workspace.streamAsset": {
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: workspaceStreamAssetV10,
        },
        1: {
          contract: workspaceStreamAssetV11,
        },
      },
    },
  },
  // Sibling of `workspace.streamAsset` for the git diff tile's old/new sides - same no-degrade rationale. 1.1 adds PDF.
  "git.streamFileAsset": {
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: gitStreamFileAssetV10,
        },
        1: {
          contract: gitStreamFileAssetV11,
        },
      },
    },
  },
  "resources.subscribe": {
    1: {
      latestMinor: 5,
      versions: {
        0: {
          contract: resourcesSubscribeV10,
        },
        1: {
          contract: resourcesSubscribeV11,
        },
        2: {
          contract: resourcesSubscribeV12,
        },
        3: {
          contract: resourcesSubscribeV13,
        },
        // @1.4 widens the owner kind vocabulary by `managed-command`.
        // A peer below it keeps the frozen three-kind enum and never receives one of those owners: the resolver folds their usage into `other`, as it did for every minor before this one.
        4: {
          contract: resourcesSubscribeV14,
        },
        // @1.5 lets a mounted stream remain on the background cadence while
        // only a visible resource monitor asks for interactive refresh.
        5: {
          contract: resourcesSubscribeV15,
        },
      },
    },
  },
  "agent.inbox.subscribe": {
    1: {
      // @1.1 adds the additive `role-awareness` frame. @1.0 stays installed and FROZEN: a monitor that negotiated it never receives the new kind, and the resolver gates on the negotiated version rather than assuming the peer.
      latestMinor: 3,
      versions: {
        0: {
          contract: agentInboxSubscribeV10,
        },
        1: {
          contract: agentInboxSubscribeV11,
        },
        2: {
          contract: agentInboxSubscribeV12,
        },
        3: {
          contract: agentInboxSubscribeV13,
        },
      },
    },
  },
  // One activity capability, with its read plane selected by the host.
  // State frames report the selected plane, while renderers never choose a different RPC from entitlement state.
  "agent.activity.subscribe": {
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: agentActivitySubscribeV10,
        },
        1: {
          contract: agentActivitySubscribeV11,
        },
      },
    },
  },
  // Additive, post-v1.0.0 OPTIONAL stream method: the per-epic communication event log behind the Communication Graph tile.
  // Never add it to the unary released floor - that list is fail-closed on the name set.
  "epic.communicationGraph.subscribe": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicCommunicationGraphSubscribeV10,
        },
      },
    },
  },
  // Additive, post-v1.0.0 OPTIONAL stream method: the cloud-relayed counterpart of `epic.communicationGraph.subscribe` above.
  // Never add it to the unary released floor - that list is fail-closed on the name set.
  "host.communicationGraph.subscribe": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostCommunicationGraphCloudFeedSubscribeV10,
        },
      },
    },
  },
  // Additive, post-v1.0.0 OPTIONAL stream method: the chat-RECORD delta push, freshness counterpart of the `epic.listChatRecords` read.
  // A host that predates it never advertises it and the client's subscription degrades to `unsupported`, whose contract is simply that the 20s `epic.listChatRecords` poll remains the record table's only refresh - latency.
  "host.chatRecords.subscribe": {
    1: {
      latestMinor: 2,
      versions: {
        0: {
          contract: hostChatRecordsSubscribeV10,
        },
        1: {
          contract: hostChatRecordsSubscribeV11,
        },
        2: {
          contract: hostChatRecordsSubscribeV12,
        },
      },
    },
  },
  "migration.run": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: migrationRunV10,
        },
      },
    },
  },
  // Additive, post-v1.0.0 OPTIONAL stream methods: session import.
  "sessionImport.scan": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: sessionImportScanV10,
        },
      },
    },
  },
  "sessionImport.run": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: sessionImportRunV10,
        },
      },
    },
  },
  "worktree.deleteByPath": {
    1: {
      latestMinor: 2,
      versions: {
        0: {
          contract: worktreeDeleteByPathStreamV10,
        },
        1: {
          contract: worktreeDeleteByPathStreamV11,
        },
        2: {
          contract: worktreeDeleteByPathStreamV12,
        },
      },
    },
  },
  // Separate method, not a minor of `worktree.deleteByPath`: its request and frames are released and frozen, and a client that lands on the batch method must be able to discover THAT, not negotiate down to a per-target.
  "worktree.deleteBatchByPath": {
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: worktreeDeleteBatchByPathStreamV10,
        },
        1: {
          contract: worktreeDeleteBatchByPathStreamV11,
        },
      },
    },
  },
  "worktree.changed": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: worktreeChangedV10,
        },
      },
    },
  },
  "providers.changed": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersChangedV10,
        },
      },
    },
  },
  "speech.dictate": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: speechDictateV10,
        },
      },
    },
  },
  "pr.subscribeListForEpic": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: prSubscribeListForEpicV10,
        },
      },
    },
  },
  "pr.subscribeDetail": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: prSubscribeDetailV10,
        },
      },
    },
  },
} as const;

const HOST_STREAM_RPC_REGISTRY_DEFINITION = {
  ...HOST_STREAM_RPC_REGISTRY_OTHER_DEFINITION,
  "chat.subscribe": {
    1: {
      latestMinor: 8,
      versions: {
        0: {
          contract: chatSubscribeV10,
        },
        1: {
          contract: chatSubscribeV11,
        },
        2: {
          contract: chatSubscribeV12,
        },
        3: {
          contract: chatSubscribeV13,
        },
        4: {
          contract: chatSubscribeV14,
        },
        5: {
          contract: chatSubscribeV15,
        },
        6: {
          contract: chatSubscribeV16,
        },
        7: {
          contract: chatSubscribeV17,
        },
        8: {
          contract: chatSubscribeV18,
        },
      },
    },
  },
} as const;

// `chat.subscribe`'s value slot is widened to the generic `UncheckedStreamMethodVersionRegistry` shape here rather than reusing `typeof HOST_STREAM_RPC_REGISTRY_DEFINITION` (which includes it): every OTHER streaming.
type HostStreamRpcMethodMap =
  typeof HOST_STREAM_RPC_REGISTRY_OTHER_DEFINITION & {
    readonly "chat.subscribe": UncheckedStreamMethodVersionRegistry;
  };

export type HostStreamRpcRegistry =
  VersionedStreamRpcRegistry<HostStreamRpcMethodMap>;

export const hostStreamRpcRegistry: HostStreamRpcRegistry =
  defineVersionedStreamRpcRegistry(HOST_STREAM_RPC_REGISTRY_DEFINITION);
