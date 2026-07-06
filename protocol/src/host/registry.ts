import {
  defineDowngradePath,
  defineUpgradePath,
  defineVersionedRpcRegistry,
  type DowngradeResult,
} from "@traycer/protocol/framework/index";
import { defineVersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  agentCreateV10,
  agentGetTranscriptV10,
  agentListHarnessModelsDowngradeV2ToV1,
  agentListHarnessModelsV10,
  agentListHarnessModelsV20,
  agentListHarnessModelsUpgradeV1ToV2,
  agentListDowngradeV2ToV1,
  agentListUpgradeV1ToV2,
  agentListV10,
  agentListV20,
  agentSelectionGuideV10,
  agentSelectionGuideGlobalGetV10,
  agentSelectionGuideGlobalOnboardingDraftGetV10,
  agentSelectionGuideGlobalResetV10,
  agentSelectionGuideGlobalSetV10,
  agentSendMessageV10,
  agentStopV10,
} from "@traycer/protocol/host/agent/contracts";
import {
  agentInboxReadV10,
  agentInboxSubscribeV10,
} from "@traycer/protocol/host/agent/inbox";
import {
  agentGuiGetPlanV10,
  agentGuiListCommandsV10,
  agentGuiListHarnessesDowngradeV2ToV1,
  agentGuiListHarnessesUpgradeV1ToV2,
  agentGuiListHarnessesV10,
  agentGuiListHarnessesV20,
  agentGuiListModelsV10,
  chatSubscribeV10,
  chatSubscribeV11,
  chatSubscribeV12,
} from "@traycer/protocol/host/agent/gui/contracts";
import {
  agentTuiGenerateTitleV10,
  agentTuiTurnEndedV10,
  agentTuiListHarnessesV10,
  agentTuiPrepareLaunchV10,
  agentTuiRecordActivityV10,
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
  hostGetRateLimitUsageUpgradeV10ToV11,
  hostGetRateLimitUsageUpgradeV11ToV12,
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
  epicGrantAccessV10,
  epicListCollaboratorsV10,
  epicListCommentThreadsV10,
  epicListTasksV10,
  epicMentionEpicsV10,
  epicMentionReviewsV10,
  epicMentionSpecsV10,
  epicMentionStoriesV10,
  epicMentionTicketsV10,
  epicRemoveRepoV10,
  epicRenameArtifactV10,
  epicRenameChatV10,
  epicRenameTuiAgentV10,
  epicReparentArtifactV10,
  epicReparentChatV10,
  epicReplyToCommentThreadV10,
  epicResolveArtifactByPathV10,
  epicRevokeCollaboratorV10,
  epicSetCommentThreadResolvedV10,
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
  terminalCreateV10,
  terminalKillV10,
  terminalListV10,
  terminalRenameV10,
  terminalSubscribeV10,
  terminalSubscribeV11,
  terminalSubscribeV12,
  terminalSubscribeV13,
} from "@traycer/protocol/host/terminal/contracts";
import { notificationsSubscribeV10 } from "@traycer/protocol/host/notifications/contracts";
import { resourcesSubscribeV10 } from "@traycer/protocol/host/resources/subscribe";
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
import { editorOpenPathsV10 } from "@traycer/protocol/host/editor/contracts";
import {
  gitListChangedFilesV10,
  gitListChangedFilesV11,
  gitListChangedFilesUpgradeV10ToV11,
  gitGetFileDiffV10,
  gitGetFileDiffsV10,
  gitGetCapabilitiesV10,
  gitSubscribeStatusV10,
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
  worktreeImportRequestSchema,
  worktreeImportResponseSchema,
  worktreeListBranchesRequestSchema,
  worktreeListBranchesResponseSchema,
  worktreeListByWorkspacePathsRequestSchema,
  worktreeListByWorkspacePathsResponseSchema,
  worktreeListByWorkspacePathsRequestSchemaV11,
  worktreeListByWorkspacePathsResponseSchemaV11,
  worktreeListBindingsForEpicRequestSchema,
  worktreeListBindingsForEpicResponseSchema,
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
  providersAwaitLoginRequestSchema,
  providersAwaitLoginRequestSchemaV10,
  providersAwaitLoginResponseSchema,
  providersAwaitLoginResponseSchemaV10,
  providersCancelLoginRequestSchema,
  providersCancelLoginResponseSchema,
  providersClearApiKeyRequestSchema,
  providersClearApiKeyRequestSchemaV10,
  providersClearApiKeyResponseSchema,
  providersClearApiKeyResponseSchemaV10,
  providersDeleteEnvOverrideRequestSchema,
  providersDeleteEnvOverrideRequestSchemaV10,
  providersDeleteEnvOverrideResponseSchema,
  providersDeleteEnvOverrideResponseSchemaV10,
  providersDetectVersionRequestSchema,
  providersDetectVersionResponseSchema,
  providersStartLoginRequestSchema,
  providersStartLoginResponseSchema,
  providersListRequestSchema,
  providersListResponseSchemaV10,
  providersListResponseSchemaV20,
  downgradeProviderCliStateV20ToV10,
  upgradeProviderCliStateV10ToV20,
  providersRemoveCustomPathRequestSchema,
  providersRemoveCustomPathRequestSchemaV10,
  providersRemoveCustomPathResponseSchema,
  providersRemoveCustomPathResponseSchemaV10,
  providersSetApiKeyRequestSchema,
  providersSetApiKeyRequestSchemaV10,
  providersSetApiKeyResponseSchema,
  providersSetApiKeyResponseSchemaV10,
  providersSetEnabledRequestSchema,
  providersSetEnabledRequestSchemaV10,
  providersSetEnabledResponseSchema,
  providersSetEnabledResponseSchemaV10,
  providersSetEnvOverrideRequestSchema,
  providersSetEnvOverrideRequestSchemaV10,
  providersSetEnvOverrideResponseSchema,
  providersSetEnvOverrideResponseSchemaV10,
  providersSetSelectionRequestSchema,
  providersSetSelectionRequestSchemaV10,
  providersSetSelectionResponseSchema,
  providersSetSelectionResponseSchemaV10,
  providersSetTerminalAgentArgsRequestSchema,
  providersSetTerminalAgentArgsRequestSchemaV10,
  providersSetTerminalAgentArgsResponseSchema,
  providersSetTerminalAgentArgsResponseSchemaV10,
  type ProviderCliState,
  type ProviderCliStateV10,
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

function downgradeProviderStateForV10(
  state: ProviderCliState,
): DowngradeResult<ProviderCliStateV10> {
  const downgraded = downgradeProviderCliStateV20ToV10(state);
  if (downgraded === null) {
    return unsupportedProviderStateDowngrade(state.providerId);
  }
  return { ok: true, value: downgraded };
}

function downgradeProviderStateListForV10(
  states: readonly ProviderCliState[],
): ProviderCliStateV10[] {
  return states.flatMap((state) => {
    const downgraded = downgradeProviderCliStateV20ToV10(state);
    return downgraded === null ? [] : [downgraded];
  });
}

function upgradeProviderStateFromV10(
  state: ProviderCliStateV10,
): ProviderCliState {
  return upgradeProviderCliStateV10ToV20(state);
}

function upgradeProviderStateListFromV10(
  states: readonly ProviderCliStateV10[],
): ProviderCliState[] {
  return states.map(upgradeProviderCliStateV10ToV20);
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
    providers: upgradeProviderStateListFromV10(response.providers),
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
  responseSchema: providersSetSelectionResponseSchema,
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

export const providersSetSelectionDowngradeV2ToV1 = defineDowngradePath<
  typeof providersSetSelectionV20,
  typeof providersSetSelectionV10
>({
  from: { major: 2, minor: 0 },
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
  responseSchema: providersAddCustomPathResponseSchema,
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

export const providersAddCustomPathDowngradeV2ToV1 = defineDowngradePath<
  typeof providersAddCustomPathV20,
  typeof providersAddCustomPathV10
>({
  from: { major: 2, minor: 0 },
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
  responseSchema: providersRemoveCustomPathResponseSchema,
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

export const providersRemoveCustomPathDowngradeV2ToV1 = defineDowngradePath<
  typeof providersRemoveCustomPathV20,
  typeof providersRemoveCustomPathV10
>({
  from: { major: 2, minor: 0 },
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

export const providersAwaitLoginV10 = defineRpcContract({
  method: "providers.awaitLogin",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersAwaitLoginRequestSchemaV10,
  responseSchema: providersAwaitLoginResponseSchemaV10,
});

export const providersAwaitLoginV20 = defineRpcContract({
  method: "providers.awaitLogin",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: providersAwaitLoginRequestSchema,
  responseSchema: providersAwaitLoginResponseSchema,
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

export const providersAwaitLoginDowngradeV2ToV1 = defineDowngradePath<
  typeof providersAwaitLoginV20,
  typeof providersAwaitLoginV10
>({
  from: { major: 2, minor: 0 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) =>
    downgradeProviderRequestForV10(
      providersAwaitLoginRequestSchemaV10,
      request,
    ),
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
  responseSchema: providersSetEnabledResponseSchema,
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

export const providersSetEnabledDowngradeV2ToV1 = defineDowngradePath<
  typeof providersSetEnabledV20,
  typeof providersSetEnabledV10
>({
  from: { major: 2, minor: 0 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) =>
    downgradeProviderRequestForV10(
      providersSetEnabledRequestSchemaV10,
      request,
    ),
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
  responseSchema: providersSetApiKeyResponseSchema,
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

export const providersSetApiKeyDowngradeV2ToV1 = defineDowngradePath<
  typeof providersSetApiKeyV20,
  typeof providersSetApiKeyV10
>({
  from: { major: 2, minor: 0 },
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
  responseSchema: providersClearApiKeyResponseSchema,
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

export const providersClearApiKeyDowngradeV2ToV1 = defineDowngradePath<
  typeof providersClearApiKeyV20,
  typeof providersClearApiKeyV10
>({
  from: { major: 2, minor: 0 },
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
  responseSchema: providersSetTerminalAgentArgsResponseSchema,
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

export const providersSetTerminalAgentArgsDowngradeV2ToV1 = defineDowngradePath<
  typeof providersSetTerminalAgentArgsV20,
  typeof providersSetTerminalAgentArgsV10
>({
  from: { major: 2, minor: 0 },
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
  responseSchema: providersSetEnvOverrideResponseSchema,
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

export const providersSetEnvOverrideDowngradeV2ToV1 = defineDowngradePath<
  typeof providersSetEnvOverrideV20,
  typeof providersSetEnvOverrideV10
>({
  from: { major: 2, minor: 0 },
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
  responseSchema: providersDeleteEnvOverrideResponseSchema,
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

export const providersDeleteEnvOverrideDowngradeV2ToV1 = defineDowngradePath<
  typeof providersDeleteEnvOverrideV20,
  typeof providersDeleteEnvOverrideV10
>({
  from: { major: 2, minor: 0 },
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

// Note: git contract definitions are imported from git-contracts.ts above
// and registered inline in hostRpcRegistry and hostStreamRpcRegistry below.

export const hostRpcRegistry = defineVersionedRpcRegistry({
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
      latestMinor: 0,
      versions: {
        0: {
          contract: agentGuiListHarnessesV20,
          upgradeFromPreviousVersion: agentGuiListHarnessesUpgradeV1ToV2,
        },
      },
      downgradePathsFromLatest: { 1: agentGuiListHarnessesDowngradeV2ToV1 },
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
      latestMinor: 0,
      versions: {
        0: {
          contract: agentTuiRecordActivityV10,
          upgradeFromPreviousVersion: null,
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
      latestMinor: 0,
      versions: {
        0: {
          contract: epicListTasksV10,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
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
      latestMinor: 1,
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
      latestMinor: 0,
      versions: {
        0: {
          contract: worktreeListAllForHostV10,
          upgradeFromPreviousVersion: null,
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
      latestMinor: 0,
      versions: {
        0: {
          contract: providersSetSelectionV20,
          upgradeFromPreviousVersion: providersSetSelectionUpgradeV1ToV2,
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
      latestMinor: 0,
      versions: {
        0: {
          contract: providersAddCustomPathV20,
          upgradeFromPreviousVersion: providersAddCustomPathUpgradeV1ToV2,
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
      latestMinor: 0,
      versions: {
        0: {
          contract: providersRemoveCustomPathV20,
          upgradeFromPreviousVersion: providersRemoveCustomPathUpgradeV1ToV2,
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
      latestMinor: 0,
      versions: {
        0: {
          contract: providersStartLoginV10,
          upgradeFromPreviousVersion: null,
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
      latestMinor: 0,
      versions: {
        0: {
          contract: providersAwaitLoginV20,
          upgradeFromPreviousVersion: providersAwaitLoginUpgradeV1ToV2,
        },
      },
      downgradePathsFromLatest: { 1: providersAwaitLoginDowngradeV2ToV1 },
    },
  },
  "providers.cancelLogin": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: providersCancelLoginV10,
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
      latestMinor: 0,
      versions: {
        0: {
          contract: providersSetApiKeyV20,
          upgradeFromPreviousVersion: providersSetApiKeyUpgradeV1ToV2,
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
      latestMinor: 0,
      versions: {
        0: {
          contract: providersClearApiKeyV20,
          upgradeFromPreviousVersion: providersClearApiKeyUpgradeV1ToV2,
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
      latestMinor: 0,
      versions: {
        0: {
          contract: providersSetTerminalAgentArgsV20,
          upgradeFromPreviousVersion:
            providersSetTerminalAgentArgsUpgradeV1ToV2,
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
      latestMinor: 0,
      versions: {
        0: {
          contract: providersSetEnvOverrideV20,
          upgradeFromPreviousVersion: providersSetEnvOverrideUpgradeV1ToV2,
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
      latestMinor: 0,
      versions: {
        0: {
          contract: providersDeleteEnvOverrideV20,
          upgradeFromPreviousVersion: providersDeleteEnvOverrideUpgradeV1ToV2,
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
      latestMinor: 0,
      versions: {
        0: {
          contract: providersSetEnabledV20,
          upgradeFromPreviousVersion: providersSetEnabledUpgradeV1ToV2,
        },
      },
      downgradePathsFromLatest: { 1: providersSetEnabledDowngradeV2ToV1 },
    },
  },
  "worktree.listBindingsForEpic": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: worktreeListBindingsForEpicV10,
          upgradeFromPreviousVersion: null,
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
});

export type HostRpcRegistry = typeof hostRpcRegistry;

/**
 * Combined streaming-RPC registry for the `/stream` WS manifest.
 *
 * One manifest per `/stream` WS: `epic.subscribe@1.0`,
 * `chat.subscribe@1.2`, `notifications.subscribe@1.0`,
 * `terminal.subscribe@1.0`, `git.subscribeStatus@1.0`,
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
      latestMinor: 2,
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
  "terminal.subscribe": {
    1: {
      latestMinor: 3,
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
      },
    },
  },
  "git.subscribeStatus": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: gitSubscribeStatusV10,
        },
      },
    },
  },
  "resources.subscribe": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: resourcesSubscribeV10,
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
