/**
 * Host ↔ client wire shapes for the `epic.*` RPC surface.
 *
 * Scope: this module hosts all schemas used by the host's `epic.*` RPC
 * methods - read operations (`epic.listTasks`, `epic.create`,
 * `epic.listCollaborators`) and the full mutation surface (artifact
 * create/delete/status/rename, chat create/rename/delete, epic title update,
 * collaborator grant/update-roles/revoke). Other CloudData schemas still live
 * in `packages/common/src/clients/cloud-data-client/schemas.ts` where the
 * CloudDataClient HTTP surface consumes them; that file re-exports the
 * symbols defined here so the versioned RPC registry and the legacy HTTP
 * types resolve to the **same** zod instances (a hard invariant enforced by
 * the instance-identity tests under `protocol/host/__tests__`).
 *
 * Allowed dependencies: `zod` and other protocol modules only - this file
 * must stay browser-safe.
 */
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import { commonRecordRegistry } from "@traycer/protocol/common/registry";
import { accountContextSchema } from "@traycer/protocol/common/schemas";
import {
  agentModeSchema,
  tuiHarnessIdSchema,
} from "@traycer/protocol/host/agent/shared";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import {
  worktreeBindingWorkspaceModeSchema,
  worktreeIntentSchema,
} from "@traycer/protocol/host/worktree-schemas";
import {
  SEARCH_TEXT_PREVIEW_MAX_BYTES,
  searchTextPreviewRangeSchema,
} from "@traycer/protocol/host/search-text-preview-schema";
import {
  chatRunSettingsSchema,
  chatRunSettingsStrictSchema,
  userMessageSenderSchema,
} from "@traycer/protocol/persistence/epic/schemas";
import { z } from "zod";
import {
  imageSha256HexSchema,
  supportedImageMediaTypeSchema,
} from "@traycer/protocol/persistence/epic/images";

export const LatestEpicArtifactKindSchema = getRecordSchema(
  commonRecordRegistry,
  "epic-artifact-kind",
  "latest",
);
export const LatestJsonContentSchema = getRecordSchema(
  commonRecordRegistry,
  "json-content",
  "latest",
);
export const LatestPermissionRoleSchema = getRecordSchema(
  commonRecordRegistry,
  "permission-role",
  "latest",
);
export const LatestTicketStatusSchema = getRecordSchema(
  commonRecordRegistry,
  "ticket-status",
  "latest",
);

// ─── Enums ────────────────────────────────────────────────────────────────────

export type PermissionRole = z.infer<typeof LatestPermissionRoleSchema>;

export const accessTypeSchema = z.enum(["direct", "link", "organization"]);
export type AccessType = z.infer<typeof accessTypeSchema>;

export const taskTypeSchema = z.enum(["epic", "phase"]);
export type TaskType = z.infer<typeof taskTypeSchema>;

export const taskRepoMatchModeSchema = z.enum(["any", "all"]);
export type TaskRepoMatchMode = z.infer<typeof taskRepoMatchModeSchema>;

export const taskOwnershipScopeSchema = z.enum(["mine", "shared"]);
export type TaskOwnershipScope = z.infer<typeof taskOwnershipScopeSchema>;

export const listTasksSortSchemaV11 = z.enum([
  "recent",
  "oldest",
  "title-asc",
  "title-desc",
  "relevance",
]);
export const listTasksSortSchema = z.enum([
  ...listTasksSortSchemaV11.options,
  "last-viewed",
]);
export type ListTasksSort = z.infer<typeof listTasksSortSchema>;

// ─── Common shapes ────────────────────────────────────────────────────────────

export const tiptapCollabTokenSchema = z.object({
  token: z.string(),
  expiresAtMs: z.number(),
});
export type TiptapCollabToken = z.infer<typeof tiptapCollabTokenSchema>;

export const tiptapRoomInfoSchema = z.object({
  roomId: z.string(),
  webSocketUrl: z.string(),
  token: tiptapCollabTokenSchema.nullable(),
});
export type TiptapRoomInfo = z.infer<typeof tiptapRoomInfoSchema>;

export const taskRefSchema = z.object({
  taskId: z.string(),
  taskType: taskTypeSchema,
});
export type TaskRef = z.infer<typeof taskRefSchema>;

export const permissionDtoSchema = z.object({
  role: LatestPermissionRoleSchema,
  accessType: accessTypeSchema,
  userId: z.string().optional(),
  organizationId: z.string().optional(),
  grantedBy: z.string(),
  grantedAt: z.number(),
});
export type PermissionDto = z.infer<typeof permissionDtoSchema>;

export const taskRepoIdentifierSchema = z.object({
  owner: z.string(),
  repo: z.string(),
});
export type TaskRepoIdentifier = z.infer<typeof taskRepoIdentifierSchema>;

/** Canonical `owner/repo` string form. The wire shape is structured; this is for keys, labels, and IDs. */
export function formatRepoIdentifier(repo: TaskRepoIdentifier): string {
  return `${repo.owner}/${repo.repo}`;
}

export const taskWorkspaceIdentifierSchema = z.object({
  hostId: z.string(),
  workspacePath: z.string(),
});
export type TaskWorkspaceIdentifier = z.infer<
  typeof taskWorkspaceIdentifierSchema
>;

export const createEpicWorkspaceIdentifierSchema = z.object({
  workspacePath: z.string(),
});
export type CreateEpicWorkspaceIdentifier = z.infer<
  typeof createEpicWorkspaceIdentifierSchema
>;

export const taskRepoAssociationSchema = z.object({
  task: taskRefSchema.nullable(),
  repoIdentifier: taskRepoIdentifierSchema.nullable(),
  createdAt: z.number(),
  createdBy: z.string(),
});
export type TaskRepoAssociation = z.infer<typeof taskRepoAssociationSchema>;

export const userTaskWorkspaceSchema = z.object({
  task: taskRefSchema.nullable(),
  hostId: z.string(),
  workspacePath: z.string(),
  createdAt: z.number(),
});
export type UserTaskWorkspace = z.infer<typeof userTaskWorkspaceSchema>;

export interface TaskAssociations {
  repos: TaskRepoAssociation[];
  workspaces: UserTaskWorkspace[];
}

export const taskFiltersSchema = z.object({
  query: z.string().optional(),
  taskType: taskTypeSchema.optional(),
  repoIdentifier: z.string().optional(),
  repoIdentifiers: z.array(taskRepoIdentifierSchema).optional(),
  repoMatchMode: taskRepoMatchModeSchema.optional(),
  workspaceIdentifiers: z.array(taskWorkspaceIdentifierSchema).optional(),
  workspaceMatchMode: taskRepoMatchModeSchema.optional(),
  ownershipScopes: z.array(taskOwnershipScopeSchema).optional(),
  workspacePath: z.string().optional(),
  hostId: z.string().optional(),
  organizationId: z.string().optional(),
});
export type TaskFilters = z.infer<typeof taskFiltersSchema>;

// ─── Epic / phase light (with permission) ─────────────────────────────────────

export const epicLightSchema = z.object({
  id: z.string(),
  title: z.string(),
  initialUserPrompt: z.string(),
  ticketCount: z.number(),
  specCount: z.number(),
  storyCount: z.number(),
  reviewCount: z.number(),
  status: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  createdBy: z.string(),
  version: z.string(),
});
export type EpicLight = z.infer<typeof epicLightSchema>;

export const epicLightWithPermissionSchema = z.object({
  light: epicLightSchema.nullable(),
  permission: permissionDtoSchema.nullable(),
  repos: z.array(taskRepoAssociationSchema),
  workspaces: z.array(userTaskWorkspaceSchema),
  roomInfo: tiptapRoomInfoSchema.nullable(),
});
export type EpicLightWithPermission = z.infer<
  typeof epicLightWithPermissionSchema
>;

export const phaseLightSchema = z.object({
  id: z.string(),
  title: z.string(),
  userQuery: z.string(),
  phaseLength: z.number(),
  status: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  createdBy: z.string(),
  version: z.string(),
});
export type PhaseLight = z.infer<typeof phaseLightSchema>;

export const phaseLightWithPermissionSchema = z.object({
  light: phaseLightSchema.nullable(),
  permission: permissionDtoSchema.nullable(),
  repos: z.array(taskRepoAssociationSchema),
  workspaces: z.array(userTaskWorkspaceSchema),
  roomInfo: tiptapRoomInfoSchema.nullable(),
});
export type PhaseLightWithPermission = z.infer<
  typeof phaseLightWithPermissionSchema
>;

// ─── Epic light delta / update (epic.updateTitle@1.0 and epic.update@1.0) ────
// Defined here so hostRpcRegistry["epic.updateTitle"] and
// cloudDataRpcRegistry["epic.update"] resolve to the same zod instances
// (enforced by epic-update-title-instance-identity.test.ts).

export const epicLightDeltaSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  ticketCount: z.number().optional(),
  specCount: z.number().optional(),
  storyCount: z.number().optional(),
  reviewCount: z.number().optional(),
  status: z.string().optional(),
  updatedAt: z.number(),
  initialUserPrompt: z.string().optional(),
});
export type EpicLightDelta = z.infer<typeof epicLightDeltaSchema>;

export const updateEpicRequestSchema = z.object({
  epicDelta: epicLightDeltaSchema.nullable(),
});
export type UpdateEpicRequest = z.infer<typeof updateEpicRequestSchema>;

export const updateEpicResponseSchema = z.object({ updated: z.boolean() });
export type UpdateEpicResponse = z.infer<typeof updateEpicResponseSchema>;

// ─── Title generation (server-backed, no credit consumption) ────────────────

export const generateTitleTargetSchema = z.enum(["epic", "chat", "tuiAgent"]);
export type GenerateTitleTarget = z.infer<typeof generateTitleTargetSchema>;
export const GENERATE_TITLE_SOURCE_TEXT_MAX_CHARS = 4_000;

export const generateTitleRequestSchema = z.discriminatedUnion("target", [
  z.object({
    target: z.literal("epic"),
    sourceText: z.string().max(GENERATE_TITLE_SOURCE_TEXT_MAX_CHARS),
  }),
  z.object({
    target: z.literal("chat"),
    sourceText: z.string().max(GENERATE_TITLE_SOURCE_TEXT_MAX_CHARS),
  }),
  z.object({
    target: z.literal("tuiAgent"),
    sourceText: z.string().max(GENERATE_TITLE_SOURCE_TEXT_MAX_CHARS),
  }),
]);
export type GenerateTitleRequest = z.infer<typeof generateTitleRequestSchema>;

export const generateTitleResponseSchema = z.object({
  title: z.string(),
});
export type GenerateTitleResponse = z.infer<typeof generateTitleResponseSchema>;

// ─── Epic delete (HTTP wire shape) ───────────────────────────────────────────
// Used by the legacy `cloudDataRpcRegistry["epic.delete"]` HTTP contract and
// the Fastify `DELETE /api/epics/:id` route. The host RPC layer routes
// single-row deletions through `epic.batchDelete` instead.

export const deleteEpicRequestSchema = z.object({ id: z.string() });
export type DeleteEpicRequest = z.infer<typeof deleteEpicRequestSchema>;

export const deleteEpicResponseSchema = z.object({ success: z.boolean() });
export type DeleteEpicResponse = z.infer<typeof deleteEpicResponseSchema>;

// ─── Batch delete (epic.batchDelete@1.0 wire shape) ──────────────────────────
// Defined here so hostRpcRegistry["epic.batchDelete"] and
// cloudDataClient.batchDelete resolve to the same zod instances.

export const batchDeleteRequestSchema = z.object({
  ids: z.array(z.string()),
});
export type BatchDeleteRequest = z.infer<typeof batchDeleteRequestSchema>;

export const batchDeleteItemResultSchema = z.object({
  taskId: z.string(),
  success: z.boolean(),
  errorMessage: z.string().optional(),
});
export type BatchDeleteItemResult = z.infer<typeof batchDeleteItemResultSchema>;

export const batchDeleteResponseSchema = z.object({
  results: z.array(batchDeleteItemResultSchema),
});
export type BatchDeleteResponse = z.infer<typeof batchDeleteResponseSchema>;

// ─── Epic create (epic.create@1.0 wire shape) ────────────────────────────────

/**
 * The first message carried on a create (`epic.create`'s folded chat or
 * `epic.createChat`) so the host can schedule the provider turn immediately
 * (turn-overlap). Reuses the exact send-frame value schemas;
 * `messageId`/`clientActionId` are shared with any fallback `send` frame so the
 * host's idempotency gate dedupes.
 */
export const createChatInitialMessageSchema = z.object({
  messageId: z.string(),
  clientActionId: z.string(),
  content: getRecordSchema(commonRecordRegistry, "json-content", "latest"),
  sender: userMessageSenderSchema,
  settings: chatRunSettingsSchema,
  // Billing/account context the initial turn runs under. Global app-wide
  // selection (not per-chat), stamped at create time.
  accountContext: accountContextSchema,
});
export type CreateChatInitialMessage = z.infer<
  typeof createChatInitialMessageSchema
>;

/**
 * The first chat folded into `epic.create`. The host seeds this chat into the
 * same in-memory Y.Doc it seeds the epic into, so the create is atomic and a
 * racing `chat.subscribe` never opens the epic before the chat exists. Carries
 * everything `epic.createChat` would (minus `epicId`, which is `epic.id`).
 */
export const createEpicChatSeedSchema = z.object({
  chatId: z.string(),
  parentId: z.string().nullable(),
  hostId: z.string(),
  title: z.string(),
  workspaceMode: worktreeBindingWorkspaceModeSchema.optional(),
  worktreeIntent: worktreeIntentSchema.nullable(),
  initialMessage: createChatInitialMessageSchema.nullable(),
});
export type CreateEpicChatSeed = z.infer<typeof createEpicChatSeedSchema>;

export const createEpicRequestSchema = z.object({
  epic: epicLightSchema,
  repoIdentifiers: z.array(taskRepoIdentifierSchema),
  workspaces: z.array(createEpicWorkspaceIdentifierSchema),
  // The first chat, folded into the epic create so it is seeded into the same
  // in-memory Y.Doc atomically and the provider turn can be scheduled without an
  // extra create-chat round trip. Absent / `null` for epic-only creates
  // (terminal agents, migrations) and for cloud REST callers that share this
  // request type (the cloud record is created from epic/repos/workspaces; the
  // chat reaches the cloud via Yjs room sync).
  chat: createEpicChatSeedSchema.nullable().optional(),
});
export type CreateEpicRequest = z.infer<typeof createEpicRequestSchema>;

export const createEpicResponseSchema = z.object({
  roomInfo: tiptapRoomInfoSchema.nullable(),
  // Full list-shape `TaskLight` for the freshly-created epic so the GUI can
  // ingest it into the cloud-tasks history cache without round-tripping
  // through `epic.listTasks`. `null` when the cloud-side create step did not
  // synthesize a list row (e.g. legacy/migration paths that pre-date this
  // field - clients fall back to a manual refresh in that case).
  task: z
    .lazy(() => taskLightSchema)
    .nullable()
    .optional(),
  // True when the host confirmed the provider turn started from the folded
  // chat's `initialMessage`. The renderer uses this to skip the redundant
  // `send` frame. Detached epic-create starts return `false` so the
  // stream-driven fallback remains armed. Absent / `null` when no chat was
  // folded.
  initialTurnStarted: z.boolean().nullable().optional(),
});
export type CreateEpicResponse = z.infer<typeof createEpicResponseSchema>;

// ─── Local workspace folders ────────────────────────────────────────────────

export const preparedWorkspaceFolderSchema = z.object({
  workspacePath: z.string(),
  workspaceName: z.string(),
  repoIdentifier: taskRepoIdentifierSchema.nullable(),
  repoUrl: z.string().nullable(),
});
export type PreparedWorkspaceFolder = z.infer<
  typeof preparedWorkspaceFolderSchema
>;

export const prepareWorkspaceFoldersRequestSchema = z.object({
  folderPaths: z.array(z.string()),
});
export type PrepareWorkspaceFoldersRequest = z.infer<
  typeof prepareWorkspaceFoldersRequestSchema
>;

export const prepareWorkspaceFoldersResponseSchema = z.object({
  folders: z.array(preparedWorkspaceFolderSchema),
  repoIdentifiers: z.array(taskRepoIdentifierSchema),
});
export type PrepareWorkspaceFoldersResponse = z.infer<
  typeof prepareWorkspaceFoldersResponseSchema
>;

export const removeEpicRepoRequestSchema = z.object({
  epicId: z.string(),
  repoIdentifier: taskRepoIdentifierSchema,
});
export type RemoveEpicRepoRequest = z.infer<typeof removeEpicRepoRequestSchema>;

export const removeEpicRepoResponseSchema = z.object({
  success: z.boolean(),
});
export type RemoveEpicRepoResponse = z.infer<
  typeof removeEpicRepoResponseSchema
>;

// ─── Collaborators (epic.listCollaborators@1.0 wire shape) ───────────────────

export const collaboratorProfileSchema = z.object({
  displayName: z.string(),
  avatarUrl: z.string(),
  email: z.string(),
  handle: z.string(),
});
export type CollaboratorProfile = z.infer<typeof collaboratorProfileSchema>;

export const userCollaboratorSchema = z.object({
  userId: z.string(),
  profile: collaboratorProfileSchema.nullable(),
});
export type UserCollaborator = z.infer<typeof userCollaboratorSchema>;

export const teamCollaboratorSchema = z.object({
  teamId: z.string(),
  teamName: z.string(),
  teamMembers: z.array(userCollaboratorSchema),
});
export type TeamCollaborator = z.infer<typeof teamCollaboratorSchema>;

export const collaboratorEntrySchema = z.object({
  role: LatestPermissionRoleSchema,
  accessType: accessTypeSchema,
  grantedAt: z.number(),
  grantedBy: z.string(),
  user: userCollaboratorSchema.nullable().optional(),
  team: teamCollaboratorSchema.nullable().optional(),
});
export type CollaboratorEntry = z.infer<typeof collaboratorEntrySchema>;

export const listEpicCollaboratorsRequestSchema = z.object({
  epicId: z.string(),
});
export type ListEpicCollaboratorsRequest = z.infer<
  typeof listEpicCollaboratorsRequestSchema
>;

export const listEpicCollaboratorsResponseSchema = z.object({
  collaborators: z.array(collaboratorEntrySchema),
  collaboratorsAvailable: z.boolean(),
});
export type ListEpicCollaboratorsResponse = z.infer<
  typeof listEpicCollaboratorsResponseSchema
>;

// ─── Task list (versioned epic.listTasks wire shapes) ───────────────────────

export const taskLightSchema = z.object({
  epic: epicLightWithPermissionSchema.nullable().optional(),
  phase: phaseLightWithPermissionSchema.nullable().optional(),
});
export type TaskLight = z.infer<typeof taskLightSchema>;

// The task list carries viewer-specific presentation state in addition to the
// reusable TaskLight core. Keep the v1.0 row frozen so a v1.1 client can bridge
// an older host by defaulting every row to unpinned.
export const listTaskLightSchemaV10 = taskLightSchema;
export type ListTaskLightV10 = z.infer<typeof listTaskLightSchemaV10>;

export const listTaskLightSchema = taskLightSchema.extend({
  pinned: z.boolean().optional(),
});
export type ListTaskLight = z.infer<typeof listTaskLightSchema>;

export const listTasksRequestSchemaV11 = z.object({
  limit: z.number(),
  cursor: z.string().optional(),
  filters: taskFiltersSchema.nullable(),
  sort: listTasksSortSchemaV11.optional(),
  extensionPhaseVersion: z.string(),
  extensionEpicVersion: z.string(),
});
export const listTasksRequestSchema = listTasksRequestSchemaV11.extend({
  sort: listTasksSortSchema.optional(),
});
export type ListTasksRequest = z.infer<typeof listTasksRequestSchema>;

export const listTasksFacetsSchema = z.object({
  repos: z.array(
    z.object({
      repoIdentifier: taskRepoIdentifierSchema,
      count: z.number(),
    }),
  ),
  workspaces: z.array(
    z.object({
      workspaceIdentifier: taskWorkspaceIdentifierSchema,
      count: z.number(),
    }),
  ),
  ownershipScopes: z.array(
    z.object({
      value: taskOwnershipScopeSchema,
      count: z.number(),
    }),
  ),
});
export type ListTasksFacets = z.infer<typeof listTasksFacetsSchema>;

export const listTasksResponseSchemaV10 = z.object({
  tasks: z.array(listTaskLightSchemaV10),
  nextCursor: z.string().optional(),
  hasMore: z.boolean(),
  facets: listTasksFacetsSchema.optional(),
});
export type ListTasksResponseV10 = z.infer<typeof listTasksResponseSchemaV10>;

export const listTasksResponseSchema = z.object({
  tasks: z.array(listTaskLightSchema),
  nextCursor: z.string().optional(),
  hasMore: z.boolean(),
  facets: listTasksFacetsSchema.optional(),
});
export type ListTasksResponse = z.infer<typeof listTasksResponseSchema>;

// ─── Personal history pinning (epic.setPinned@1.0) ──────────────────────────

export const setEpicPinnedRequestSchema = z.object({
  epicId: z.string(),
  pinned: z.boolean(),
});
export type SetEpicPinnedRequest = z.infer<typeof setEpicPinnedRequestSchema>;

export const setEpicPinnedResponseSchema = z.object({
  pinned: z.boolean(),
});
export type SetEpicPinnedResponse = z.infer<typeof setEpicPinnedResponseSchema>;

// ─── Personal task view recency (epic.recordViewed@1.0) ─────────────────────

export const recordEpicViewedRequestSchema = z.object({
  epicId: z.string(),
});
export type RecordEpicViewedRequest = z.infer<
  typeof recordEpicViewedRequestSchema
>;

export const recordEpicViewedResponseSchema = z.object({
  viewedAt: z.number(),
});
export type RecordEpicViewedResponse = z.infer<
  typeof recordEpicViewedResponseSchema
>;

// ─── Batch task context (epic.getTaskContexts@1.0) ───────────────────────────
// Optional (non-floor) capability: resolve a small set of task ids to list-row
// shapes for title/context (e.g. worktree owner titles). Old hosts fail only
// this call with E_HOST_UNSUPPORTED; callers degrade to cache-only resolution.
//
// `null` in the response map means deleted OR not permitted to the requester —
// indistinguishable by design. Clients render both the same way (e.g. muted
// "Owner unresolved").

export const GET_TASK_CONTEXTS_MAX_IDS = 50;

export const getTaskContextsRequestSchema = z.object({
  taskIds: z.array(z.string()).max(GET_TASK_CONTEXTS_MAX_IDS),
});
export type GetTaskContextsRequest = z.infer<
  typeof getTaskContextsRequestSchema
>;

export const getTaskContextsResponseSchema = z.object({
  // Per-id: ListTaskLight when readable, null when deleted or not permitted
  // (indistinguishable by design).
  tasks: z.record(z.string(), listTaskLightSchema.nullable()),
});
export type GetTaskContextsResponse = z.infer<
  typeof getTaskContextsResponseSchema
>;

// ─── Epic/entity mentions ────────────────────────────────────────────────────

export const epicMentionEpicsRequestSchema = z.object({
  query: z.string(),
  limit: z.number().int().min(1).max(100),
});
export type EpicMentionEpicsRequest = z.infer<
  typeof epicMentionEpicsRequestSchema
>;

export const epicMentionArtifactsRequestSchema = z.object({
  query: z.string(),
  limit: z.number().int().min(1).max(100),
});
export type EpicMentionArtifactsRequest = z.infer<
  typeof epicMentionArtifactsRequestSchema
>;

export const epicMentionEpicSuggestionSchema = z.object({
  kind: z.literal("epic"),
  id: z.string(),
  token: z.string(),
  epicId: z.string(),
  label: z.string(),
  description: z.string(),
  status: z.string(),
  updatedAt: z.number(),
});
export type EpicMentionEpicSuggestion = z.infer<
  typeof epicMentionEpicSuggestionSchema
>;

function epicMentionArtifactSuggestionSchemaFor<
  const Kind extends EpicArtifactKind,
>(kind: Kind) {
  return z.object({
    kind: z.literal("epic-artifact"),
    id: z.string(),
    token: z.string(),
    epicId: z.string(),
    epicTitle: z.string(),
    artifactId: z.string(),
    artifactType: z.literal(kind),
    label: z.string(),
    description: z.string(),
    status: z.number().nullable(),
    // Last-updated epoch-ms, used by the GUI to sort the @-mention list by
    // recency. Optional so a newer renderer talking to an older (remote)
    // host that doesn't emit it still validates the response (the GUI treats
    // a missing value as 0 / least-recent).
    updatedAt: z.number().optional(),
  });
}

export const epicMentionSpecSuggestionSchema =
  epicMentionArtifactSuggestionSchemaFor("spec");
export type EpicMentionSpecSuggestion = z.infer<
  typeof epicMentionSpecSuggestionSchema
>;

export const epicMentionTicketSuggestionSchema =
  epicMentionArtifactSuggestionSchemaFor("ticket");
export type EpicMentionTicketSuggestion = z.infer<
  typeof epicMentionTicketSuggestionSchema
>;

export const epicMentionStorySuggestionSchema =
  epicMentionArtifactSuggestionSchemaFor("story");
export type EpicMentionStorySuggestion = z.infer<
  typeof epicMentionStorySuggestionSchema
>;

export const epicMentionReviewSuggestionSchema =
  epicMentionArtifactSuggestionSchemaFor("review");
export type EpicMentionReviewSuggestion = z.infer<
  typeof epicMentionReviewSuggestionSchema
>;

export const epicMentionArtifactSuggestionSchema = z.discriminatedUnion(
  "artifactType",
  [
    epicMentionSpecSuggestionSchema,
    epicMentionTicketSuggestionSchema,
    epicMentionStorySuggestionSchema,
    epicMentionReviewSuggestionSchema,
  ],
);
export type EpicMentionArtifactSuggestion = z.infer<
  typeof epicMentionArtifactSuggestionSchema
>;

/**
 * Canonical `@`-mention id/token format for an epic artifact. Shared by the
 * host resolver (buildArtifactSuggestion) and the GUI's local-artifact
 * builder so the cloud and local copies of the same artifact produce identical
 * ids and de-dupe to a single mention entry. Keep the two formats in lock-step
 * here rather than hand-rolling the template strings at each call site.
 */
export function epicArtifactMentionId(
  kind: EpicArtifactKind,
  epicId: string,
  artifactId: string,
): string {
  return `${kind}:${epicId}:${artifactId}`;
}

export function epicArtifactMentionToken(
  kind: EpicArtifactKind,
  epicId: string,
  artifactId: string,
): string {
  return `${kind}:${epicId}/${artifactId}`;
}

export const epicMentionSuggestionSchema = z.union([
  epicMentionEpicSuggestionSchema,
  epicMentionArtifactSuggestionSchema,
]);
export type EpicMentionSuggestion = z.infer<typeof epicMentionSuggestionSchema>;

export const epicMentionEpicsResponseSchema = z.object({
  entries: z.array(epicMentionEpicSuggestionSchema),
});
export type EpicMentionEpicsResponse = z.infer<
  typeof epicMentionEpicsResponseSchema
>;

export const epicMentionSpecsResponseSchema = z.object({
  entries: z.array(epicMentionSpecSuggestionSchema),
});
export type EpicMentionSpecsResponse = z.infer<
  typeof epicMentionSpecsResponseSchema
>;

export const epicMentionTicketsResponseSchema = z.object({
  entries: z.array(epicMentionTicketSuggestionSchema),
});
export type EpicMentionTicketsResponse = z.infer<
  typeof epicMentionTicketsResponseSchema
>;

export const epicMentionStoriesResponseSchema = z.object({
  entries: z.array(epicMentionStorySuggestionSchema),
});
export type EpicMentionStoriesResponse = z.infer<
  typeof epicMentionStoriesResponseSchema
>;

export const epicMentionReviewsResponseSchema = z.object({
  entries: z.array(epicMentionReviewSuggestionSchema),
});
export type EpicMentionReviewsResponse = z.infer<
  typeof epicMentionReviewsResponseSchema
>;

// ─── Collaborator mutation primitives ────────────────────────────────────────
// Moved here from `packages/common/src/clients/cloud-data-client/schemas.ts`
// so these Zod instances are owned by the protocol layer and re-exported
// back to the HTTP-client layer (preserving instance identity).

export const identifierTypeSchema = z.enum(["email", "github_handle"]);
export type IdentifierType = z.infer<typeof identifierTypeSchema>;

export const collaboratorInviteEntrySchema = z.object({
  identifier: z.string(),
  identifierType: identifierTypeSchema,
  role: LatestPermissionRoleSchema,
});
export type CollaboratorInviteEntry = z.infer<
  typeof collaboratorInviteEntrySchema
>;

export const collaboratorRoleChangeSchema = z.object({
  userId: z.string().optional(),
  teamId: z.string().optional(),
  newRole: LatestPermissionRoleSchema,
});
export type CollaboratorRoleChange = z.infer<
  typeof collaboratorRoleChangeSchema
>;

export const collaboratorRoleUpdateIntentSchema = z.enum(["invite", "direct"]);
export type CollaboratorRoleUpdateIntent = z.infer<
  typeof collaboratorRoleUpdateIntentSchema
>;

export const userInviteGrantSchema = z.object({
  invites: z.array(collaboratorInviteEntrySchema),
});
export type UserInviteGrant = z.infer<typeof userInviteGrantSchema>;

export const teamShareGrantSchema = z.object({
  teamId: z.string(),
  role: LatestPermissionRoleSchema,
});
export type TeamShareGrant = z.infer<typeof teamShareGrantSchema>;

// ─── Unified artifact light (RPC registry only) ──────────────────────────────
// Specs, tickets, stories, and reviews share mostly the same catalog
// fields, differing only in two optional columns (`assignee` and `status`).
// The `epic.*` RPC surface uses a single `kind` discriminator rather than
// four per-kind top-level schemas.

export const epicArtifactLightSchema = z.object({
  kind: LatestEpicArtifactKindSchema,
  id: z.string(),
  epicId: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  createdBy: z.string(),
  assignee: z.string().optional(),
  status: LatestTicketStatusSchema.optional(),
});
export type EpicArtifactLight = z.infer<typeof epicArtifactLightSchema>;

export const epicArtifactLightDeltaSchema = z.object({
  kind: LatestEpicArtifactKindSchema,
  id: z.string(),
  epicId: z.string(),
  title: z.string().optional(),
  updatedAt: z.number().optional(),
  assignee: z.string().optional(),
  status: LatestTicketStatusSchema.optional(),
});
export type EpicArtifactLightDelta = z.infer<
  typeof epicArtifactLightDeltaSchema
>;

// ─── Artifact CRUD (epic.createArtifact / deleteArtifact / updateArtifactStatus / renameArtifact) ──

export const createArtifactRequestSchema = z.object({
  epicId: z.string(),
  parentId: z.string().nullable(),
  artifactType: LatestEpicArtifactKindSchema,
  title: z.string(),
});
export type CreateArtifactRequest = z.infer<typeof createArtifactRequestSchema>;

export const createArtifactResponseSchema = z.object({
  artifactId: z.string(),
});
export type CreateArtifactResponse = z.infer<
  typeof createArtifactResponseSchema
>;

export const deleteArtifactRequestSchema = z.object({
  epicId: z.string(),
  artifactId: z.string(),
});
export type DeleteArtifactRequest = z.infer<typeof deleteArtifactRequestSchema>;

export const deleteArtifactResponseSchema = z.object({ deleted: z.boolean() });
export type DeleteArtifactResponse = z.infer<
  typeof deleteArtifactResponseSchema
>;

// `updateArtifactStatus` is only valid for ticket and story artifacts - specs
// and reviews have no status field.
export const artifactStatusKindSchema = z.enum(["ticket", "story"]);

export const updateArtifactStatusRequestSchema = z.object({
  epicId: z.string(),
  artifactId: z.string(),
  artifactType: artifactStatusKindSchema,
  status: LatestTicketStatusSchema,
});
export type UpdateArtifactStatusRequest = z.infer<
  typeof updateArtifactStatusRequestSchema
>;

export const updateArtifactStatusResponseSchema = z.object({
  updated: z.boolean(),
});
export type UpdateArtifactStatusResponse = z.infer<
  typeof updateArtifactStatusResponseSchema
>;

export const renameArtifactRequestSchema = z.object({
  epicId: z.string(),
  artifactId: z.string(),
  title: z.string(),
});
export type RenameArtifactRequest = z.infer<typeof renameArtifactRequestSchema>;

export const renameArtifactResponseSchema = z.object({ updated: z.boolean() });
export type RenameArtifactResponse = z.infer<
  typeof renameArtifactResponseSchema
>;

export const reparentArtifactRequestSchema = z.object({
  epicId: z.string(),
  artifactId: z.string(),
  newParentId: z.string().nullable(),
});
export type ReparentArtifactRequest = z.infer<
  typeof reparentArtifactRequestSchema
>;

export const reparentArtifactResponseSchema = z.object({
  updated: z.boolean(),
});
export type ReparentArtifactResponse = z.infer<
  typeof reparentArtifactResponseSchema
>;

// ─── Chat CRUD (epic.createChat / renameChat / deleteChat) ───────────────────

export const createChatForkSourceSchema = z.object({
  sourceChatId: z.string(),
  assistantMessageId: z.string(),
  // Optional content-block boundary within the selected assistant message.
  // Q&A actions pass the interview block id so a completed assistant turn can
  // be forked at the question checkpoint instead of at the end of the row.
  // Message-level forks leave this null/absent and retain the whole message.
  interviewBlockId: z.string().nullish(),
  // Disposition for interview (AskUserQuestion) blocks still pending at the
  // fork boundary when forking mid-Q&A:
  //  - "pending" - re-open each carried question in the fork as an answerable
  //    detached pending (A/B fork: answer differently and proceed in parallel).
  //  - "settled" - close each carried question as reference-only so the fork's
  //    composer is immediately free (Cross Question fork: interrogate the
  //    assistant instead of answering).
  // null/absent defaults to "pending".
  carriedInterviews: z.enum(["pending", "settled"]).nullish(),
});
export type CreateChatForkSource = z.infer<typeof createChatForkSourceSchema>;

/**
 * v1.1 fork source: the same precise-boundary shape as v1.0, tagged with an
 * explicit `boundary` discriminant so it can sit in a union beside the new
 * latest-checkpoint variant below. NOT a replacement for
 * {@link createChatForkSourceSchema} - that name stays byte-identical
 * forever, since `epic.createChat@1.0` is already in released hosts (see
 * `epicCreateChatV11`'s own doc in `contracts.ts` for why this is a new
 * minor rather than an in-place edit).
 *
 * Carries the same `sourceOwnerUserId` hint the latest-checkpoint variant
 * below has had since ticket 37, for the CROSS-HOST fork: the target host of
 * a cross-host fork holds no local registry facts about the source chat, so
 * the cloud tier's anti-squatting guard (ticket 34 B2) has nothing to check
 * the resolved publication's owner against and refuses to seed.
 *
 * A HINT, never an authority, with UNLOCK-ONLY semantics: the host prefers
 * its own registry facts and REFUSES the cloud tier outright when the two
 * disagree - the registry outranks the client, and a disagreement is
 * suspicious rather than a tiebreak to resolve. The hint only unlocks the
 * case where the host holds no facts of its own. See
 * `resolveExpectedForkOwner` / `chat-fork-cloud-source.ts`.
 *
 * NULLABLE WITH A `null` DEFAULT, unlike the latest-checkpoint variant: that
 * one was a brand-new arm with no producers to be compatible with, so it can
 * demand the field explicitly. This shape's other producers - every
 * message-level fork the dialog already sends - predate the field, so the
 * default makes an omitting payload parse to the honest `null` instead of
 * failing validation outright. `null` stays the honest value for "the client
 * genuinely does not know who owns this", which must never be fabricated
 * into a guess the host would then trust.
 */
export const createChatForkSourceAssistantBoundarySchema = z.object({
  boundary: z.literal("assistantMessage"),
  sourceChatId: z.string(),
  assistantMessageId: z.string(),
  interviewBlockId: z.string().nullish(),
  carriedInterviews: z.enum(["pending", "settled"]).nullish(),
  sourceOwnerUserId: z.string().min(1).nullable().default(null),
});
export type CreateChatForkSourceAssistantBoundary = z.infer<
  typeof createChatForkSourceAssistantBoundarySchema
>;

/**
 * v1.1's other fork source: fork through the source chat's LATEST available
 * assistant checkpoint, naming only the chat. Exists because a client that
 * cannot READ the source (an unreachable-owner chat viewed through the
 * doc-replica fallback, ticket 34A) cannot name a specific
 * `assistantMessageId` the way the precise-boundary variant requires - it
 * can only say "this chat, whatever it last landed on". The host resolves the
 * boundary itself via `buildLatestCheckpointForkSeed` against the
 * best-available transcript (store first, doc second - see `chat-fork-seed.ts`).
 */
export const createChatForkSourceLatestCheckpointBoundarySchema = z.object({
  boundary: z.literal("latest"),
  sourceChatId: z.string(),
  /**
   * The owner the CLIENT was showing for this chat when the user clicked
   * Clone (chat-sync-v2 ticket 37).
   *
   * The clone's cloud tier refuses to seed unless the host can check the
   * resolved publication's owner against an expectation it holds locally -
   * the anti-squatting guard from ticket 34 B2, which stops a caller
   * naming somebody else's `chatId` and being handed their transcript.
   * When local registry facts are absent (a post-restart swept chat, a
   * fresh identity) the guard refuses correctly and the clone degrades to
   * settings-only, losing the history. But the client knew the owner all
   * along: it is on the sidebar row / published ref it just rendered.
   *
   * A HINT, never an authority. The host prefers its own registry facts and
   * REFUSES the cloud tier outright when the two disagree - the registry
   * outranks the client, and a disagreement is suspicious rather than a
   * tiebreak to resolve. See `chat-fork-cloud-source.ts`.
   *
   * NULLABLE, NOT OPTIONAL: producers pass it explicitly, and `null` is the
   * honest value for "the client genuinely does not know who owns this" -
   * which must never be fabricated into a guess the host would then trust.
   */
  sourceOwnerUserId: z.string().min(1).nullable(),
});
export type CreateChatForkSourceLatestCheckpointBoundary = z.infer<
  typeof createChatForkSourceLatestCheckpointBoundarySchema
>;

export const createChatForkSourceSchemaV11 = z.discriminatedUnion("boundary", [
  createChatForkSourceAssistantBoundarySchema,
  createChatForkSourceLatestCheckpointBoundarySchema,
]);
export type CreateChatForkSourceV11 = z.infer<
  typeof createChatForkSourceSchemaV11
>;

export const createChatRequestSchema = z.object({
  epicId: z.string(),
  parentId: z.string().nullable(),
  // Device the chat is bound to. Persisted on the chat artifact so the
  // tab carries its host binding for life (mirrors the
  // `tuiAgentSchema.hostId` contract).
  hostId: z.string(),
  title: z.string(),
  workspaceMode: worktreeBindingWorkspaceModeSchema.optional(),
  // Client-supplied. The host resolver is idempotent on this id.
  chatId: z.string(),
  // Optional per-chat run settings to stamp on the new chat. Existing callers
  // omit this and let the chat start with host defaults; fork creation passes
  // the user's modal-selected provider/model settings.
  settings: chatRunSettingsSchema.nullable().optional(),
  // Optional intent - when present the host orchestrator resolves it into a
  // local SQLite WorktreeBinding row for this chat before the first
  // chat.subscribe send is processed. Intent only carries mode + entries; the
  // host authors all setup state.
  worktreeIntent: worktreeIntentSchema.nullable().optional(),
  // Optional first message. When present (the landing → epic create flow), the
  // host starts the provider turn immediately after creating the chat, so the
  // ~3s cold-start overlaps the renderer's chat.subscribe round-trip instead of
  // running strictly after it.
  initialMessage: createChatInitialMessageSchema.nullable().optional(),
  // Optional manual fork source. The host copies source chat history through
  // the selected completed assistant message and records a `chat.forked` event
  // for the forked chat's provenance divider.
  forkSource: createChatForkSourceSchema.nullable().optional(),
});
export type CreateChatRequest = z.infer<typeof createChatRequestSchema>;

/**
 * v1.1 request: `forkSource` widened to the discriminated union above so a
 * caller can name a latest-checkpoint fork alongside the existing precise
 * boundary. Every other field is identical to v1.0.
 */
export const createChatRequestSchemaV11 = createChatRequestSchema.extend({
  forkSource: createChatForkSourceSchemaV11.nullable().optional(),
});
export type CreateChatRequestV11 = z.infer<typeof createChatRequestSchemaV11>;

export const createChatResponseSchema = z.object({
  chatId: z.string(),
  // True when the host kicked the provider turn from `initialMessage`. The
  // renderer uses this to skip the redundant `send` frame; `false`/absent means
  // it must fall back to sending the message after chat.subscribe.
  initialTurnStarted: z.boolean().optional(),
});
export type CreateChatResponse = z.infer<typeof createChatResponseSchema>;

export const renameChatRequestSchema = z.object({
  epicId: z.string(),
  chatId: z.string(),
  title: z.string(),
});
export type RenameChatRequest = z.infer<typeof renameChatRequestSchema>;

export const renameChatResponseSchema = z.object({ updated: z.boolean() });
export type RenameChatResponse = z.infer<typeof renameChatResponseSchema>;

// Persists a chat's run settings (harness/model/profile/…) WITHOUT sending a
// message. Composer selection changes call this so the durable per-chat
// settings — the ones a headless turn (e.g. an incoming agent-to-agent
// message) resolves its provider profile from — never lag behind the UI.
// Optional (non-floor) capability: old hosts fail only this call with
// E_HOST_UNSUPPORTED and the renderer degrades to the legacy
// persist-on-next-send behavior.
export const updateChatRunSettingsRequestSchema = z.object({
  epicId: z.string(),
  chatId: z.string(),
  settings: chatRunSettingsSchema,
});
export type UpdateChatRunSettingsRequest = z.infer<
  typeof updateChatRunSettingsRequestSchema
>;

export const updateChatRunSettingsResponseSchema = z.object({
  updated: z.boolean(),
});
export type UpdateChatRunSettingsResponse = z.infer<
  typeof updateChatRunSettingsResponseSchema
>;

// v1.1 tightens `settings` to the wire-strict tuple (every field required, no
// zod defaults): this method is a whole-tuple WYSIWYG replace, and the strict
// schema makes a subset-field "patch" a validation error instead of a silent
// null-clobber of omitted fields. See `chatRunSettingsStrictSchema`.
// Profile-only changes belong on `epic.updateChatProfile` below.
export const updateChatRunSettingsRequestSchemaV11 = z.object({
  epicId: z.string(),
  chatId: z.string(),
  settings: chatRunSettingsStrictSchema,
});
export type UpdateChatRunSettingsRequestV11 = z.infer<
  typeof updateChatRunSettingsRequestSchemaV11
>;

// Narrow, safe-by-construction field update: move a chat onto another
// logged-in profile (subscription) of its CURRENT harness without touching
// the rest of the tuple. The host patches its own authoritative persisted
// record, so callers never rebuild (and possibly stale-patch) the full
// tuple client-side. `null` = the ambient/host login. There is deliberately
// no sibling `epic.updateChatModel`: a model change invalidates the
// reasoning/thinking/tier selection and is only expressible as a full
// reconfigure (`agent.configure` / `epic.updateChatRunSettings`).
// Optional (non-floor) capability: old hosts fail only this call with
// E_HOST_UNSUPPORTED and the renderer degrades to persist-on-next-send.
export const updateChatProfileRequestSchema = z.object({
  epicId: z.string(),
  chatId: z.string(),
  profileId: z.string().nullable(),
});
export type UpdateChatProfileRequest = z.infer<
  typeof updateChatProfileRequestSchema
>;

// `updated` is false when the chat has no persisted run settings yet (a
// never-configured chat has no tuple to patch; its first send will stamp
// the composer's full tuple, profile included).
export const updateChatProfileResponseSchema = z.object({
  updated: z.boolean(),
});
export type UpdateChatProfileResponse = z.infer<
  typeof updateChatProfileResponseSchema
>;

export const deleteChatRequestSchema = z.object({
  epicId: z.string(),
  chatId: z.string(),
});
export type DeleteChatRequest = z.infer<typeof deleteChatRequestSchema>;

export const deleteChatResponseSchema = z.object({ deleted: z.boolean() });
export type DeleteChatResponse = z.infer<typeof deleteChatResponseSchema>;

// Optional (non-floor) capability: durable host-backed archive toggle. Sets or
// clears `archivedAt` on a single chat OR terminal-agent record, resolved by
// `chatId` (one method keyed by id covers both the `chats` and `tuiAgents`
// maps). Idempotent - archiving an already-archived record, or unarchiving an
// active one, is a no-op. Old hosts lack it; callers get E_HOST_UNSUPPORTED for
// this call only and hide the archive affordance.
export const setChatArchivedRequestSchema = z.object({
  epicId: z.string(),
  // Names either a chat (in `chats`) or a terminal-agent (in `tuiAgents`)
  // record; the host resolves the id across both maps.
  chatId: z.string(),
  archived: z.boolean(),
});
export type SetChatArchivedRequest = z.infer<
  typeof setChatArchivedRequestSchema
>;

// `updated` is true when the record's `archivedAt` actually changed; false when
// the record was already in the requested state (idempotent no-op) or no record
// matched the id.
export const setChatArchivedResponseSchema = z.object({
  updated: z.boolean(),
});
export type SetChatArchivedResponse = z.infer<
  typeof setChatArchivedResponseSchema
>;

/**
 * Publication coverage for a chat this host OWNS, asked on demand.
 *
 * The fork dialog needs to know, BEFORE it lets a user fork a chat onto another
 * machine, whether the target will be able to read the transcript at all: a
 * cross-host fork is served from the chat's cloud publication, so a chat that
 * has never been published cannot be pulled, and a boundary the published head
 * does not yet cover would slice against a transcript that stops short of it.
 *
 * Answered from the publisher's own acknowledged receipt rather than from
 * maintained state: no registry-row write path, no outbox interaction, no cloud
 * schema, and no per-chat churn on the record plane.
 *
 * `boundaryMessageId` is the fork boundary the caller intends to use. It is
 * OPTIONAL because the same question is worth asking without one ("is this chat
 * backed up at all?"); when it is absent the host answers `boundaryCovered:
 * null`, which means NOT ASKED and must never be read as "not covered".
 */
export const chatPublicationStateRequestSchema = z.object({
  epicId: z.string(),
  chatId: z.string(),
  boundaryMessageId: z.string().nullish(),
});
export type ChatPublicationStateRequest = z.infer<
  typeof chatPublicationStateRequestSchema
>;

/**
 * `boundaryCovered` is decided by MESSAGE IDENTITY, never by clock comparison:
 * it is true iff the UPSERT that carries the named message is at or below the
 * acknowledged receipt's `through_seq` in this host's own op log. That is
 * exact, and it is why no timestamp reasoning exists anywhere in this feature -
 * forked and cloned chats carry foreign-minted timestamps and per-chat
 * timestamps are not monotonic, so a "boundary newer than the watermark" test
 * would be wrong in both directions.
 *
 * UPSERT-ONLY, deliberately. A local removal of the boundary message does NOT
 * make this `false`, and that is the correct answer rather than a gap: coverage
 * asks what a TARGET host could pull from the published head, and an
 * unpublished deletion has not changed that. Answering `false` would tell the
 * user to retry, and retrying is precisely what makes an unpublished removal
 * fail permanently. Do not build "the boundary is gone if it was deleted" on
 * this field - it does not answer that question and is not intended to.
 *
 * `publishedThroughTs` is DISPLAY METADATA ONLY ("backed up as of …"). It must
 * never be gated on. It is nullable because a chat with no acknowledged receipt
 * has no such moment to report.
 *
 * The tri-state on `boundaryCovered` is load-bearing:
 * - `true`  - the boundary is inside the published head.
 * - `false` - it is not, YET. This clears on its own within a publish sweep, so
 *   callers should treat it as retryable rather than terminal.
 * - `null`  - NO ANSWER WAS COMPUTED. Two causes, and `published` is what
 *   distinguishes them: no boundary was named (`published: true`), or the chat
 *   has never been published at all (`published: false`), in which case `null`
 *   comes back even though a boundary WAS named - there is no head to measure
 *   against. So never branch on `boundaryCovered` alone: read `published`
 *   first, which is decisive by itself. A caller that collapses `null` to
 *   `false` blocks a fork on a question that was never answered, and one that
 *   reads `null` as "not asked" mislabels a never-published chat.
 *
 * One deliberate indistinguishability, so a future reader does not treat it as
 * a leak to be fixed: a boundary withheld by fork arbitration reports
 * `{ published: true, boundaryCovered: false }`, exactly like a boundary the
 * sweep has not reached yet. Both are retryable and the client's action is the
 * same, so distinguishing them would leak host-side arbitration state for no
 * behavioural gain. This holds only while the condition really is transient -
 * a lineage that has been SUPERSEDED is not, and reports through `definitive`
 * below rather than hiding here.
 */
export const chatPublicationStateResponseSchema = z.object({
  published: z.boolean(),
  boundaryCovered: z.boolean().nullable(),
  publishedThroughTs: z.number().nullable(),
  /**
   * Set when waiting CANNOT change this answer. `null` means the ordinary
   * reading applies and the state may still move on its own.
   *
   * ## Why a separate field rather than more values on the other three
   *
   * Every other answer here is a snapshot of a moving process, and the client
   * polls precisely because it expects movement. Nothing in `published` /
   * `boundaryCovered` can express "stop asking": `published: false` is what a
   * chat mid-first-sweep reports, and it is also what a chat whose publication
   * halted on an unresolvable conflict reports. The client cannot tell them
   * apart, so it re-asks every 30s forever and tells the user "it backs up
   * automatically - try again shortly", which is false and never resolves.
   *
   * A caller MUST stop polling when this is non-null and MUST NOT present the
   * state as transient. Treating an unrecognised reason as terminal-but-
   * unexplained is correct and forward-compatible; treating it as `null` is
   * not, and reintroduces the infinite wait.
   *
   * - `chat-deleted` - the source chat is a tombstone on its own host. It will
   *   not come back, and the fork would be refused anyway.
   * - `lineage-superseded` - this chat lost an arbitrated fork, so its
   *   publications now land under a different cloud identity. The receipt this
   *   host holds describes a row a fork of THIS id will never fetch.
   * - `backup-halted` - publication stopped for a reason the sweep does not
   *   retry within the process lifetime (an unresolvable conflict, an
   *   escalation, an unprovable head). A host restart may clear it; waiting on
   *   this connection will not.
   */
  definitive: z
    .enum(["chat-deleted", "lineage-superseded", "backup-halted"])
    .nullable()
    .default(null),
});
export type ChatPublicationStateResponse = z.infer<
  typeof chatPublicationStateResponseSchema
>;

// Optional two-phase artifact-image ingest. Prepare validates and retains
// recoverable bytes; finish commits the artifact reference index or aborts.
export const MAX_ARTIFACT_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_ARTIFACT_IMAGE_BASE64_LENGTH =
  4 * Math.ceil(MAX_ARTIFACT_IMAGE_BYTES / 3);
const artifactImageBase64Schema = z
  .string()
  .max(MAX_ARTIFACT_IMAGE_BASE64_LENGTH)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

export const prepareArtifactImageRequestSchema = z.object({
  epicId: z.string(),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("bytes"), base64: artifactImageBase64Schema }),
    z.object({ kind: z.literal("remote"), url: z.string().url() }),
  ]),
});
export type PrepareArtifactImageRequest = z.infer<
  typeof prepareArtifactImageRequestSchema
>;

const artifactImageIngestErrorStateSchema = z.enum([
  "invalid-path",
  "blocked-path",
  "consent-required",
  "oversized",
  "invalid-image",
  "not-found",
  "budget-exceeded",
  "io-error",
]);
export const prepareArtifactImageResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    operationId: z.string(),
    attachmentHash: imageSha256HexSchema,
    mediaType: supportedImageMediaTypeSchema,
    src: z.string(),
  }),
  z.object({
    ok: z.literal(false),
    state: artifactImageIngestErrorStateSchema,
    message: z.string(),
  }),
]);
export type PrepareArtifactImageResponse = z.infer<
  typeof prepareArtifactImageResponseSchema
>;

const finishArtifactImageRequestBaseSchema = z.object({
  epicId: z.string(),
  artifactId: z.string(),
  operationId: z.string(),
});
export const finishArtifactImageRequestSchema = z.discriminatedUnion("commit", [
  finishArtifactImageRequestBaseSchema.extend({ commit: z.literal(true) }),
  finishArtifactImageRequestBaseSchema.extend({ commit: z.literal(false) }),
]);
export type FinishArtifactImageRequest = z.infer<
  typeof finishArtifactImageRequestSchema
>;

export const artifactImageFinishResponseFixtures = {
  commit: {
    committed: { committed: true },
    notYetConverged: { status: "not-yet-converged" },
    unknownOperation: { status: "unknown-operation" },
  },
  abort: {
    aborted: { status: "aborted" },
    unknownOperation: { status: "unknown-operation" },
  },
} as const;

export const commitArtifactImageResponseSchema = z.union([
  z.object({
    committed: z.literal(
      artifactImageFinishResponseFixtures.commit.committed.committed,
    ),
  }),
  z.object({
    status: z.literal(
      artifactImageFinishResponseFixtures.commit.notYetConverged.status,
    ),
  }),
  z.object({
    status: z.literal(
      artifactImageFinishResponseFixtures.commit.unknownOperation.status,
    ),
  }),
]);
export type CommitArtifactImageResponse = z.infer<
  typeof commitArtifactImageResponseSchema
>;

export const abortArtifactImageResponseSchema = z.union([
  z.object({
    status: z.literal(artifactImageFinishResponseFixtures.abort.aborted.status),
  }),
  z.object({
    status: z.literal(
      artifactImageFinishResponseFixtures.abort.unknownOperation.status,
    ),
  }),
]);
export type AbortArtifactImageResponse = z.infer<
  typeof abortArtifactImageResponseSchema
>;

export const finishArtifactImageResponseSchema = z.union([
  commitArtifactImageResponseSchema,
  abortArtifactImageResponseSchema,
]);
export type FinishArtifactImageResponse = z.infer<
  typeof finishArtifactImageResponseSchema
>;

export const reparentChatRequestSchema = z.object({
  epicId: z.string(),
  chatId: z.string(),
  newParentId: z.string().nullable(),
});
export type ReparentChatRequest = z.infer<typeof reparentChatRequestSchema>;

export const reparentChatResponseSchema = z.object({ updated: z.boolean() });
export type ReparentChatResponse = z.infer<typeof reparentChatResponseSchema>;

// ─── TUI-agent mutations (epic.createTuiAgent) ───────────────────────────────
// TUI agents live in the epic's `tuiAgents` Y.Map, parallel to chats. The
// renderer first calls `agent.tui.prepareLaunch` (resolves workspace context
// and, for harnesses that allocate synchronously, mints the upstream harness
// session id), then forwards the result here so the host writes a persisted
// record.
//
// `harnessSessionId` is `null` only when the harness hasn't allocated its
// session id yet - currently just Codex's first launch, which back-fills the
// thread id async via `onProviderSessionStarted`.
//
// `terminalAgentArgs` is the raw per-agent override captured from the landing
// launch args field. `null` means no override: prepare/launch should resolve
// the current provider Settings default. `""` means an explicit "no extra
// args" override. This is distinct from the computed `terminalShellArgs`.
export const createTuiAgentRequestSchema = z.object({
  epicId: z.string(),
  parentId: z.string().nullable(),
  title: z.string(),
  harnessId: tuiHarnessIdSchema,
  harnessSessionId: z.string().nullable().catch(null),
  terminalAgentArgs: z.string().nullable().default(null).catch(null),
  terminalShellCommand: z.string().nullable().catch(null),
  terminalShellArgs: z.array(z.string()).nullable().catch(null),
  hostId: z.string(),
  workspaceFolders: z.array(z.string()),
  workspaceMode: worktreeBindingWorkspaceModeSchema.optional(),
  model: z.string().nullable(),
  reasoningEffort: z.string().nullable().default(null),
  agentMode: agentModeSchema,
  // Optional client-minted tui-agent id. When present the host uses
  // it as the persisted record's id; when absent the host mints one
  // server-side. Lets the GUI dispatch worktree.* binding RPCs against the
  // same id BEFORE creating the record so `agent.tui.prepareLaunch`
  // reads the correct binding and gates harness launch on `awaitSetup`.
  tuiAgentId: z.string().nullable().optional(),
  // Which of the harness's logged-in profiles (subscriptions) to launch
  // this agent on. `null` = the ambient/host login, so older clients that
  // predate profiles keep today's exact behavior. See the multi-profile
  // decision log.
  profileId: z.string().nullable().default(null),
  // The upstream harness session id this record was forked FROM, when the
  // client's `agent.tui.prepareLaunch` call that minted `harnessSessionId`
  // above was itself a fork. `null` for a normal (non-fork) create, and for
  // older clients that predate this field. The resolver persists this
  // verbatim as the record's `pendingForkSourceHarnessSessionId` so a
  // provider failure between PTY spawn and destination-transcript
  // establishment still has durable provenance to retry the fork from -
  // the renderer's own prepared-launch stash is cleared on PTY creation,
  // well before that establishment point.
  // Rides @1.1 alone - see `createTuiAgentRequestSchemaV10` below.
  forkSourceHarnessSessionId: z.string().nullable().default(null).catch(null),
});
export type CreateTuiAgentRequest = z.infer<typeof createTuiAgentRequestSchema>;

/**
 * Frozen `epic.createTuiAgent@1.0` request, exactly as shipped through
 * `host-v1.1.10`: everything above except `forkSourceHarnessSessionId`.
 *
 * That field was authored straight onto the live object while @1.0 was the
 * only registered version, so it silently grew an already-released contract;
 * `host-v1.1.10` then froze @1.0 without it, because the commit that added it
 * was not in the release cherry-pick. It rides @1.1 now.
 *
 * Hand-pinned field-for-field rather than derived from the live schema via
 * `.omit()` - a field added to the live shape must not silently leak back into
 * this contract, which is the exact failure this freeze exists to prevent.
 */
export const createTuiAgentRequestSchemaV10 = z.object({
  epicId: z.string(),
  parentId: z.string().nullable(),
  title: z.string(),
  harnessId: tuiHarnessIdSchema,
  harnessSessionId: z.string().nullable().catch(null),
  terminalAgentArgs: z.string().nullable().default(null).catch(null),
  terminalShellCommand: z.string().nullable().catch(null),
  terminalShellArgs: z.array(z.string()).nullable().catch(null),
  hostId: z.string(),
  workspaceFolders: z.array(z.string()),
  workspaceMode: worktreeBindingWorkspaceModeSchema.optional(),
  model: z.string().nullable(),
  reasoningEffort: z.string().nullable().default(null),
  agentMode: agentModeSchema,
  tuiAgentId: z.string().nullable().optional(),
  profileId: z.string().nullable().default(null),
});
export type CreateTuiAgentRequestV10 = z.infer<
  typeof createTuiAgentRequestSchemaV10
>;

export const createTuiAgentResponseSchema = z.object({
  tuiAgentId: z.string(),
});
export type CreateTuiAgentResponse = z.infer<
  typeof createTuiAgentResponseSchema
>;

export const deleteTuiAgentRequestSchema = z.object({
  epicId: z.string(),
  tuiAgentId: z.string(),
});
export type DeleteTuiAgentRequest = z.infer<typeof deleteTuiAgentRequestSchema>;

export const deleteTuiAgentResponseSchema = z.object({
  deleted: z.boolean(),
});
export type DeleteTuiAgentResponse = z.infer<
  typeof deleteTuiAgentResponseSchema
>;

export const renameTuiAgentRequestSchema = z.object({
  epicId: z.string(),
  tuiAgentId: z.string(),
  title: z.string(),
});
export type RenameTuiAgentRequest = z.infer<typeof renameTuiAgentRequestSchema>;

export const renameTuiAgentResponseSchema = z.object({
  updated: z.boolean(),
});
export type RenameTuiAgentResponse = z.infer<
  typeof renameTuiAgentResponseSchema
>;

// ─── Collaborator mutations (epic.grantAccess / batchUpdateRoles / revokeCollaborator) ──
// All three requests use an `{ epicId, input }` wrapper. Grant and revoke use
// a discriminated union on `kind` ("users" | "team"); batch-update uses a flat
// changes array. Responses reuse `listEpicCollaboratorsResponseSchema` so the
// caller always gets a fresh collaborator list back.

export const grantAccessInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("users"),
    invites: z.array(collaboratorInviteEntrySchema),
  }),
  z.object({
    kind: z.literal("team"),
    teamId: z.string(),
    role: LatestPermissionRoleSchema,
  }),
]);
export type GrantAccessInput = z.infer<typeof grantAccessInputSchema>;

export const grantEpicAccessRequestSchema = z.object({
  epicId: z.string(),
  input: grantAccessInputSchema,
});
export type GrantEpicAccessRequest = z.infer<
  typeof grantEpicAccessRequestSchema
>;

export const grantEpicAccessResponseSchema =
  listEpicCollaboratorsResponseSchema;
export type GrantEpicAccessResponse = z.infer<
  typeof grantEpicAccessResponseSchema
>;

export const batchUpdateRolesInputSchema = z.object({
  changes: z.array(collaboratorRoleChangeSchema),
  intent: collaboratorRoleUpdateIntentSchema.optional(),
});
export type BatchUpdateRolesInput = z.infer<typeof batchUpdateRolesInputSchema>;

export const batchUpdateEpicRolesRequestSchema = z.object({
  epicId: z.string(),
  input: batchUpdateRolesInputSchema,
});
export type BatchUpdateEpicRolesRequest = z.infer<
  typeof batchUpdateEpicRolesRequestSchema
>;

export const batchUpdateEpicRolesResponseSchema =
  listEpicCollaboratorsResponseSchema;
export type BatchUpdateEpicRolesResponse = z.infer<
  typeof batchUpdateEpicRolesResponseSchema
>;

export const revokeInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("users"), userId: z.string() }),
  z.object({ kind: z.literal("team"), teamId: z.string() }),
]);
export type RevokeInput = z.infer<typeof revokeInputSchema>;

export const revokeEpicCollaboratorRequestSchema = z.object({
  epicId: z.string(),
  input: revokeInputSchema,
});
export type RevokeEpicCollaboratorRequest = z.infer<
  typeof revokeEpicCollaboratorRequestSchema
>;

export const revokeEpicCollaboratorResponseSchema =
  listEpicCollaboratorsResponseSchema;
export type RevokeEpicCollaboratorResponse = z.infer<
  typeof revokeEpicCollaboratorResponseSchema
>;

export const createCommentThreadRequestSchema = z.object({
  epicId: z.string(),
  artifactType: LatestEpicArtifactKindSchema,
  artifactId: z.string(),
  content: LatestJsonContentSchema,
  quotedText: z.string(),
});
export type CreateCommentThreadRequest = z.infer<
  typeof createCommentThreadRequestSchema
>;

export const createCommentThreadResponseSchema = z.object({
  threadId: z.string(),
});
export type CreateCommentThreadResponse = z.infer<
  typeof createCommentThreadResponseSchema
>;

export const replyToCommentThreadRequestSchema = z.object({
  epicId: z.string(),
  artifactType: LatestEpicArtifactKindSchema,
  artifactId: z.string(),
  threadId: z.string(),
  content: LatestJsonContentSchema,
});
export type ReplyToCommentThreadRequest = z.infer<
  typeof replyToCommentThreadRequestSchema
>;

export const replyToCommentThreadResponseSchema = z.object({
  ok: z.literal(true),
});
export type ReplyToCommentThreadResponse = z.infer<
  typeof replyToCommentThreadResponseSchema
>;

export const editCommentRequestSchema = z.object({
  epicId: z.string(),
  artifactType: LatestEpicArtifactKindSchema,
  artifactId: z.string(),
  threadId: z.string(),
  commentId: z.string(),
  content: LatestJsonContentSchema,
});
export type EditCommentRequest = z.infer<typeof editCommentRequestSchema>;

export const editCommentResponseSchema = z.object({ ok: z.literal(true) });
export type EditCommentResponse = z.infer<typeof editCommentResponseSchema>;

export const deleteCommentRequestSchema = z.object({
  epicId: z.string(),
  artifactType: LatestEpicArtifactKindSchema,
  artifactId: z.string(),
  threadId: z.string(),
  commentId: z.string(),
});
export type DeleteCommentRequest = z.infer<typeof deleteCommentRequestSchema>;

export const deleteCommentResponseSchema = z.object({ ok: z.literal(true) });
export type DeleteCommentResponse = z.infer<typeof deleteCommentResponseSchema>;

export const setCommentThreadResolvedRequestSchema = z.object({
  epicId: z.string(),
  artifactType: LatestEpicArtifactKindSchema,
  artifactId: z.string(),
  threadId: z.string(),
  resolved: z.boolean(),
});
export type SetCommentThreadResolvedRequest = z.infer<
  typeof setCommentThreadResolvedRequestSchema
>;

export const setCommentThreadResolvedResponseSchema = z.object({
  ok: z.literal(true),
});
export type SetCommentThreadResolvedResponse = z.infer<
  typeof setCommentThreadResolvedResponseSchema
>;

export const deleteCommentThreadRequestSchema = z.object({
  epicId: z.string(),
  artifactType: LatestEpicArtifactKindSchema,
  artifactId: z.string(),
  threadId: z.string(),
});
export type DeleteCommentThreadRequest = z.infer<
  typeof deleteCommentThreadRequestSchema
>;

export const deleteCommentThreadResponseSchema = z.object({
  ok: z.literal(true),
});
export type DeleteCommentThreadResponse = z.infer<
  typeof deleteCommentThreadResponseSchema
>;

// Mirror of `clients/shared/collaboration/comment.ts` types - kept in
// the protocol layer so the host read RPC and gui-app deserialize through
// the same zod instances. The shared TS interfaces re-export this type so
// consumers continue to import from `@traycer/host/collaboration`.

export const commentUserSchema = z.object({
  userId: z.string(),
  fallbackHandle: z.string().nullable(),
});

export const commentEntrySchema = z.object({
  commentId: z.string(),
  content: LatestJsonContentSchema,
  createdAt: z.number(),
  updatedAt: z.number().nullable(),
  author: commentUserSchema,
});

export const commentThreadDataSchema = z.object({
  createdByUserId: z.string(),
  createdByHandle: z.string().nullable().optional(),
  quotedText: z.string().optional(),
});

export const commentThreadWireSchema = z.object({
  threadId: z.string(),
  resolved: z.boolean(),
  createdAt: z.number(),
  comments: z.array(commentEntrySchema),
  data: commentThreadDataSchema,
});
export type CommentThreadWire = z.infer<typeof commentThreadWireSchema>;

export const listCommentThreadsRequestSchema = z.object({
  epicId: z.string(),
  artifactType: LatestEpicArtifactKindSchema,
  artifactId: z.string(),
});
export type ListCommentThreadsRequest = z.infer<
  typeof listCommentThreadsRequestSchema
>;

export const listCommentThreadsResponseSchema = z.object({
  threads: z.array(commentThreadWireSchema),
});
export type ListCommentThreadsResponse = z.infer<
  typeof listCommentThreadsResponseSchema
>;

// ─── Resolve artifact by path (epic.resolveArtifactByPath@1.0 wire shape) ────
// Read-only RPC mapping an artifact `index.md` filesystem path to its stable
// `{ artifactId, kind }`. `filePath` is an ABSOLUTE path that may have been
// authored on another machine/user (a different home prefix); the daemon
// resolver locates the `epics/<epicId>/artifacts/<chain>/index.md` subsequence
// structurally, so resolution is independent of the local disk root. A `null`
// response means "not an artifact / not yet minted / unresolved chain" - the
// GUI degrades to opening the raw file as a workspace-file preview.

export const resolveArtifactByPathRequestSchema = z.object({
  epicId: z.string(),
  filePath: z.string(),
});
export type ResolveArtifactByPathRequest = z.infer<
  typeof resolveArtifactByPathRequestSchema
>;

export const resolveArtifactByPathResultSchema = z.object({
  artifactId: z.string(),
  kind: LatestEpicArtifactKindSchema,
});
export type ResolveArtifactByPathResult = z.infer<
  typeof resolveArtifactByPathResultSchema
>;

// `artifact` is `null` for "not an artifact / not yet minted / unresolved
// chain". The wrapper object is intentional: the versioned-RPC fingerprint
// rejects a top-level nullable response, so the nullable lives on a field
// (mirroring `epicLightWithPermissionSchema.light`).
export const resolveArtifactByPathResponseSchema = z.object({
  artifact: resolveArtifactByPathResultSchema.nullable(),
});
export type ResolveArtifactByPathResponse = z.infer<
  typeof resolveArtifactByPathResponseSchema
>;

// ─── Search artifacts (epic.searchArtifacts@1.0 wire shape) ──────────────────
// Epic-scoped artifact search. `epicId` is ALWAYS required: the protocol cannot
// represent an omitted epic, an "all epics" sentinel, or a cross-epic scope, so
// artifact search can never grow into a cloud-wide index (search decision log,
// "Context-derived search scope"). `fields` selects which of title / relative
// path / Markdown body are searched; title/path are Fuse-ranked over authoritative
// artifact metadata, body is ripgrep-matched over the epic's on-disk Markdown
// mirror. All paths returned are RELATIVE to the epic's artifact root - a
// host-absolute path is never exposed.

/** Which of the artifact's searchable surfaces a query is run against. */
export const searchArtifactsFieldsSchema = z.object({
  title: z.boolean(),
  path: z.boolean(),
  body: z.boolean(),
});
export type SearchArtifactsFields = z.infer<typeof searchArtifactsFieldsSchema>;

/**
 * Server-side filters composed with the query. `kinds`/`statuses` restrict by
 * artifact metadata; `subtreePath` restricts to a subtree of the artifact tree,
 * expressed as a POSIX path RELATIVE to the epic artifact root (never an
 * absolute filesystem root - the host derives and authorizes the real root
 * internally). A `null` field means "no restriction on this axis".
 */
export const searchArtifactsFiltersSchema = z.object({
  kinds: z.array(LatestEpicArtifactKindSchema).nullable(),
  statuses: z.array(z.number().int()).nullable(),
  subtreePath: z
    .string()
    .min(1)
    .refine(
      (path) =>
        !path.startsWith("/") &&
        path
          .split("/")
          .every(
            (segment) => segment !== "" && segment !== "." && segment !== "..",
          ),
      "subtreePath must be a non-empty relative POSIX path without traversal",
    )
    .nullable(),
});
export type SearchArtifactsFilters = z.infer<
  typeof searchArtifactsFiltersSchema
>;

export const searchArtifactsRequestSchema = z.object({
  epicId: z.string(),
  query: z.string(),
  fields: searchArtifactsFieldsSchema,
  filters: searchArtifactsFiltersSchema,
  limit: z.number().int().min(1).max(1_000),
});
export type SearchArtifactsRequest = z.infer<
  typeof searchArtifactsRequestSchema
>;

/** Which surface produced a hit. A hit may carry more than one source. */
export const searchArtifactMatchSourceSchema = z.enum([
  "title",
  "path",
  "body",
]);
export type SearchArtifactMatchSource = z.infer<
  typeof searchArtifactMatchSourceSchema
>;

/**
 * Maximum size, in UTF-8 bytes, of a single {@link searchArtifactSnippetSchema}
 * `text`. The host enforces this bound (ripgrep's `--max-columns` does NOT bound
 * the JSON `lines.text` payload), truncating on a UTF-8 character boundary and
 * clamping/dropping highlight ranges so every returned range still addresses the
 * returned text. Bounds response weight against a pathological single-line body.
 */
export const SEARCH_ARTIFACT_SNIPPET_MAX_BYTES = SEARCH_TEXT_PREVIEW_MAX_BYTES;

/**
 * One body-match line. `ranges` are BYTE offsets into the UTF-8 encoding of
 * `text` (ripgrep submatch offsets), not UTF-16/JS string indices, so a
 * consumer that wants character indices converts deliberately. `text` is bounded
 * to {@link SEARCH_ARTIFACT_SNIPPET_MAX_BYTES} bytes host-side; a highlight for a
 * match past that bound is dropped rather than pointing outside `text`.
 */
export const searchArtifactSnippetSchema = z.object({
  lineNumber: z.number().int().positive(),
  text: z.string(),
  ranges: z.array(searchTextPreviewRangeSchema),
});
export type SearchArtifactSnippet = z.infer<typeof searchArtifactSnippetSchema>;

/**
 * One ranked artifact hit. `artifactId`/`kind`/`title` are authoritative
 * (resolved against the epic's Y.Doc index, so a stale disk entry for a deleted
 * artifact never appears); `status` is read from the trusted disk mirror.
 * `relativePath` and `breadcrumb` are relative to the epic artifact root. The
 * hit is NOT authoritative for opening: the caller re-resolves the path through
 * the existing `epic.resolveArtifactByPath` route so a stale disk result cannot
 * mutate or resurrect deleted state.
 */
export const searchArtifactHitSchema = z.object({
  artifactId: z.string(),
  kind: LatestEpicArtifactKindSchema,
  title: z.string(),
  status: z.number().int().nullable(),
  relativePath: z.string(),
  breadcrumb: z.array(z.string()),
  sources: z.array(searchArtifactMatchSourceSchema),
  score: z.number(),
  snippets: z.array(searchArtifactSnippetSchema),
});
export type SearchArtifactHit = z.infer<typeof searchArtifactHitSchema>;

/**
 * `ready` = the mirror was searched (an empty `results` is a legitimate
 * zero-match). `mirror-unavailable` = the epic's on-disk mirror does not exist
 * yet / is not a directory - a DISTINCT typed condition from zero matches, so a
 * caller can tell "nothing matched" apart from "nothing to search yet".
 */
export const searchArtifactsOutcomeSchema = z.enum([
  "ready",
  "mirror-unavailable",
]);
export type SearchArtifactsOutcome = z.infer<
  typeof searchArtifactsOutcomeSchema
>;

export const searchArtifactsResponseSchema = z.object({
  outcome: searchArtifactsOutcomeSchema,
  results: z.array(searchArtifactHitSchema),
  truncated: z.boolean(),
});
export type SearchArtifactsResponse = z.infer<
  typeof searchArtifactsResponseSchema
>;
