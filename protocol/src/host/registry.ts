import {
  defineDowngradePath,
  defineFloorAwareVersionedRpcRegistry,
  defineUpgradePath,
  type DowngradeResult,
} from "@traycer/protocol/framework/index";
import { defineVersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  agentCreateV10,
  agentCreateV20,
  agentCreateDowngradeV20ToV10,
  agentCreateUpgradeV10ToV20,
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
  agentListUpgradeV1ToV2,
  agentListUpgradeV2ToV3,
  agentListUpgradeV3ToV4,
  agentListV10,
  agentListV20,
  agentListV30,
  agentListV40,
  agentSelectionGuideV10,
  agentSelectionGuideGlobalGetV10,
  agentSelectionGuideGlobalOnboardingDraftGetV10,
  agentSelectionGuideGlobalResetV10,
  agentSelectionGuideGlobalSetV10,
  agentSendMessageV10,
  agentStopV10,
} from "@traycer/protocol/host/agent/contracts";
import {
  agentConfigureV10,
  agentGetProviderProfileRateLimitsV10,
  agentListProviderProfilesV10,
} from "@traycer/protocol/host/agent/profiles";
import {
  agentInboxReadV10,
  agentInboxSubscribeV10,
} from "@traycer/protocol/host/agent/inbox";
import {
  agentGuiGetPlanV10,
  agentGuiListCommandsV10,
  agentGuiListHarnessesDowngradeV2ToV1,
  agentGuiListHarnessesDowngradeV3ToV1,
  agentGuiListHarnessesDowngradeV3ToV2,
  agentGuiListHarnessesDowngradeV4ToV1,
  agentGuiListHarnessesDowngradeV4ToV2,
  agentGuiListHarnessesDowngradeV4ToV3,
  agentGuiListHarnessesUpgradeV1ToV2,
  agentGuiListHarnessesUpgradeV20ToV21,
  agentGuiListHarnessesUpgradeV2ToV3,
  agentGuiListHarnessesUpgradeV3ToV4,
  agentGuiListHarnessesV10,
  agentGuiListHarnessesV20,
  agentGuiListHarnessesV21,
  agentGuiListHarnessesV30,
  agentGuiListHarnessesV40,
  agentGuiListModelsV10,
  chatSubscribeV10,
  chatSubscribeV11,
  chatSubscribeV12,
  chatSubscribeV13,
  chatSubscribeV14,
} from "@traycer/protocol/host/agent/gui/contracts";
import {
  agentTuiGenerateTitleV10,
  agentTuiTurnEndedV10,
  agentTuiListHarnessesV10,
  agentTuiPrepareLaunchV10,
  agentTuiRecordActivityV10,
  agentTuiRecordActivityV11,
  agentTuiRecordActivityUpgradeV10ToV11,
} from "@traycer/protocol/host/agent/tui/contracts";
import {
  commentsListThreadsV10,
  commentsSetThreadStatusV10,
} from "@traycer/protocol/host/comments/contracts";
import { hostStatusV10 } from "@traycer/protocol/host/status/contracts";
import { hostGetRuntimeCapabilitiesV10 } from "@traycer/protocol/host/runtime-capabilities/contracts";
import {
  hostGetRateLimitUsageV10,
  hostGetRateLimitUsageV11,
  hostGetRateLimitUsageV12,
  hostGetRateLimitUsageV20,
  hostGetRateLimitUsageV21,
  hostGetRateLimitUsageUpgradeV10ToV11,
  hostGetRateLimitUsageUpgradeV11ToV12,
  hostGetRateLimitUsageUpgradeV12ToV20,
  hostGetRateLimitUsageUpgradeV20ToV21,
  hostGetRateLimitUsageDowngradeV2ToV1,
  providersConsumeRateLimitResetCreditV10,
} from "@traycer/protocol/host/rate-limit/contracts";
import {
  epicBatchDeleteV10,
  epicBatchUpdateRolesV10,
  epicCreateArtifactV10,
  epicCreateChatV10,
  epicCreateCommentThreadV10,
  epicCreateTuiAgentV10,
  epicCreateV10,
  epicDeleteArtifactV10,
  epicDeleteChatV10,
  epicDeleteCommentThreadV10,
  epicDeleteCommentV10,
  epicDeleteTuiAgentV10,
  epicEditCommentV10,
  epicGetTaskContextsV10,
  epicGrantAccessV10,
  epicListCollaboratorsV10,
  epicListCommentThreadsV10,
  epicListTasksV10,
  epicListTasksV11,
  epicListTasksUpgradeV10ToV11,
  epicMentionEpicsV10,
  epicMentionReviewsV10,
  epicMentionSpecsV10,
  epicMentionStoriesV10,
  epicMentionTicketsV10,
  epicRemoveRepoV10,
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
  epicRevokeCollaboratorV10,
  epicSetCommentThreadResolvedV10,
  epicSetPinnedV10,
  epicSubscribeV10,
  epicUpdateArtifactStatusV10,
  epicUpdateTitleV10,
} from "@traycer/protocol/host/epic/contracts";
import {
  workspaceMentionFilesV10,
  workspaceMentionFoldersV10,
  workspaceMentionWorktreesV10,
  workspaceMentionGitBranchesV10,
  workspaceMentionGitCommitsV10,
  workspaceMentionGitRootV10,
  workspaceListDirectoryV10,
  workspaceListFileTreeV10,
  workspacePrepareFoldersV10,
  workspaceReadFileV10,
  workspaceResolvePathsByRepoIdentifiersV10,
} from "@traycer/protocol/host/workspace/contracts";
import {
  terminalCreateDowngradeV20ToV10,
  terminalCreateV10,
  terminalCreateV20,
  terminalCreateUpgradeV10ToV20,
  terminalKillV10,
  terminalListDowngradeV20ToV10,
  terminalListV10,
  terminalListV20,
  terminalListUpgradeV10ToV20,
  terminalRenameV10,
  terminalSubscribeV10,
  terminalSubscribeV11,
  terminalSubscribeV12,
  terminalSubscribeV13,
  terminalSubscribeV14,
} from "@traycer/protocol/host/terminal/contracts";
import {
  hostNotificationHooksSave,
  hostNotificationHooksStatus,
  hostNotificationHooksTest,
  hostNotificationsClearAll,
  hostNotificationsGetConfig,
  hostNotificationsIndicatorState,
  hostNotificationsList,
  hostNotificationsMarkAllRead,
  hostNotificationsMarkRead,
  hostNotificationsSetConfig,
  hostNotificationsSubscribe,
  notificationsSubscribeV10,
} from "@traycer/protocol/host/notifications/contracts";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  resourcesSubscribeV10,
  resourcesSubscribeV11,
  resourcesSubscribeV12,
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
import { worktreeDeleteByPathStreamV10 } from "@traycer/protocol/host/worktree-delete-stream";
import { worktreeChangedV10 } from "@traycer/protocol/host/worktree-changed-stream";
import { editorOpenPathsV10 } from "@traycer/protocol/host/editor/contracts";
import {
  gitListChangedFilesV10,
  gitListChangedFilesV11,
  gitListChangedFilesUpgradeV10ToV11,
  gitGetFileDiffV10,
  gitGetFileDiffsV10,
  gitGetCapabilitiesV10,
  gitSubscribeStatusV10,
  gitSubscribeStatusV11,
} from "@traycer/protocol/host/git-contracts";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import {
  worktreeCreateRequestSchema,
  worktreeCreateResponseSchema,
  worktreeCreatePathsRequestSchema,
  worktreeCreatePathsResponseSchema,
  worktreeDeleteRequestSchema,
  worktreeDeleteResponseSchema,
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
  providersCancelLoginRequestSchema,
  providersCancelLoginRequestSchemaV11,
  providersCancelLoginResponseSchema,
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
  providersStartLoginRequestSchema,
  providersStartLoginRequestSchemaV11,
  providersStartLoginResponseSchema,
  providersStartLoginResponseSchemaV11,
  providersSubmitLoginCodeRequestSchema,
  providersSubmitLoginCodeResponseSchema,
  providersTouchLoginRequestSchema,
  providersTouchLoginResponseSchema,
  providersListRequestSchema,
  providersListResponseSchema,
  providersListResponseSchemaV10,
  providersListResponseSchemaV20,
  providersListResponseSchemaV30,
  downgradeProviderCliStateToV10,
  downgradeProviderCliStateListToV20,
  downgradeProviderCliStateListToV30,
  upgradeProviderCliStateV10ToV20,
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
  providersSetEnabledRequestSchema,
  providersSetEnabledRequestSchemaV10,
  providersSetEnabledRequestSchemaV21,
  providersSetEnabledResponseSchema,
  providersSetEnabledResponseSchemaV10,
  providersSetEnabledResponseSchemaV20,
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
  type ProviderCliState,
  type ProviderCliStateV10,
  type ProviderMutationCliStateV20,
  type ProviderLoginCapability,
  type ProviderLoginCapabilityV10,
} from "@traycer/protocol/host/provider-schemas";

export { hostGetRuntimeCapabilitiesV10 };
export { hostGetRateLimitUsageV10 };

/**
 * Traycer 3.0 host RPC protocol.
 *
 * Authoritative home for contracts the local host publishes (`host.*`,
 * `agent.*`, and `epic.*` methods). Every host consumer - the host
 * dispatcher itself, the `gui-app` client, the desktop shell - must resolve
 * contracts from here so request shapes on the wire and response shapes on
 * the wire line up.
 *
 * Growth rules:
 *
 * 1. Add new methods as top-level keys (for example `host.ping`).
 * 2. Add new minors within a major line for backward-compatible changes;
 *    each non-initial minor must declare `upgradeFromPreviousVersion`.
 * 3. Add new majors when a contract actually breaks compatibility (a
 *    field is removed or its JSON Schema narrows). Declare a
 *    `downgradePathsFromLatest` bridge back to every older major the
 *    host still accepts from older clients.
 *
 * `validateVersionedRpcRegistry()` - which
 * `defineVersionedRpcRegistry()` runs automatically at module load - is
 * the single contract future growth has to keep passing.
 */
// `snapshots.*@1.0` - local-only snapshot storage management. Contracts land
// inline here pending a per-domain contracts file. Schemas live in
// `protocol/host/snapshot-schemas.ts`.
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

// `worktree.*@1.0` - local-only worktree binding lifecycle. Contracts land
// inline here pending a per-domain contracts file. Schemas live in
// `protocol/host/worktree-schemas.ts`.
export const worktreeListByWorkspacePathsV10 = defineRpcContract({
  method: "worktree.listByWorkspacePaths",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: worktreeListByWorkspacePathsRequestSchema,
  responseSchema: worktreeListByWorkspacePathsResponseSchema,
});

// v1.1 adds the per-ref committed-scripts preview (`scriptRefs` ->
// `scriptsAtRefs`) the create-worktree Environment editor uses. Folded onto this
// existing method instead of a standalone `worktree.readScriptsAtRef` so the wire
// method-set stays identical to v1.0.0 - a new method name fatally fails the
// equal-set handshake against an already-shipped host. See the RPC backward-compat
// decision log.
export const worktreeListByWorkspacePathsV11 = defineRpcContract({
  method: "worktree.listByWorkspacePaths",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: worktreeListByWorkspacePathsRequestSchemaV11,
  responseSchema: worktreeListByWorkspacePathsResponseSchemaV11,
});

// Additive upgrade from v1.0: an older peer carries no ref-scripts, so the new
// fields default to empty. The newer side runs this when bridging a v1.0 peer up
// to canonical (host: inbound v1.0 request; client: inbound v1.0 response).
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

// v1.2 adds `forceRefresh`, the manual-refresh escape hatch over the
// minutes-scale TTL cache `WorktreeService` now serves `listForWorkspace`
// summaries from. Response shape is identical to v1.1.
export const worktreeListByWorkspacePathsV12 = defineRpcContract({
  method: "worktree.listByWorkspacePaths",
  schemaVersion: { major: 1, minor: 2 } as const,
  requestSchema: worktreeListByWorkspacePathsRequestSchemaV12,
  responseSchema: worktreeListByWorkspacePathsResponseSchemaV12,
});

// Additive upgrade from v1.1: an older peer never asks for a forced
// recompute, so the request defaults `forceRefresh: false` (cached-read
// behavior, unchanged from what v1.1 always did). The response is passed
// through unchanged.
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

// A v1.2 host predates `resolvedAt` and never emits one, so its rows bridge to
// the resolved sentinel (NOT `null`): its summaries are authoritative, and
// stamping `null` would strand every folder as perpetually pending in the home
// workspace selector (non-selectable, no git eligibility). See
// LEGACY_HOST_RESOLVED_AT.
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

export const worktreeListBranchesV10 = defineRpcContract({
  method: "worktree.listBranches",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: worktreeListBranchesRequestSchema,
  responseSchema: worktreeListBranchesResponseSchema,
});

export const worktreeCreateV10 = defineRpcContract({
  method: "worktree.create",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: worktreeCreateRequestSchema,
  responseSchema: worktreeCreateResponseSchema,
});

export const worktreeCreatePathsV10 = defineRpcContract({
  method: "worktree.createPaths",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: worktreeCreatePathsRequestSchema,
  responseSchema: worktreeCreatePathsResponseSchema,
});

export const worktreeImportV10 = defineRpcContract({
  method: "worktree.import",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: worktreeImportRequestSchema,
  responseSchema: worktreeImportResponseSchema,
});

// Per-folder mode flip. Only "local" is settable through this RPC -
// transitions into "worktree" go through `worktree.create` /
// `worktree.import`, which already write per-entry mode and carry the
// branch / worktreePath the entry needs.
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

// Host-wide worktree surface for Settings ▸ Worktrees. `listAllForHost`
// is a disk walk of `~/.traycer/worktrees/` (surfaces orphans);
// `deleteByPath` is path-keyed and resolves the main repo from the worktree
// path itself, so it works without an epic/workspace context.
export const worktreeListAllForHostV10 = defineRpcContract({
  method: "worktree.listAllForHost",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: worktreeListAllForHostRequestSchema,
  responseSchema: worktreeListAllForHostResponseSchema,
});

// v1.1 adds caller-bounded pagination (`cursor`, `limit`, `nextCursor`), the
// staleness signals (`includeActivity` request flag; per-entry `lastActivityAt`,
// `owners`, `branchStatus`, `createdAt`) the housekeeping skill and Settings ▸
// Worktrees tab consume, plus the `activityPaths` request field for per-viewport
// lazy enrichment (enrich only the requested rows, no matter `includeActivity`).
// Folded onto this existing method - never a new method name - so the wire
// method-set stays identical to v1.0.0; see `worktreeListByWorkspacePathsV11`
// and the RPC backward-compat decision log.
export const worktreeListAllForHostV11 = defineRpcContract({
  method: "worktree.listAllForHost",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: worktreeListAllForHostRequestSchemaV11,
  responseSchema: worktreeListAllForHostResponseSchemaV11,
});

// v1.2 adds `submodules[].atPinnedCommit`, a positive proof that the submodule
// branch/tip equals the superproject's pinned gitlink. Request shape is
// identical to v1.1.
export const worktreeListAllForHostV12 = defineRpcContract({
  method: "worktree.listAllForHost",
  schemaVersion: { major: 1, minor: 2 } as const,
  requestSchema: worktreeListAllForHostRequestSchemaV12,
  responseSchema: worktreeListAllForHostResponseSchemaV12,
});

// Additive upgrade from v1.0: an older peer neither asks for activity nor
// carries pagination posture or the enriched fields, so the request defaults
// `includeActivity: false`, `activityPaths: null` (whole-list mode, no
// per-viewport selection), `cursor: null`, and `limit: null`. Each response
// entry defaults empty `owners` / `null` timestamps & `branchStatus`, plus the
// merge-provenance fields (PR bundle and `submodules`) default to their absent
// shape (`null` / `false` / `[]`), and `nextCursor: null` marks the upgraded
// full-list response exhausted. The
// newer side runs this when bridging a v1.0 peer up to canonical (host: inbound
// v1.0 request; client: inbound v1.0 response).
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

// v1.3 adds `forceRefresh`, the manual-refresh escape hatch over the
// minutes-scale TTL cache `WorktreeService` now serves the disk-truth
// enumeration + per-worktree status from. Response shape is identical to
// v1.2.
export const worktreeListAllForHostV13 = defineRpcContract({
  method: "worktree.listAllForHost",
  schemaVersion: { major: 1, minor: 3 } as const,
  requestSchema: worktreeListAllForHostRequestSchemaV13,
  responseSchema: worktreeListAllForHostResponseSchemaV13,
});

// Additive upgrade from v1.2: an older peer never asks for a forced
// recompute, so the request defaults `forceRefresh: false` (cached-read
// behavior, unchanged from what v1.2 always did). The response is passed
// through unchanged.
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

// A v1.3 host predates `resolvedAt` and never emits one, so its rows bridge to
// the resolved sentinel (NOT `null`): stamping `null` would strand every
// worktree in the settings panel as perpetually "checking" - non-selectable,
// non-deletable, no enrichment ever accepted by the staleness merge. Every row
// from the legacy host shares the same sentinel, so that merge's timestamp
// comparison degrades to a no-op accept. See LEGACY_HOST_RESOLVED_AT.
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

export const worktreeSetRepoScriptsV10 = defineRpcContract({
  method: "worktree.setRepoScripts",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: worktreeSetRepoScriptsRequestSchema,
  responseSchema: worktreeSetRepoScriptsResponseSchema,
});

// `worktree.getBinding@1.0` - owner-scoped binding read used by GUI surfaces
// that do not subscribe to a chat (TUI-agent toolbar). Returns `null`
// when the orchestrator has no row yet so the chip can render "not selected"
// without a special-case error path.
export const worktreeGetBindingV10 = defineRpcContract({
  method: "worktree.getBinding",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: worktreeGetBindingRequestSchema,
  responseSchema: worktreeGetBindingResponseSchema,
});

// `providers.*@1.0` - per-device provider CLI resolution. Lists each
// provider's resolved binary path + version, lets the user override the
// binary per provider, and previews a candidate-path version without
// committing it. Schemas live in `protocol/host/provider-schemas.ts`.
// `providers.list` always returns every provider; v1.0 is frozen without the
// ACP GUI harness providers, v2.0 carries them, and the v2→v1 bridge drops them
// for v1.0 clients.
export const providersListV10 = defineRpcContract({
  method: "providers.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersListRequestSchema,
  responseSchema: providersListResponseSchemaV10,
});

export const providersListV20 = defineRpcContract({
  method: "providers.list",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: providersListRequestSchema,
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

// Accepts either the live (latest) state or the frozen v2.0 state - see
// `downgradeProviderCliStateToV10`'s comment. `providersListDowngradeV2ToV1`
// downgrades from v2.0 (already `profiles`-free); every other caller
// downgrades from the live state.
function downgradeProviderStateForV10(
  state: Omit<ProviderCliState, "profiles" | "loginCapability"> & {
    profiles?: ProviderCliState["profiles"];
    loginCapability:
      ProviderLoginCapability | ProviderLoginCapabilityV10 | null;
  },
): DowngradeResult<ProviderCliStateV10> {
  const downgraded = downgradeProviderCliStateToV10(state);
  if (downgraded === null) {
    return unsupportedProviderStateDowngrade(state.providerId);
  }
  return { ok: true, value: downgraded };
}

function downgradeProviderStateListForV10(
  states: readonly (Omit<ProviderCliState, "profiles" | "loginCapability"> & {
    profiles?: ProviderCliState["profiles"];
    loginCapability:
      ProviderLoginCapability | ProviderLoginCapabilityV10 | null;
  })[],
): ProviderCliStateV10[] {
  return states.flatMap((state) => {
    const downgraded = downgradeProviderCliStateToV10(state);
    return downgraded === null ? [] : [downgraded];
  });
}

// Upgrades a v1.0 state to the frozen major-2 mutation-response shape -
// shared by every provider.* state-echo mutation's v1.0 -> v2.0 bridge
// (`providers.list` freezes its own v2.0 shape and upgrades via
// `upgradeProviderCliStateV10ToV20` inline below instead). Like the v1.0
// host itself, the frozen 2.0 shape predates `profiles`; each method's
// 2.0 -> 2.1 upgrade fills `profiles: []` for the caller's canonical.
function upgradeProviderStateFromV10(
  state: ProviderCliStateV10,
): ProviderMutationCliStateV20 {
  return upgradeProviderCliStateV10ToMutationV20(state);
}

// Fills the code-paste capability slot a frozen pre-`codePaste` state (v1.0,
// v2.0, v3.0) never carries - same "old host never had this feature"
// semantics as the `profiles: []` fill these upgrade bridges already apply
// to the same state. Every v2.0 -> v2.1 (and v3.0 -> v4.0) response upgrade
// that lifts a frozen state onto the live `ProviderCliState` shape must call
// this alongside its `profiles: []` fill, or the live shape's `codePaste`
// key is silently absent on the wire (`upgradeResponseToVersion` chains
// these callbacks by cast, with no re-parse step to apply `.catch(null)`).
function upgradeLoginCapabilityFromV10(
  loginCapability: ProviderLoginCapabilityV10 | null,
): ProviderLoginCapability | null {
  return loginCapability === null
    ? null
    : { ...loginCapability, codePaste: null };
}

function downgradeProviderRequestForV10<T>(
  schema: {
    safeParse: (
      value: unknown,
    ) => { success: true; data: T } | { success: false };
  },
  request: { readonly providerId: ProviderCliState["providerId"] },
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
  requestSchema: providersListRequestSchema,
  responseSchema: providersListResponseSchemaV30,
});

export const providersListUpgradeV2ToV3 = defineUpgradePath<
  typeof providersListV20,
  typeof providersListV30
>({
  from: { major: 2, minor: 0 },
  to: { major: 3, minor: 0 },
  // A v2.0 response without Amp is a valid v3.0 response, and the request
  // shape is identical - both upgrades are identity. (`profiles` belongs to
  // the v4.0 line; the v3→v4 upgrade below fills it.)
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

export const providersListV40 = defineRpcContract({
  method: "providers.list",
  schemaVersion: { major: 4, minor: 0 } as const,
  requestSchema: providersListRequestSchema,
  responseSchema: providersListResponseSchema,
});

export const providersListUpgradeV3ToV4 = defineUpgradePath<
  typeof providersListV30,
  typeof providersListV40
>({
  from: { major: 3, minor: 0 },
  to: { major: 4, minor: 0 },
  // The request shape is identical - the request upgrade is identity. The
  // response gains `profiles`, which ships with the v4.0 line: every host on
  // the v3.0 line (and below) predates it, so its providers upgrade to
  // `profiles: []` (same "old host never had this feature" semantics as the
  // v1.0 -> v2.0 `availabilityPending` fill above). Devin/Pi absence needs no
  // transform - a v3.0 provider set is a valid v4.0 subset.
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
  downgradeRequest: (request) => ({ ok: true, value: request }),
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
  downgradeRequest: (request) => ({ ok: true, value: request }),
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

// v2.1 carries the live state shape - `profiles` ships with the 2.1 line
// (the released 2.0 response above is frozen pre-profiles), so a released
// 2.0 host's response upgrades to `profiles: []` ("old host never had this
// feature"). The request is unchanged.
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

// Bridges from v2.1 (the latest installed version of major 2's line) down
// to the frozen v1.0 - not from v2.0, since v2.1 supersedes it as major 2's
// latest.
export const providersSetSelectionDowngradeV2ToV1 = defineDowngradePath<
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

// v2.1 carries the live state shape - `profiles` ships with the 2.1 line
// (the released 2.0 response above is frozen pre-profiles), so a released
// 2.0 host's response upgrades to `profiles: []` ("old host never had this
// feature"). The request is unchanged.
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

// Bridges from v2.1 (the latest installed version of major 2's line) down
// to the frozen v1.0 - not from v2.0, since v2.1 supersedes it as major 2's
// latest.
export const providersAddCustomPathDowngradeV2ToV1 = defineDowngradePath<
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

// v2.1 carries the live state shape - `profiles` ships with the 2.1 line
// (the released 2.0 response above is frozen pre-profiles), so a released
// 2.0 host's response upgrades to `profiles: []` ("old host never had this
// feature"). The request is unchanged.
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

// Bridges from v2.1 (the latest installed version of major 2's line) down
// to the frozen v1.0 - not from v2.0, since v2.1 supersedes it as major 2's
// latest.
export const providersRemoveCustomPathDowngradeV2ToV1 = defineDowngradePath<
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
  requestSchema: providersStartLoginRequestSchema,
  responseSchema: providersStartLoginResponseSchema,
});

// v1.1 adds `profileId` / `createProfile` to the request and `profileId` to
// the response - re-authenticate an existing managed profile, or mint a
// brand-new one, instead of a standalone `providers.createProfile` method (a
// new method name fatally fails the released-peer equal-set handshake, see
// `worktree.listBindingsForEpic@1.1`'s note and the multi-profile decision
// log). Shipped as a minor (not an in-place edit to v1.0): both new fields
// default to `null`, which is byte-identical to today's request/response, so
// a v1.0.0 host still negotiates and old clients are unaffected.
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
  upgradeResponse: (response) => ({ ...response, profileId: null }),
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
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    state:
      response.state === null
        ? null
        : upgradeProviderStateFromV10(response.state),
  }),
});

// v2.1 adds `profileId` to the request (await the same profile-scoped login
// child `providers.startLogin@1.1` started) and, on the response, `profiles`
// on the echoed state plus `existingProfileId` (duplicate-account detection
// for create-profile logins). The released 2.0 shapes above are frozen
// without all three; this upgrade fills the "old host never had this
// feature" defaults.
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
  upgradeRequest: (request) => ({ ...request, profileId: null }),
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

// Bridges from v2.1 (the latest installed version of major 2's line) down
// to the frozen v1.0 - not from v2.0, since v2.1 supersedes it as major 2's
// latest.
export const providersAwaitLoginDowngradeV2ToV1 = defineDowngradePath<
  typeof providersAwaitLoginV21,
  typeof providersAwaitLoginV10
>({
  from: { major: 2, minor: 1 },
  to: { major: 1, minor: 0 },
  // Drop `profileId` before the parse: `providersAwaitLoginRequestSchemaV10`
  // is a strict object that never learned it, so passing the full request
  // through would fail the strict parse and drop the whole downgrade.
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
  requestSchema: providersCancelLoginRequestSchema,
  responseSchema: providersCancelLoginResponseSchema,
});

// v1.1 adds `profileId`, mirroring `providers.startLogin@1.1` - cancel the
// same profile-scoped login child that was started. Shipped as a minor (not
// an in-place edit to v1.0): `profileId` defaults to `null`, so a v1.0.0
// host still negotiates and old clients are unaffected.
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
  upgradeRequest: (request) => ({ ...request, profileId: null }),
  upgradeResponse: (response) => response,
});

/**
 * Brand-new v1.0 method (not part of `RELEASED_FLOOR_METHOD_NAMES` - this
 * whole code-paste surface is unreleased), registered below with
 * `degrade: { kind: "unsupported" }`: an old host simply lacks it, and
 * callers get per-call upgrade guidance instead of a fatal handshake
 * mismatch (see `agent/profiles.ts`'s note on the same pattern).
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

export const providersSetEnabledV10 = defineRpcContract({
  method: "providers.setEnabled",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersSetEnabledRequestSchemaV10,
  responseSchema: providersSetEnabledResponseSchemaV10,
});

export const providersSetEnabledV20 = defineRpcContract({
  method: "providers.setEnabled",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: providersSetEnabledRequestSchema,
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

// v2.1 adds `profileAction` (discriminated rename/remove/recolor of a profile) to
// the request - folded onto this existing "administer this provider's
// configuration" mutation instead of standalone `providers.renameProfile` /
// `removeProfile` / `recolorProfile` methods, because a new method name fatally fails the
// released-peer equal-set handshake (see `worktree.listBindingsForEpic@1.1`'s
// note and `released-surface-compat.test.ts`). Chosen over the other
// provider.* mutations because its response already returns the full
// `ProviderCliState` (so the mutated `profiles[]` is visible for free) and
// it is already the closest thing to a generic per-provider admin action -
// the CLI-path (`setSelection`/`addCustomPath`), credential
// (`setApiKey`/`clearApiKey`), and login-lifecycle (`startLogin`/
// `awaitLogin`/`cancelLogin`) methods all have narrower, unrelated
// semantics. `recolor` rides the same unreleased profile-management surface
// because profile colors are host-owned profile metadata. `profileAction:
// null` is byte-identical to today's plain enable/disable request, so a v2.0
// client is unaffected.
export const providersSetEnabledV21 = defineRpcContract({
  method: "providers.setEnabled",
  schemaVersion: { major: 2, minor: 1 } as const,
  requestSchema: providersSetEnabledRequestSchemaV21,
  responseSchema: providersSetEnabledResponseSchema,
});

export const providersSetEnabledUpgradeV20ToV21 = defineUpgradePath<
  typeof providersSetEnabledV20,
  typeof providersSetEnabledV21
>({
  from: { major: 2, minor: 0 },
  to: { major: 2, minor: 1 },
  upgradeRequest: (request) => ({ ...request, profileAction: null }),
  // The released 2.0 response is frozen pre-profiles; the 2.1 response is the
  // live state shape, so a 2.0 host's echo upgrades to `profiles: []`.
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

// Bridges from v2.1 (the latest installed version of major 2's line) down to
// the frozen v1.0 - not from v2.0, since v2.1 supersedes it as major 2's
// latest.
export const providersSetEnabledDowngradeV2ToV1 = defineDowngradePath<
  typeof providersSetEnabledV21,
  typeof providersSetEnabledV10
>({
  from: { major: 2, minor: 1 },
  to: { major: 1, minor: 0 },
  // Drop `profileAction` before the parse: `providersSetEnabledRequestSchemaV10`
  // is a strict object that never learned it, so passing the full request
  // through would fail the strict parse and drop the whole downgrade.
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

// v2.1 carries the live state shape - `profiles` ships with the 2.1 line
// (the released 2.0 response above is frozen pre-profiles), so a released
// 2.0 host's response upgrades to `profiles: []` ("old host never had this
// feature"). The request is unchanged.
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

// Bridges from v2.1 (the latest installed version of major 2's line) down
// to the frozen v1.0 - not from v2.0, since v2.1 supersedes it as major 2's
// latest.
export const providersSetApiKeyDowngradeV2ToV1 = defineDowngradePath<
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

// v2.1 carries the live state shape - `profiles` ships with the 2.1 line
// (the released 2.0 response above is frozen pre-profiles), so a released
// 2.0 host's response upgrades to `profiles: []` ("old host never had this
// feature"). The request is unchanged.
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

// Bridges from v2.1 (the latest installed version of major 2's line) down
// to the frozen v1.0 - not from v2.0, since v2.1 supersedes it as major 2's
// latest.
export const providersClearApiKeyDowngradeV2ToV1 = defineDowngradePath<
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

// v2.1 carries the live state shape - `profiles` ships with the 2.1 line
// (the released 2.0 response above is frozen pre-profiles), so a released
// 2.0 host's response upgrades to `profiles: []` ("old host never had this
// feature"). The request is unchanged.
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

// Bridges from v2.1 (the latest installed version of major 2's line) down
// to the frozen v1.0 - not from v2.0, since v2.1 supersedes it as major 2's
// latest.
export const providersSetTerminalAgentArgsDowngradeV2ToV1 = defineDowngradePath<
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

// v2.1 carries the live state shape - `profiles` ships with the 2.1 line
// (the released 2.0 response above is frozen pre-profiles), so a released
// 2.0 host's response upgrades to `profiles: []` ("old host never had this
// feature"). The request is unchanged.
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

// Bridges from v2.1 (the latest installed version of major 2's line) down
// to the frozen v1.0 - not from v2.0, since v2.1 supersedes it as major 2's
// latest.
export const providersSetEnvOverrideDowngradeV2ToV1 = defineDowngradePath<
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

// v2.1 carries the live state shape - `profiles` ships with the 2.1 line
// (the released 2.0 response above is frozen pre-profiles), so a released
// 2.0 host's response upgrades to `profiles: []` ("old host never had this
// feature"). The request is unchanged.
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

// Bridges from v2.1 (the latest installed version of major 2's line) down
// to the frozen v1.0 - not from v2.0, since v2.1 supersedes it as major 2's
// latest.
export const providersDeleteEnvOverrideDowngradeV2ToV1 = defineDowngradePath<
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

// v1.1 adds `folderlessCwd` - the host-owned fallback cwd for terminal
// launches on an epic with no bound workspace rows. Folded onto this existing
// method instead of a standalone `terminal.defaultCwd` so the wire method-set
// stays identical to v1.0.0 - a new method name fatally fails the equal-set
// handshake against an already-shipped host. See the RPC backward-compat
// decision log.
export const worktreeListBindingsForEpicV11 = defineRpcContract({
  method: "worktree.listBindingsForEpic",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: worktreeListBindingsForEpicRequestSchema,
  responseSchema: worktreeListBindingsForEpicResponseSchemaV11,
});

// Additive upgrade from v1.0: an old host that predates folderless workspaces,
// so there is no fallback cwd to synthesize - `null` tells the picker to keep
// its folderless launch action disabled. The newer side runs this when
// bridging a v1.0 peer up to canonical (host: inbound v1.0 request; client:
// inbound v1.0 response).
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

// v1.2 adds per-row `isGitResolvePending`, the host's authoritative signal
// that a row's git facts (`isGitRepo` and the `missing_worktree_path` reason
// derived from it) are still an unverified placeholder - pickers render such
// rows as pending ("checking") instead of dead.
export const worktreeListBindingsForEpicV12 = defineRpcContract({
  method: "worktree.listBindingsForEpic",
  schemaVersion: { major: 1, minor: 2 } as const,
  requestSchema: worktreeListBindingsForEpicRequestSchema,
  responseSchema: worktreeListBindingsForEpicResponseSchemaV12,
});

// Additive upgrade from v1.1: a v1.1 host has no pending concept and never
// emits a signal that would later clear it, so every bridged row is stamped
// `isGitResolvePending: false` - the old host's answer is authoritative and
// must render as-is (its truthful `not git` / `missing` label, and the
// recoverable empty-state), NOT as perpetual "checking". Bridging to `true`
// would strand every correctly-resolved old-host row in a pending state that
// never converges against a v1.1 host.
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

const HOST_RPC_REGISTRY_DEFINITION = {
  "host.status": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostStatusV10,
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
  "host.notifications.list": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostNotificationsList,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
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
  "host.notifications.indicatorState": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostNotificationsIndicatorState,
          upgradeFromPreviousVersion: null,
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
      latestMinor: 0,
      versions: {
        0: {
          contract: agentTuiPrepareLaunchV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
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
      latestMinor: 1,
      versions: {
        0: {
          contract: epicListTasksV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: epicListTasksV11,
          upgradeFromPreviousVersion: epicListTasksUpgradeV10ToV11,
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
  // Optional (non-floor): batch task-context by id for title resolution.
  // Old peers lack it in their optional manifest; callers get
  // E_HOST_UNSUPPORTED for this call only and degrade to cache-only titles.
  "epic.getTaskContexts": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicGetTaskContextsV10,
          upgradeFromPreviousVersion: null,
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
      latestMinor: 0,
      versions: {
        0: {
          contract: workspacePrepareFoldersV10,
          upgradeFromPreviousVersion: null,
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
      latestMinor: 0,
      versions: {
        0: {
          contract: epicCreateChatV10,
          upgradeFromPreviousVersion: null,
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
  // Old peers lack it in their optional manifest; callers get
  // E_HOST_UNSUPPORTED for this call only and degrade to the legacy
  // persist-on-next-send behavior.
  "epic.updateChatRunSettings": {
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: epicUpdateChatRunSettingsV10,
          upgradeFromPreviousVersion: null,
        },
        // v1.1: wire-strict settings tuple - a subset-field patch fails
        // validation at the canonical minor instead of silently null-
        // clobbering omitted fields. Profile-only changes belong on
        // `epic.updateChatProfile`.
        1: {
          contract: epicUpdateChatRunSettingsV11,
          upgradeFromPreviousVersion: epicUpdateChatRunSettingsUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
    degrade: { kind: "unsupported" },
  },
  // Optional (non-floor) capability: narrow profile-only update of a chat's
  // persisted run settings - the host patches its own authoritative tuple, so
  // clients never rebuild (and stale-patch) the full tuple to move a chat's
  // profile. Old peers lack it; callers get E_HOST_UNSUPPORTED for this call
  // only and degrade to persist-on-next-send.
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
  "epic.createTuiAgent": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicCreateTuiAgentV10,
          upgradeFromPreviousVersion: null,
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
  "editor.openPaths": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: editorOpenPathsV10,
          upgradeFromPreviousVersion: null,
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
  // `getFileDiff` / `getFileDiffs` stay v1.0-only: the submodule work needs no
  // request changes (working-tree files diff stage-based against the submodule
  // repo root), so there is no v1.1 for these methods.
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
      latestMinor: 0,
      versions: {
        0: {
          contract: terminalCreateV20,
          upgradeFromPreviousVersion: terminalCreateUpgradeV10ToV20,
        },
      },
      downgradePathsFromLatest: { 1: terminalCreateDowngradeV20ToV10 },
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
      latestMinor: 0,
      versions: {
        0: {
          contract: terminalListV20,
          upgradeFromPreviousVersion: terminalListUpgradeV10ToV20,
        },
      },
      downgradePathsFromLatest: { 1: terminalListDowngradeV20ToV10 },
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
  "worktree.listByWorkspacePaths": {
    1: {
      latestMinor: 3,
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
      latestMinor: 0,
      versions: {
        0: {
          contract: worktreeCreateV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "worktree.createPaths": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: worktreeCreatePathsV10,
          upgradeFromPreviousVersion: null,
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
      latestMinor: 0,
      versions: {
        0: {
          contract: worktreeDeleteV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "worktree.listAllForHost": {
    1: {
      latestMinor: 4,
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
      downgradePathsFromLatest: { 1: providersSetSelectionDowngradeV2ToV1 },
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
      downgradePathsFromLatest: { 1: providersAddCustomPathDowngradeV2ToV1 },
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
      downgradePathsFromLatest: { 1: providersRemoveCustomPathDowngradeV2ToV1 },
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
      downgradePathsFromLatest: { 1: providersAwaitLoginDowngradeV2ToV1 },
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
      downgradePathsFromLatest: { 1: providersSetApiKeyDowngradeV2ToV1 },
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
      downgradePathsFromLatest: { 1: providersClearApiKeyDowngradeV2ToV1 },
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
        1: providersSetTerminalAgentArgsDowngradeV2ToV1,
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
      downgradePathsFromLatest: { 1: providersSetEnvOverrideDowngradeV2ToV1 },
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
        1: providersDeleteEnvOverrideDowngradeV2ToV1,
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
      downgradePathsFromLatest: { 1: providersSetEnabledDowngradeV2ToV1 },
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
  // `speech.*@1.0` - on-device dictation model lifecycle. The live audio
  // stream rides `speech.dictate` in `hostStreamRpcRegistry` below; these
  // unary methods only manage the recognizer's model files. Schemas live in
  // `protocol/host/speech/`.
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
  },
} as const;

export const hostRpcRegistry = defineFloorAwareVersionedRpcRegistry(
  RELEASED_FLOOR_METHOD_NAMES,
  HOST_RPC_REGISTRY_DEFINITION,
);

export type HostRpcRegistry = typeof hostRpcRegistry;

/**
 * Combined streaming-RPC registry for the `/stream` WS manifest.
 *
 * One manifest per `/stream` WS: `epic.subscribe@1.0`,
 * `chat.subscribe@1.3`, `notifications.subscribe@1.0`,
 * `terminal.subscribe@1.0`, `git.subscribeStatus@1.1`,
 * `resources.subscribe@1.0`, `agent.inbox.subscribe@1.0`,
 * `speech.dictate@1.0`, and
 * `migration.run@1.0` are negotiated from this registry. Later minors within
 * the same major line must be
 * additive; later majors must carry a real breaking change and ship without a
 * cross-major downgrade bridge (streams reconnect on mismatched majors in v1).
 *
 * Growth rules mirror `hostRpcRegistry` above:
 *
 * 1. Add new methods as top-level keys.
 * 2. Add new minors within a major line for additive changes.
 * 3. Add new majors only when a sub-schema actually breaks compatibility -
 *    and never for a shipped method with a peer still in the field, since a
 *    stream major bump has no downgrade bridge (see `chat.subscribe`'s
 *    history: `1.0` is frozen and kept registered forever; `1.1` added
 *    background-items controls as an additive minor instead of a major, to
 *    stay compatible with host-v1.0.0).
 */
export const hostStreamRpcRegistry = defineVersionedStreamRpcRegistry({
  "epic.subscribe": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicSubscribeV10,
        },
      },
    },
  },
  "chat.subscribe": {
    1: {
      latestMinor: 4,
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
      },
    },
  },
  "notifications.subscribe": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: notificationsSubscribeV10,
        },
      },
    },
  },
  "host.notifications.subscribe": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: hostNotificationsSubscribe,
        },
      },
    },
  },
  "terminal.subscribe": {
    1: {
      latestMinor: 4,
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
      },
    },
  },
  "git.subscribeStatus": {
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: gitSubscribeStatusV10,
        },
        // Nested-snapshot minor: `submodules[]` + `nestedFingerprint` + v1.1
        // file rows on server frames. Additive; the HOST resolver projects
        // frames per negotiated minor (streams have no version bridges). See
        // the COMPAT POSTURE note on `gitSubscribeStatusV11`.
        1: {
          contract: gitSubscribeStatusV11,
        },
      },
    },
  },
  "resources.subscribe": {
    1: {
      latestMinor: 2,
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
      },
    },
  },
  "agent.inbox.subscribe": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: agentInboxSubscribeV10,
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
  "worktree.deleteByPath": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: worktreeDeleteByPathStreamV10,
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
});

export type HostStreamRpcRegistry = typeof hostStreamRpcRegistry;
