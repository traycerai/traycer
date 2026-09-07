/**
 * Host ↔ client wire shapes for the `epic.*` RPC surface.
 * Allowed dependencies: `zod` and other protocol modules only - this file must stay browser-safe.
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

// The pre-@1.3 filter shape, shared by every minor from @1.0 through @1.2 - they must all resolve to the SAME schema instance, or the registry's compatibility validator reads the newer field as one an older minor "drops".
// `hostId` here is the WORKSPACE-association host (it pairs with `workspacePath`), NOT the chat-host filter added in @1.3 - the two dimensions answer different questions and must stay distinct.
export const taskFiltersSchemaPre13 = z.object({
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
export type TaskFiltersPre13 = z.infer<typeof taskFiltersSchemaPre13>;

/**
 * `chatHostIds` filters tasks by the hosts that own CHATS in them (`chats.owner_host_id`), which is what "this task is on that machine" means to a person: agents live on a host, and a task acquires a host when a chat is.
 * It also sidesteps duplicate chat ids, which the real readers resolve by an owner-precedence tiebreak that an aggregate cannot reproduce.
 */
export const taskFiltersSchema = taskFiltersSchemaPre13.extend({
  chatHostIds: z.array(z.string()).optional(),
  chatHostMatchMode: taskRepoMatchModeSchema.optional(),
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


export const deleteEpicRequestSchema = z.object({ id: z.string() });
export type DeleteEpicRequest = z.infer<typeof deleteEpicRequestSchema>;

export const deleteEpicResponseSchema = z.object({ success: z.boolean() });
export type DeleteEpicResponse = z.infer<typeof deleteEpicResponseSchema>;


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
 * The first message carried on a create (`epic.create`'s folded chat or `epic.createChat`) so the host can schedule the provider turn immediately (turn-overlap).
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
 * The first chat folded into `epic.create`.
 * The host seeds this chat into the same in-memory Y.Doc it seeds the epic into, so the create is atomic and a racing `chat.subscribe` never opens the epic before the chat exists.
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
  chat: createEpicChatSeedSchema.nullable().optional(),
});
export type CreateEpicRequest = z.infer<typeof createEpicRequestSchema>;

export const createEpicResponseSchema = z.object({
  roomInfo: tiptapRoomInfoSchema.nullable(),
  task: z
    .lazy(() => taskLightSchema)
    .nullable()
    .optional(),
  // True when the host confirmed the provider turn started from the folded chat's `initialMessage`.
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

// The task list carries viewer-specific presentation state in addition to the reusable TaskLight core.
// Keep the v1.0 row frozen so a v1.1 client can bridge an older host by defaulting every row to unpinned.
export const listTaskLightSchemaV10 = taskLightSchema;
export type ListTaskLightV10 = z.infer<typeof listTaskLightSchemaV10>;

export const listTaskLightSchemaPre13 = taskLightSchema.extend({
  pinned: z.boolean().optional(),
});
export type ListTaskLightPre13 = z.infer<typeof listTaskLightSchemaPre13>;

/**
 * `chatHostIds` are the hosts owning the CALLER'S OWN live chats in this task - the same scope the `chatHostIds` filter and the `chatHosts` facet apply, evaluated per row.
 * It is what lets a client re-apply the host filter locally: to cached rows while a request is in flight, and to rows it fetched by id (which never passed through the server's filter at all).
 */
export const listTaskLightSchema = listTaskLightSchemaPre13.extend({
  chatHostIds: z.array(z.string()).optional(),
});
export type ListTaskLight = z.infer<typeof listTaskLightSchema>;

export const listTasksRequestSchemaV11 = z.object({
  limit: z.number(),
  cursor: z.string().optional(),
  filters: taskFiltersSchemaPre13.nullable(),
  sort: listTasksSortSchemaV11.optional(),
  extensionPhaseVersion: z.string(),
  extensionEpicVersion: z.string(),
});
export const listTasksRequestSchemaPre13 = listTasksRequestSchemaV11.extend({
  sort: listTasksSortSchema.optional(),
});
export type ListTasksRequestPre13 = z.infer<typeof listTasksRequestSchemaPre13>;

export const listTasksRequestSchema = listTasksRequestSchemaPre13.extend({
  filters: taskFiltersSchema.nullable(),
});
export type ListTasksRequest = z.infer<typeof listTasksRequestSchema>;

// The pre-@1.3 facet shape, shared by @1.0/@1.1/@1.2 - see the filter note
// above on why every older minor must point at this one instance.
export const listTasksFacetsSchemaPre13 = z.object({
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
export type ListTasksFacetsPre13 = z.infer<typeof listTasksFacetsSchemaPre13>;

export const listTasksFacetsSchema = listTasksFacetsSchemaPre13.extend({
  chatHosts: z
    .array(
      z.object({
        hostId: z.string(),
        count: z.number(),
      }),
    )
    .optional(),
});
export type ListTasksFacets = z.infer<typeof listTasksFacetsSchema>;

export const listTasksResponseSchemaV10 = z.object({
  tasks: z.array(listTaskLightSchemaV10),
  nextCursor: z.string().optional(),
  hasMore: z.boolean(),
  facets: listTasksFacetsSchemaPre13.optional(),
});
export type ListTasksResponseV10 = z.infer<typeof listTasksResponseSchemaV10>;

export const listTasksResponseSchemaPre13 = z.object({
  tasks: z.array(listTaskLightSchemaPre13),
  nextCursor: z.string().optional(),
  hasMore: z.boolean(),
  facets: listTasksFacetsSchemaPre13.optional(),
});
export type ListTasksResponsePre13 = z.infer<
  typeof listTasksResponseSchemaPre13
>;

// BOTH members move to their @1.3 shapes.
// Extending only `facets` leaves `tasks` on the frozen pre-1.3 row, and since zod STRIPS unknown keys, every row's `chatHostIds` would be silently discarded at response validation - the field would simply never arrive.
export const listTasksResponseSchema = listTasksResponseSchemaPre13.extend({
  tasks: z.array(listTaskLightSchema),
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


export const GET_TASK_CONTEXTS_MAX_IDS = 50;

export const getTaskContextsRequestSchema = z.object({
  taskIds: z.array(z.string()).max(GET_TASK_CONTEXTS_MAX_IDS),
});
export type GetTaskContextsRequest = z.infer<
  typeof getTaskContextsRequestSchema
>;

export const getTaskContextsResponseSchemaV10 = z.object({
  tasks: z.record(z.string(), listTaskLightSchemaPre13.nullable()),
});
export type GetTaskContextsResponseV10 = z.infer<
  typeof getTaskContextsResponseSchemaV10
>;

export const taskContextUnknownReasonSchema = z.enum([
  "legacy",
  "not-found-or-not-permitted",
  "transport",
  "server",
  "auth",
  "denied",
  "unexpected-response",
]);
export type TaskContextUnknownReason = z.infer<
  typeof taskContextUnknownReasonSchema
>;

export const taskContextResolutionSchemaPre12 = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("found"),
    task: listTaskLightSchemaPre13,
  }),
  z.object({
    status: z.literal("confirmed-absent"),
  }),
  z.object({
    status: z.literal("unknown"),
    reason: taskContextUnknownReasonSchema,
  }),
]);

export const taskContextResolutionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("found"),
    task: listTaskLightSchema,
  }),
  z.object({
    status: z.literal("confirmed-absent"),
  }),
  z.object({
    status: z.literal("unknown"),
    reason: taskContextUnknownReasonSchema,
  }),
]);
export type TaskContextResolution = z.infer<typeof taskContextResolutionSchema>;

// Older-host values are parsed by their v1.0 schema and upgraded at the transport boundary.
export const taskContextResultSchema = taskContextResolutionSchema;
export type TaskContextResult = TaskContextResolution;

export function isFoundTaskContext(
  result: TaskContextResult | undefined,
): result is Extract<TaskContextResolution, { status: "found" }> {
  return result?.status === "found";
}

export function isConfirmedAbsentTaskContext(
  result: TaskContextResult | undefined,
): result is Extract<TaskContextResolution, { status: "confirmed-absent" }> {
  return result?.status === "confirmed-absent";
}

export const getTaskContextsResponseSchemaPre12 = z.object({
  tasks: z.record(z.string(), taskContextResolutionSchemaPre12),
});
export type GetTaskContextsResponsePre12 = z.infer<
  typeof getTaskContextsResponseSchemaPre12
>;

export const getTaskContextsResponseSchema = z.object({
  tasks: z.record(z.string(), taskContextResultSchema),
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
    // Last-updated epoch-ms, used by the GUI to sort the @-mention list by recency.
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

/** Canonical `@`-mention token for an epic artifact. Host and GUI must keep this format in lock-step so cloud and local copies de-dupe. */
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
  interviewBlockId: z.string().nullish(),
  carriedInterviews: z.enum(["pending", "settled"]).nullish(),
});
export type CreateChatForkSource = z.infer<typeof createChatForkSourceSchema>;

/**
 * `epic.createChat@1.0` - v1.1 fork source: the same precise-boundary shape as v1.0, tagged with an explicit `boundary` discriminant so it can sit in a union beside the new latest-checkpoint variant below.
 * `null` stays the honest value for "the client genuinely does not know who owns this", which must never be fabricated into a guess the host would then trust.
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
 * v1.1's other fork source: fork through the source chat's LATEST available assistant checkpoint, naming only the chat.
 */
export const createChatForkSourceLatestCheckpointBoundarySchema = z.object({
  boundary: z.literal("latest"),
  sourceChatId: z.string(),
  /**
   * The owner the CLIENT was showing for this chat when the user clicked Clone (chat-sync-v2 ticket 37).
   * NULLABLE, NOT OPTIONAL: producers pass it explicitly, and `null` is the honest value for "the client genuinely does not know who owns this" - which must never be fabricated into a guess the host would then trust.
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
  // Device the chat is bound to.
  hostId: z.string(),
  title: z.string(),
  workspaceMode: worktreeBindingWorkspaceModeSchema.optional(),
  // Client-supplied. The host resolver is idempotent on this id.
  chatId: z.string(),
  // Optional per-chat run settings to stamp on the new chat.
  settings: chatRunSettingsSchema.nullable().optional(),
  worktreeIntent: worktreeIntentSchema.nullable().optional(),
  // Optional first message.
  initialMessage: createChatInitialMessageSchema.nullable().optional(),
  // Optional manual fork source.
  forkSource: createChatForkSourceSchema.nullable().optional(),
});
export type CreateChatRequest = z.infer<typeof createChatRequestSchema>;

/**
 * v1.1 request: `forkSource` widened to the discriminated union above so a caller can name a latest-checkpoint fork alongside the existing precise boundary.
 */
export const createChatRequestSchemaV11 = createChatRequestSchema.extend({
  forkSource: createChatForkSourceSchemaV11.nullable().optional(),
});
export type CreateChatRequestV11 = z.infer<typeof createChatRequestSchemaV11>;

export const createChatResponseSchema = z.object({
  chatId: z.string(),
  // True when the host kicked the provider turn from `initialMessage`.
  // The renderer uses this to skip the redundant `send` frame; `false`/absent means it must fall back to sending the message after chat.subscribe.
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

// Persists a chat's run settings (harness/model/profile/…) WITHOUT sending a message.
// Composer selection changes call this so the durable per-chat settings - the ones a headless turn (e.g. an incoming agent-to-agent message) resolves its provider profile from - never lag behind the UI.
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

export const updateChatRunSettingsRequestSchemaV11 = z.object({
  epicId: z.string(),
  chatId: z.string(),
  settings: chatRunSettingsStrictSchema,
});
export type UpdateChatRunSettingsRequestV11 = z.infer<
  typeof updateChatRunSettingsRequestSchemaV11
>;

// Narrow, safe-by-construction field update: move a chat onto another logged-in profile (subscription) of its CURRENT harness without touching the rest of the tuple.
// The host patches its own authoritative persisted record, so callers never rebuild (and possibly stale-patch) the full tuple client-side.
export const updateChatProfileRequestSchema = z.object({
  epicId: z.string(),
  chatId: z.string(),
  profileId: z.string().nullable(),
});
export type UpdateChatProfileRequest = z.infer<
  typeof updateChatProfileRequestSchema
>;

// `updated` is false when the chat has no persisted run settings yet (a never-configured chat has no tuple to patch; its first send will stamp the composer's full tuple, profile included).
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

// Optional (non-floor) capability: durable host-backed archive toggle.
// Idempotent - archiving an already-archived record, or unarchiving an active one, is a no-op.
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

// `updated` is true when the record's `archivedAt` actually changed; false when the record was already in the requested state (idempotent no-op) or no record matched the id.
export const setChatArchivedResponseSchema = z.object({
  updated: z.boolean(),
});
export type SetChatArchivedResponse = z.infer<
  typeof setChatArchivedResponseSchema
>;

/**
 * Publication coverage for a chat this host OWNS, asked on demand.
 * It is OPTIONAL because the same question is worth asking without one ("is this chat backed up at all?"); when it is absent the host answers `boundaryCovered: null`, which means NOT ASKED and must never be read as "not.
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
 * `boundaryCovered` is decided by MESSAGE IDENTITY, never by clock comparison: it is true iff the UPSERT that carries the named message is at or below the acknowledged receipt's `through_seq` in this host's own op log.
 * It is nullable because a chat with no acknowledged receipt has no such moment to report.
 */
export const chatPublicationStateResponseSchema = z.object({
  published: z.boolean(),
  boundaryCovered: z.boolean().nullable(),
  publishedThroughTs: z.number().nullable(),
  /**
   * Set when waiting CANNOT change this answer.
   * A caller MUST stop polling when this is non-null and MUST NOT present the state as transient.
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

// `epic.createTuiAgent` - TUI agents live in the epic's `tuiAgents` Y.Map, parallel to chats.
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
  /** Optional client-minted id. When present the host persists it; when absent the host mints. Lets GUI bind worktree.* before create. */
  tuiAgentId: z.string().nullable().optional(),
  // Which of the harness's logged-in profiles (subscriptions) to launch this agent on.
  profileId: z.string().nullable().default(null),
  forkSourceHarnessSessionId: z.string().nullable().default(null).catch(null),
});
export type CreateTuiAgentRequest = z.infer<typeof createTuiAgentRequestSchema>;

/**
 * Frozen `epic.createTuiAgent@1.0` request, exactly as shipped through `host-v1.1.10`: everything above except `forkSourceHarnessSessionId`.
 * Hand-pinned field-for-field rather than derived from the live schema via `.omit()` - a field added to the live shape must not silently leak back into this contract, which is the exact failure this freeze exists to.
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

// ─── Collaborator mutations (epic.grantAccess / batchUpdateRoles / revokeCollaborator) ── All three requests use an `{ epicId, input }` wrapper.

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

// `artifact` is `null` for "not an artifact / not yet minted / unresolved chain".
// The wrapper object is intentional: the versioned-RPC fingerprint rejects a top-level nullable response, so the nullable lives on a field (mirroring `epicLightWithPermissionSchema.light`).
export const resolveArtifactByPathResponseSchema = z.object({
  artifact: resolveArtifactByPathResultSchema.nullable(),
});
export type ResolveArtifactByPathResponse = z.infer<
  typeof resolveArtifactByPathResponseSchema
>;

// ─── Search artifacts (epic.searchArtifacts@1.0 wire shape) ────────────────── Epic-scoped artifact search.
// All paths returned are RELATIVE to the epic's artifact root - a host-absolute path is never exposed.

/** Which of the artifact's searchable surfaces a query is run against. */
export const searchArtifactsFieldsSchema = z.object({
  title: z.boolean(),
  path: z.boolean(),
  body: z.boolean(),
});
export type SearchArtifactsFields = z.infer<typeof searchArtifactsFieldsSchema>;

/** Server-side filters composed with the query. */
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

/** Maximum size, in UTF-8 bytes, of a single {@link searchArtifactSnippetSchema} `text`. */
export const SEARCH_ARTIFACT_SNIPPET_MAX_BYTES = SEARCH_TEXT_PREVIEW_MAX_BYTES;

/** One body-match line. */
export const searchArtifactSnippetSchema = z.object({
  lineNumber: z.number().int().positive(),
  text: z.string(),
  ranges: z.array(searchTextPreviewRangeSchema),
});
export type SearchArtifactSnippet = z.infer<typeof searchArtifactSnippetSchema>;

/**
 * One ranked artifact hit.
 * The hit is NOT authoritative for opening: the caller re-resolves the path through the existing `epic.resolveArtifactByPath` route so a stale disk result cannot mutate or resurrect deleted state.
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

/** `ready` = the mirror was searched (an empty `results` is a legitimate zero-match). */
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
