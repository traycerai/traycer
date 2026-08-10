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
  createChatRequestSchemaV11,
  createChatResponseSchema,
  createCommentThreadRequestSchema,
  createCommentThreadResponseSchema,
  createEpicRequestSchema,
  createEpicResponseSchema,
  createTuiAgentRequestSchema,
  createTuiAgentRequestSchemaV10,
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
  listTasksRequestSchemaV11,
  listTasksResponseSchema,
  listTasksResponseSchemaV10,
  removeEpicRepoRequestSchema,
  removeEpicRepoResponseSchema,
  resolveArtifactByPathRequestSchema,
  resolveArtifactByPathResponseSchema,
  searchArtifactsRequestSchema,
  searchArtifactsResponseSchema,
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
  recordEpicViewedRequestSchema,
  recordEpicViewedResponseSchema,
  revokeEpicCollaboratorRequestSchema,
  revokeEpicCollaboratorResponseSchema,
  setChatArchivedRequestSchema,
  setChatArchivedResponseSchema,
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
import {
  epicSubscribeV10,
  epicSubscribeV11,
} from "@traycer/protocol/host/epic/subscribe";
import {
  listCloudChatPayloadsRequestSchema,
  listCloudChatPayloadsResponseSchema,
  listCloudChatsRequestSchema,
  listCloudChatsResponseSchema,
  readCloudChatPartRequestSchema,
  readCloudChatPartResponseSchema,
  readCloudChatPayloadRequestSchema,
  readCloudChatPayloadResponseSchema,
  resolveCloudChatHeadRequestSchema,
  resolveCloudChatHeadResponseSchema,
} from "@traycer/protocol/host/epic/cloud-chat";
import {
  listChatPublicationTargetsRequestSchema,
  listChatPublicationTargetsResponseSchema,
} from "@traycer/protocol/host/epic/chat-publication-identity";
import {
  chatBackupStatusRequestSchema,
  chatBackupStatusResponseSchema,
} from "@traycer/protocol/host/epic/chat-backup-status";
import {
  chatReplicaReadRequestSchema,
  chatReplicaReadResponseSchema,
} from "@traycer/protocol/host/epic/chat-replica-read";

// `epic.listTasks@1.0` - frozen pre-pinning host entry point for the CloudData
// task-list query. Both request and response preserve the released wire shape.
export const epicListTasksV10 = defineRpcContract({
  method: "epic.listTasks",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: listTasksRequestSchemaV11,
  responseSchema: listTasksResponseSchemaV10,
});

// `epic.listTasks@1.1` adds the signed-in user's personal `pinned` bit to each
// row and reuses CloudData's canonical current list response schema. The
// request is unchanged; an older host's rows upgrade as unpinned.
export const epicListTasksV11 = defineRpcContract({
  method: "epic.listTasks",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: listTasksRequestSchemaV11,
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

// `epic.listTasks@1.2` adds the centrally evaluated `last-viewed` sort. The
// response is unchanged; older requests are already valid latest requests.
export const epicListTasksV12 = defineRpcContract({
  method: "epic.listTasks",
  schemaVersion: { major: 1, minor: 2 } as const,
  requestSchema: listTasksRequestSchema,
  responseSchema: listTasksResponseSchema,
});

export const epicListTasksUpgradeV11ToV12 = defineUpgradePath<
  typeof epicListTasksV11,
  typeof epicListTasksV12
>({
  from: epicListTasksV11.schemaVersion,
  to: epicListTasksV12.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
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

// Personal cloud recency. Optional/non-floor so older hosts remain compatible;
// route activation silently skips the write when the capability is absent.
export const epicRecordViewedV10 = defineRpcContract({
  method: "epic.recordViewed",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: recordEpicViewedRequestSchema,
  responseSchema: recordEpicViewedResponseSchema,
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

// v1.1 widens `forkSource` to a discriminated union (chat-sync-v2 ticket 34B1):
// the existing precise-boundary shape, tagged `boundary: "assistantMessage"`,
// beside a new `boundary: "latest"` variant that names only the source chat -
// the host resolves the boundary itself via `buildLatestCheckpointForkSeed`.
// This is a NEW MINOR, not an in-place edit of `epicCreateChatV10`: unlike
// the cloud-chat-read methods introduced on this same train (whose {1,0}
// never shipped), `epic.createChat@1.0` is already in released hosts, so its
// shape is frozen. See `createChatForkSourceSchemaV11`'s doc in
// `unary-schemas.ts`.
export const epicCreateChatV11 = defineRpcContract({
  method: "epic.createChat",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: createChatRequestSchemaV11,
  responseSchema: createChatResponseSchema,
});

// A v1.0 request's `forkSource` (when present) is always the precise-boundary
// shape - it is the ONLY shape v1.0 could ever send - so the upgrade tags it
// `boundary: "assistantMessage"` and leaves every other field untouched.
// `null`/`undefined` pass through unchanged (no fork requested). The response
// is identical between the two minors.
export const epicCreateChatUpgradeV10ToV11 = defineUpgradePath<
  typeof epicCreateChatV10,
  typeof epicCreateChatV11
>({
  from: epicCreateChatV10.schemaVersion,
  to: epicCreateChatV11.schemaVersion,
  upgradeRequest: (request) => ({
    ...request,
    forkSource:
      request.forkSource === null || request.forkSource === undefined
        ? request.forkSource
        : // Named fields, not `{boundary, ...request.forkSource}`: a spread
          // AFTER the tag is only safe because a v1.0 request's `forkSource`
          // never carries its own `boundary` key today, a fact that requires
          // reading `unary-schemas.ts` to know - constructed explicitly here
          // so it stays correct even if that stops being true.
          {
            boundary: "assistantMessage" as const,
            sourceChatId: request.forkSource.sourceChatId,
            assistantMessageId: request.forkSource.assistantMessageId,
            interviewBlockId: request.forkSource.interviewBlockId,
            carriedInterviews: request.forkSource.carriedInterviews,
          },
  }),
  upgradeResponse: (response) => response,
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

// Optional (non-floor) capability: durable host-backed archive toggle for a
// chat or terminal-agent record. Registered with a `degrade: unsupported`
// strategy (see registry.ts) so an old host that lacks it fails only this
// call - it must never enter the released floor, which would be
// handshake-fatal for existing peers. See the schema doc in `unary-schemas.ts`.
export const epicSetChatArchivedV10 = defineRpcContract({
  method: "epic.setChatArchived",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: setChatArchivedRequestSchema,
  responseSchema: setChatArchivedResponseSchema,
});

export const epicCreateTuiAgentV10 = defineRpcContract({
  method: "epic.createTuiAgent",
  schemaVersion: { major: 1, minor: 0 } as const,
  // Frozen: `host-v1.1.10` shipped this line. It pointed at the live request
  // schema until then, which is how `forkSourceHarnessSessionId` grew an
  // already-released contract.
  requestSchema: createTuiAgentRequestSchemaV10,
  responseSchema: createTuiAgentResponseSchema,
});

// v1.1 adds `forkSourceHarnessSessionId`: the upstream session a forked TUI
// agent was minted from, persisted verbatim so a provider failure between PTY
// spawn and destination-transcript establishment still has durable provenance
// to retry the fork from. Folded onto this method as a minor rather than a new
// method name, which would fatally fail the equal-set handshake against an
// already-shipped host. See the RPC backward-compat decision log.
export const epicCreateTuiAgentV11 = defineRpcContract({
  method: "epic.createTuiAgent",
  schemaVersion: { major: 1, minor: 1 } as const,
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

// `epic.searchArtifacts@1.0` - Epic-scoped artifact title/path/body search over
// the epic's on-disk Markdown mirror + authoritative Y.Doc metadata. Optional
// (non-floor): an old host lacks it in its optional manifest and returns
// E_HOST_UNSUPPORTED for this call only, so the sidebar degrades to no search.
export const epicSearchArtifactsV10 = defineRpcContract({
  method: "epic.searchArtifacts",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: searchArtifactsRequestSchema,
  responseSchema: searchArtifactsResponseSchema,
});

// ---- Cloud chat reads (host as byte pipe) ------------------------------ //
//
// Five brand-new v1.0 methods, none on `RELEASED_FLOOR_METHOD_NAMES`, all
// registered with `degrade: { kind: "unsupported" }` in `registry.ts` - a new
// method NAME is handshake-fatal against a released peer, so the whole surface
// rides the optional-capability channel.
//
// Missing-peer behavior is a designed state rather than a backstop: a host
// without these answers `E_HOST_UNSUPPORTED`, and the client's contract is to
// HIDE the cloud-chat surface (an absent list section, a dialog that states the
// refusal in place) instead of rendering a failure. "This host cannot reach
// cloud chats" is not an error a user can act on except by updating the host,
// which is what the surface says.
//
// The split into five is the read pipeline itself, and each call is one step a
// client cannot do for itself: list the rows, get the opaque head, pull ONE part
// by digest, learn which payloads are fetchable, pull one payload. Everything
// between those steps - gating on the head's version, checking each part's
// length and digest, assembling in head order, presenting - happens in the
// client, on bytes the host moved without reading. See `cloud-chat.ts`.

export const epicListCloudChatsV10 = defineRpcContract({
  method: "epic.listCloudChats",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: listCloudChatsRequestSchema,
  responseSchema: listCloudChatsResponseSchema,
});

export const epicResolveCloudChatHeadV10 = defineRpcContract({
  method: "epic.resolveCloudChatHead",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: resolveCloudChatHeadRequestSchema,
  responseSchema: resolveCloudChatHeadResponseSchema,
});

export const epicReadCloudChatPartV10 = defineRpcContract({
  method: "epic.readCloudChatPart",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: readCloudChatPartRequestSchema,
  responseSchema: readCloudChatPartResponseSchema,
});

export const epicListCloudChatPayloadsV10 = defineRpcContract({
  method: "epic.listCloudChatPayloads",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: listCloudChatPayloadsRequestSchema,
  responseSchema: listCloudChatPayloadsResponseSchema,
});

export const epicReadCloudChatPayloadV10 = defineRpcContract({
  method: "epic.readCloudChatPayload",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: readCloudChatPayloadRequestSchema,
  responseSchema: readCloudChatPayloadResponseSchema,
});

// ---- Publication identity (a host-LOCAL read, not a cloud read) -------- //
//
// Deliberately not one of the five above. Those forward cloud bytes the host
// may not interpret and are registered unconditionally; this answers from the
// host's own fork-redirect rows and exists only where a chat-sync publisher is
// installed, so it degrades independently. See `chat-publication-identity.ts`
// for what the mapping is and why folding a cloud list on `chatId` equality is
// wrong exactly once - at a fork - in both directions at the same time.
export const epicListChatPublicationTargetsV10 = defineRpcContract({
  method: "epic.listChatPublicationTargets",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: listChatPublicationTargetsRequestSchema,
  responseSchema: listChatPublicationTargetsResponseSchema,
});

export const epicChatBackupStatusV10 = defineRpcContract({
  method: "epic.chatBackupStatus",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: chatBackupStatusRequestSchema,
  responseSchema: chatBackupStatusResponseSchema,
});

// Doc-replica fallback for a chat with no cloud publication and an
// unreachable owner. Optional, like the publication-identity read above: an
// older host answers `E_HOST_UNSUPPORTED` and the client keeps today's
// "Not published yet" notice.
export const epicChatReplicaReadV10 = defineRpcContract({
  method: "epic.chatReplicaRead",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: chatReplicaReadRequestSchema,
  responseSchema: chatReplicaReadResponseSchema,
});

export { epicSubscribeV10, epicSubscribeV11 };
