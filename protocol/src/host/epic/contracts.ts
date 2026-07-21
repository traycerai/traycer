import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import {
  batchDeleteRequestSchema,
  batchDeleteResponseSchema,
  batchUpdateEpicRolesRequestSchema,
  batchUpdateEpicRolesResponseSchema,
  createArtifactRequestSchema,
  createArtifactResponseSchema,
  createChatRequestSchema,
  createChatResponseSchema,
  createCommentThreadRequestSchema,
  createCommentThreadResponseSchema,
  createEpicRequestSchema,
  createEpicResponseSchema,
  createTuiAgentRequestSchema,
  createTuiAgentResponseSchema,
  deleteArtifactRequestSchema,
  deleteArtifactResponseSchema,
  deleteChatRequestSchema,
  deleteChatResponseSchema,
  deleteCommentRequestSchema,
  deleteCommentResponseSchema,
  deleteCommentThreadRequestSchema,
  deleteCommentThreadResponseSchema,
  deleteTuiAgentRequestSchema,
  deleteTuiAgentResponseSchema,
  editCommentRequestSchema,
  editCommentResponseSchema,
  epicMentionArtifactsRequestSchema,
  epicMentionEpicsRequestSchema,
  epicMentionEpicsResponseSchema,
  epicMentionReviewsResponseSchema,
  epicMentionSpecsResponseSchema,
  epicMentionStoriesResponseSchema,
  epicMentionTicketsResponseSchema,
  grantEpicAccessRequestSchema,
  grantEpicAccessResponseSchema,
  listCommentThreadsRequestSchema,
  listCommentThreadsResponseSchema,
  listEpicCollaboratorsRequestSchema,
  listEpicCollaboratorsResponseSchema,
  getTaskContextsRequestSchema,
  getTaskContextsResponseSchema,
  listTasksRequestSchema,
  listTasksResponseSchema,
  listTasksResponseSchemaV10,
  removeEpicRepoRequestSchema,
  removeEpicRepoResponseSchema,
  resolveArtifactByPathRequestSchema,
  resolveArtifactByPathResponseSchema,
  renameArtifactRequestSchema,
  renameArtifactResponseSchema,
  renameChatRequestSchema,
  renameChatResponseSchema,
  renameTuiAgentRequestSchema,
  renameTuiAgentResponseSchema,
  reparentArtifactRequestSchema,
  reparentArtifactResponseSchema,
  reparentChatRequestSchema,
  reparentChatResponseSchema,
  replyToCommentThreadRequestSchema,
  replyToCommentThreadResponseSchema,
  revokeEpicCollaboratorRequestSchema,
  revokeEpicCollaboratorResponseSchema,
  setCommentThreadResolvedRequestSchema,
  setCommentThreadResolvedResponseSchema,
  setEpicPinnedRequestSchema,
  setEpicPinnedResponseSchema,
  updateArtifactStatusRequestSchema,
  updateArtifactStatusResponseSchema,
  updateChatProfileRequestSchema,
  updateChatProfileResponseSchema,
  updateChatRunSettingsRequestSchema,
  updateChatRunSettingsRequestSchemaV11,
  updateChatRunSettingsResponseSchema,
  updateEpicRequestSchema,
  updateEpicResponseSchema,
} from "@traycer/protocol/host/epic/unary-schemas";
import { epicSubscribeV10 } from "@traycer/protocol/host/epic/subscribe";

// `epic.listTasks@1.0` - frozen pre-pinning host entry point for the CloudData
// task-list query. The request remains shared with the latest contract while
// the response preserves the released row shape.
export const epicListTasksV10 = defineRpcContract({
  method: "epic.listTasks",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: listTasksRequestSchema,
  responseSchema: listTasksResponseSchemaV10,
});

// `epic.listTasks@1.1` adds the signed-in user's personal `pinned` bit to each
// row and reuses CloudData's canonical current list response schema. The
// request is unchanged; an older host's rows upgrade as unpinned.
export const epicListTasksV11 = defineRpcContract({
  method: "epic.listTasks",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: listTasksRequestSchema,
  responseSchema: listTasksResponseSchema,
});

export const epicListTasksUpgradeV10ToV11 = defineUpgradePath<
  typeof epicListTasksV10,
  typeof epicListTasksV11
>({
  from: epicListTasksV10.schemaVersion,
  to: epicListTasksV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    ...response,
    tasks: response.tasks.map((task) => ({ ...task, pinned: false })),
  }),
});

// Personal cloud preference. Optional/non-floor so clients retain the released
// unary handshake against older hosts and receive E_HOST_UNSUPPORTED only when
// they try to change a pin.
export const epicSetPinnedV10 = defineRpcContract({
  method: "epic.setPinned",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: setEpicPinnedRequestSchema,
  responseSchema: setEpicPinnedResponseSchema,
});

// Batch resolve task ids → list-row shapes (titles/context). Optional/non-floor
// so clients retain the released unary handshake; old hosts return
// E_HOST_UNSUPPORTED for this call only.
export const epicGetTaskContextsV10 = defineRpcContract({
  method: "epic.getTaskContexts",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: getTaskContextsRequestSchema,
  responseSchema: getTaskContextsResponseSchema,
});

// `epic.create@1.0` - host-side entry point for the CloudData epic create
// mutation. The host request accepts local workspace paths before they are
// stamped with the persisted device ID; the resolver normalizes those before
// calling the stricter CloudData HTTP contract.
export const epicCreateV10 = defineRpcContract({
  method: "epic.create",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: createEpicRequestSchema,
  responseSchema: createEpicResponseSchema,
});

// `epic.batchDelete@1.0` - host-side entry point for the CloudData
// task batch-delete mutation (POST /api/tasks/batch-delete). Accepts a
// mixed list of epic and phase ids; returns per-id success/error details.
// Single-row deletions reuse this contract by passing a one-element `ids`
// array, so there is no parallel single-id host RPC.
export const epicBatchDeleteV10 = defineRpcContract({
  method: "epic.batchDelete",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: batchDeleteRequestSchema,
  responseSchema: batchDeleteResponseSchema,
});

export const epicRemoveRepoV10 = defineRpcContract({
  method: "epic.removeRepo",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: removeEpicRepoRequestSchema,
  responseSchema: removeEpicRepoResponseSchema,
});

export const epicMentionEpicsV10 = defineRpcContract({
  method: "epic.mentionEpics",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: epicMentionEpicsRequestSchema,
  responseSchema: epicMentionEpicsResponseSchema,
});

export const epicMentionSpecsV10 = defineRpcContract({
  method: "epic.mentionSpecs",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: epicMentionArtifactsRequestSchema,
  responseSchema: epicMentionSpecsResponseSchema,
});

export const epicMentionTicketsV10 = defineRpcContract({
  method: "epic.mentionTickets",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: epicMentionArtifactsRequestSchema,
  responseSchema: epicMentionTicketsResponseSchema,
});

export const epicMentionStoriesV10 = defineRpcContract({
  method: "epic.mentionStories",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: epicMentionArtifactsRequestSchema,
  responseSchema: epicMentionStoriesResponseSchema,
});

export const epicMentionReviewsV10 = defineRpcContract({
  method: "epic.mentionReviews",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: epicMentionArtifactsRequestSchema,
  responseSchema: epicMentionReviewsResponseSchema,
});

// `epic.listCollaborators@1.0` - host-side entry point for the
// CloudData epic-collaborators query. Schemas are imported from
// `./unary-schemas` and are the same zod instances CloudDataClient resolves
// (enforced by epic-list-collaborators-instance-identity.test.ts).
export const epicListCollaboratorsV10 = defineRpcContract({
  method: "epic.listCollaborators",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: listEpicCollaboratorsRequestSchema,
  responseSchema: listEpicCollaboratorsResponseSchema,
});

// Artifact mutations - resolver bodies added in subsequent tickets.
export const epicCreateArtifactV10 = defineRpcContract({
  method: "epic.createArtifact",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: createArtifactRequestSchema,
  responseSchema: createArtifactResponseSchema,
});

export const epicDeleteArtifactV10 = defineRpcContract({
  method: "epic.deleteArtifact",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: deleteArtifactRequestSchema,
  responseSchema: deleteArtifactResponseSchema,
});

export const epicUpdateArtifactStatusV10 = defineRpcContract({
  method: "epic.updateArtifactStatus",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: updateArtifactStatusRequestSchema,
  responseSchema: updateArtifactStatusResponseSchema,
});

export const epicRenameArtifactV10 = defineRpcContract({
  method: "epic.renameArtifact",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: renameArtifactRequestSchema,
  responseSchema: renameArtifactResponseSchema,
});

export const epicReparentArtifactV10 = defineRpcContract({
  method: "epic.reparentArtifact",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: reparentArtifactRequestSchema,
  responseSchema: reparentArtifactResponseSchema,
});

// Chat mutations - resolver bodies added in subsequent tickets.
export const epicCreateChatV10 = defineRpcContract({
  method: "epic.createChat",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: createChatRequestSchema,
  responseSchema: createChatResponseSchema,
});

export const epicRenameChatV10 = defineRpcContract({
  method: "epic.renameChat",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: renameChatRequestSchema,
  responseSchema: renameChatResponseSchema,
});

// Optional (non-floor) capability: persists a chat's run settings without a
// send. See the schema doc in `unary-schemas.ts`.
export const epicUpdateChatRunSettingsV10 = defineRpcContract({
  method: "epic.updateChatRunSettings",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: updateChatRunSettingsRequestSchema,
  responseSchema: updateChatRunSettingsResponseSchema,
});

// v1.1 tightens `settings` to the wire-strict tuple (no zod-default
// backstops): a subset-field patch is a validation error at the canonical
// minor instead of a silent null-clobber. Shipped as a minor so the loose
// v1.0 shape stays an explicitly bridged legacy line rather than the live
// contract. See `updateChatRunSettingsRequestSchemaV11`.
export const epicUpdateChatRunSettingsV11 = defineRpcContract({
  method: "epic.updateChatRunSettings",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: updateChatRunSettingsRequestSchemaV11,
  responseSchema: updateChatRunSettingsResponseSchema,
});

// A parsed v1.0 request has already materialized the loose schema's defaults
// (serviceTier/profileId -> null), so it satisfies the strict tuple as-is;
// the request upgrade is the identity. The response is unchanged.
export const epicUpdateChatRunSettingsUpgradeV10ToV11 = defineUpgradePath<
  typeof epicUpdateChatRunSettingsV10,
  typeof epicUpdateChatRunSettingsV11
>({
  from: epicUpdateChatRunSettingsV10.schemaVersion,
  to: epicUpdateChatRunSettingsV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

// Optional (non-floor) capability: narrow profile-only settings update - the
// host patches its own authoritative persisted tuple. See the schema doc in
// `unary-schemas.ts` for why no sibling model/harness update exists.
export const epicUpdateChatProfileV10 = defineRpcContract({
  method: "epic.updateChatProfile",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: updateChatProfileRequestSchema,
  responseSchema: updateChatProfileResponseSchema,
});

export const epicDeleteChatV10 = defineRpcContract({
  method: "epic.deleteChat",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: deleteChatRequestSchema,
  responseSchema: deleteChatResponseSchema,
});

export const epicReparentChatV10 = defineRpcContract({
  method: "epic.reparentChat",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: reparentChatRequestSchema,
  responseSchema: reparentChatResponseSchema,
});

export const epicCreateTuiAgentV10 = defineRpcContract({
  method: "epic.createTuiAgent",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: createTuiAgentRequestSchema,
  responseSchema: createTuiAgentResponseSchema,
});

export const epicDeleteTuiAgentV10 = defineRpcContract({
  method: "epic.deleteTuiAgent",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: deleteTuiAgentRequestSchema,
  responseSchema: deleteTuiAgentResponseSchema,
});

export const epicRenameTuiAgentV10 = defineRpcContract({
  method: "epic.renameTuiAgent",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: renameTuiAgentRequestSchema,
  responseSchema: renameTuiAgentResponseSchema,
});

// `epic.updateTitle@1.0` - uses the same updateEpicRequestSchema /
// updateEpicResponseSchema instances as cloudDataRpcRegistry["epic.update"]
// (enforced by epic-update-title-instance-identity.test.ts).
export const epicUpdateTitleV10 = defineRpcContract({
  method: "epic.updateTitle",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: updateEpicRequestSchema,
  responseSchema: updateEpicResponseSchema,
});

// Collaborator mutations - resolver bodies added in subsequent tickets.
export const epicGrantAccessV10 = defineRpcContract({
  method: "epic.grantAccess",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: grantEpicAccessRequestSchema,
  responseSchema: grantEpicAccessResponseSchema,
});

export const epicBatchUpdateRolesV10 = defineRpcContract({
  method: "epic.batchUpdateRoles",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: batchUpdateEpicRolesRequestSchema,
  responseSchema: batchUpdateEpicRolesResponseSchema,
});

export const epicRevokeCollaboratorV10 = defineRpcContract({
  method: "epic.revokeCollaborator",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: revokeEpicCollaboratorRequestSchema,
  responseSchema: revokeEpicCollaboratorResponseSchema,
});

// Comment-thread mutations - gui-app authors threads against the same Y.Doc
// the host's TiptapCollabProvider owns. Resolvers wrap the existing
// `CommentThreadManager` mutation surface and return synchronous acks.

export const epicCreateCommentThreadV10 = defineRpcContract({
  method: "epic.createCommentThread",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: createCommentThreadRequestSchema,
  responseSchema: createCommentThreadResponseSchema,
});

export const epicReplyToCommentThreadV10 = defineRpcContract({
  method: "epic.replyToCommentThread",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: replyToCommentThreadRequestSchema,
  responseSchema: replyToCommentThreadResponseSchema,
});

export const epicEditCommentV10 = defineRpcContract({
  method: "epic.editComment",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: editCommentRequestSchema,
  responseSchema: editCommentResponseSchema,
});

export const epicDeleteCommentV10 = defineRpcContract({
  method: "epic.deleteComment",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: deleteCommentRequestSchema,
  responseSchema: deleteCommentResponseSchema,
});

export const epicSetCommentThreadResolvedV10 = defineRpcContract({
  method: "epic.setCommentThreadResolved",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: setCommentThreadResolvedRequestSchema,
  responseSchema: setCommentThreadResolvedResponseSchema,
});

export const epicDeleteCommentThreadV10 = defineRpcContract({
  method: "epic.deleteCommentThread",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: deleteCommentThreadRequestSchema,
  responseSchema: deleteCommentThreadResponseSchema,
});

export const epicListCommentThreadsV10 = defineRpcContract({
  method: "epic.listCommentThreads",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: listCommentThreadsRequestSchema,
  responseSchema: listCommentThreadsResponseSchema,
});

// `epic.resolveArtifactByPath@1.0` - read-only local Y.Doc index walk mapping an
// artifact `index.md` path to `{ artifactId, kind }` (root-prefix-agnostic, so
// cross-machine links resolve). No editor gate - viewers may read.
export const epicResolveArtifactByPathV10 = defineRpcContract({
  method: "epic.resolveArtifactByPath",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: resolveArtifactByPathRequestSchema,
  responseSchema: resolveArtifactByPathResponseSchema,
});

export { epicSubscribeV10 };
