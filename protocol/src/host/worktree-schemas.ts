/**
 * Schemas for the `worktree.*` host RPC surface plus the per-device `WorktreeBinding` projected into chat snapshots.
 * Binding state is local to the host (SQLite); cloud collaborators must not see another collaborator's local paths or setup status.
 */
import { z } from "zod";
import {
  HOLDERS_REVISION_DIGEST_PATTERN,
  worktreeBusyHoldersSchema,
  worktreeBusyOwnerRefSchema,
} from "@traycer/protocol/framework/worktree-busy-holders";
export {
  HOLDERS_REVISION_DIGEST_PATTERN,
  worktreeBusyErrorDetailsSchema,
  worktreeBusyHoldKindSchema,
  worktreeBusyHolderActivitySchema,
  worktreeBusyHolderSchema,
  worktreeBusyHoldersSchema,
  worktreeBusyOwnerKindSchema,
  worktreeBusyOwnerRefSchema,
  worktreeHoldersChangedErrorDetailsSchema,
} from "@traycer/protocol/framework/worktree-busy-holders";
export type {
  WorktreeBusyErrorDetails,
  WorktreeBusyHoldKind,
  WorktreeBusyHolder,
  WorktreeBusyHolderActivity,
  WorktreeBusyHolders,
  WorktreeBusyOwnerKind,
  WorktreeBusyOwnerRef,
  WorktreeHoldersChangedErrorDetails,
} from "@traycer/protocol/framework/worktree-busy-holders";

// Inlined to avoid a circular import with `epic-schemas.ts` (which references `worktreeIntentSchema`).
const repoIdentifierSchema = z.object({
  owner: z.string(),
  repo: z.string(),
});

export const worktreeBindingOwnerKindSchema = z.enum([
  "chat",
  "terminal-agent",
]);
export type WorktreeBindingOwnerKind = z.infer<
  typeof worktreeBindingOwnerKindSchema
>;

/** Per-entry mode. */
export const worktreeBindingEntryModeSchema = z.enum(["local", "worktree"]);
export type WorktreeBindingEntryMode = z.infer<
  typeof worktreeBindingEntryModeSchema
>;

export const worktreeBindingWorkspaceModeSchema = z.enum([
  "inherit",
  "folderless",
]);
export type WorktreeBindingWorkspaceMode = z.infer<
  typeof worktreeBindingWorkspaceModeSchema
>;

export const worktreeSetupStateSchema = z.enum([
  "not_required",
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type WorktreeSetupState = z.infer<typeof worktreeSetupStateSchema>;

/**
 * A submodule branch a worktree binding OWNS - recorded at creation, after the setup script checks each submodule out on a branch matching the parent worktree.
 * A detached / pinned submodule with no branch is not owned and never recorded here.
 */
export const worktreeOwnedSubmoduleSchema = z.object({
  repoIdentifier: repoIdentifierSchema,
  branch: z.string(),
});
export type WorktreeOwnedSubmodule = z.infer<
  typeof worktreeOwnedSubmoduleSchema
>;

export const worktreeBindingEntrySchema = z.object({
  workspacePath: z.string(),
  mode: worktreeBindingEntryModeSchema,
  repoIdentifier: repoIdentifierSchema.nullable(),
  worktreePath: z.string().nullable(),
  branch: z.string().nullable(),
  isPrimary: z.boolean(),
  isImported: z.boolean(),
  setupState: worktreeSetupStateSchema,
  setupTerminalSessionId: z.string().nullable(),
  setupExitCode: z.number().int().nullable(),
  setupFailedAt: z.number().nullable(),
  createdAt: z.number(),
  // Submodule branches this worktree owns (see `worktreeOwnedSubmoduleSchema`).
  ownedSubmodules: z.array(worktreeOwnedSubmoduleSchema).optional(),
});
export type WorktreeBindingEntry = z.infer<typeof worktreeBindingEntrySchema>;

export const worktreeBindingSchema = z.object({
  workspaceMode: worktreeBindingWorkspaceModeSchema.optional(),
  entries: z.array(worktreeBindingEntrySchema),
});
export type WorktreeBinding = z.infer<typeof worktreeBindingSchema>;

/** Per-OS command shape (Codex-style local environments). */
export const osScriptSchema = z.object({
  default: z.string(),
  macos: z.string().nullable(),
  windows: z.string().nullable(),
  linux: z.string().nullable(),
});
export type OsScript = z.infer<typeof osScriptSchema>;

/** Setup/teardown scripts for a repo. */
export const workspaceScriptsSchema = z.object({
  setup: osScriptSchema,
  teardown: osScriptSchema,
  updatedAt: z.number(),
});
export type WorkspaceScripts = z.infer<typeof workspaceScriptsSchema>;

/**
 * Branch selection for a `kind: "worktree"` folder intent.
 * Both variants carry `name` as `min(1)`: a git branch name is never empty, so an empty name is structurally impossible to express on either side.
 */
export const worktreeBranchCollisionSchema = z.enum(["fail", "random"]);
export type WorktreeBranchCollision = z.infer<
  typeof worktreeBranchCollisionSchema
>;

const worktreeNewBranchBaseShape = {
  type: z.literal("new"),
  name: z.string().min(1),
  // A fork source is a branch name, never empty - `min(1)` rejects a malformed
  // empty-source request at the schema boundary (consistent with `name`).
  source: z.string().min(1),
  carryUncommittedChanges: z.boolean(),
} as const;

export type WorktreeBranchSelection =
  | {
      readonly type: "new";
      readonly name: string;
      readonly source: string;
      readonly carryUncommittedChanges: boolean;
      readonly collision?: "fail";
    }
  | {
      readonly type: "new";
      readonly name: string;
      readonly source: string;
      readonly carryUncommittedChanges: boolean;
      readonly collision: "random";
      readonly retryIdentity: string;
    }
  | { readonly type: "existing"; readonly name: string };

export const worktreeBranchSelectionSchema: z.ZodType<WorktreeBranchSelection> =
  z.union([
    z.object({
      ...worktreeNewBranchBaseShape,
      collision: z.literal("random"),
      // Idempotency key for one generated-name create operation.
      retryIdentity: z.string().min(1).max(128),
    }),
    // Keep the released variant structurally unchanged.
    // The random arm must come first so its identity fields survive parsing.
    z.object(worktreeNewBranchBaseShape),
    z.object({
      type: z.literal("existing"),
      name: z.string().min(1),
    }),
  ]);

/** Setup/teardown override carried on a `kind:"worktree"` folder intent. */
export const worktreeEntryScriptsSchema = z.object({
  setup: osScriptSchema,
  teardown: osScriptSchema,
});
export type WorktreeEntryScripts = z.infer<typeof worktreeEntryScriptsSchema>;

/** Fields shared by every folder-intent variant. */
const worktreeFolderIntentBaseShape = {
  workspacePath: z.string(),
  repoIdentifier: repoIdentifierSchema.nullable(),
  isPrimary: z.boolean(),
} as const;

/**
 * The canonical "what the user picked for this folder" shape - staged at pick time and materialized into a binding at send / turn-start.
 */
export const worktreeFolderIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), ...worktreeFolderIntentBaseShape }),
  z.object({
    kind: z.literal("import"),
    ...worktreeFolderIntentBaseShape,
    worktreePath: z.string(),
  }),
  z.object({
    kind: z.literal("worktree"),
    ...worktreeFolderIntentBaseShape,
    branch: worktreeBranchSelectionSchema,
    scripts: worktreeEntryScriptsSchema.nullable(),
  }),
]);
export type WorktreeFolderIntent = z.infer<typeof worktreeFolderIntentSchema>;

export const worktreeIntentSchema = z.object({
  entries: z.array(worktreeFolderIntentSchema),
});
export type WorktreeIntent = z.infer<typeof worktreeIntentSchema>;

// Released chat.subscribe lines keep the pre-collision worktree intent shape.
// The live intent above may grow, but frozen stream contracts must not observe those additions through a shared schema reference.
const worktreeBranchSelectionSchemaV10 = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("new"),
    name: z.string().min(1),
    source: z.string().min(1),
    carryUncommittedChanges: z.boolean(),
  }),
  z.object({
    type: z.literal("existing"),
    name: z.string().min(1),
  }),
]);

const worktreeFolderIntentSchemaV10 = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), ...worktreeFolderIntentBaseShape }),
  z.object({
    kind: z.literal("import"),
    ...worktreeFolderIntentBaseShape,
    worktreePath: z.string(),
  }),
  z.object({
    kind: z.literal("worktree"),
    ...worktreeFolderIntentBaseShape,
    branch: worktreeBranchSelectionSchemaV10,
    scripts: worktreeEntryScriptsSchema.nullable(),
  }),
]);

export const worktreeIntentSchemaV10 = z.object({
  entries: z.array(worktreeFolderIntentSchemaV10),
});

export const diskWorktreeEntrySchema = z.object({
  worktreePath: z.string(),
  branch: z.string().nullable(),
  // Best-effort branch this worktree was forked / checked out from.
  sourceBranch: z.string().nullable().optional(),
  head: z.string().nullable(),
  isMain: z.boolean(),
  isLocked: z.boolean(),
});
export type DiskWorktreeEntry = z.infer<typeof diskWorktreeEntrySchema>;

export const worktreeWorkspaceSummarySchema = z.object({
  workspacePath: z.string(),
  // Use this - not `repoIdentifier !== null` - to gate worktree-create / worktree-import affordances.
  // `repoIdentifier` may be populated from a cloud association for a non-git folder so per-repo scripts still resolve, so it cannot stand in for git eligibility.
  isGitRepo: z.boolean(),
  repoIdentifier: repoIdentifierSchema.nullable(),
  mainBranch: z.string().nullable(),
  worktrees: z.array(diskWorktreeEntrySchema),
  scripts: workspaceScriptsSchema.nullable(),
});
export type WorktreeWorkspaceSummary = z.infer<
  typeof worktreeWorkspaceSummarySchema
>;

/** Pre-Epic disk-truth listing. */
export const worktreeListByWorkspacePathsRequestSchema = z.object({
  workspacePaths: z.array(z.string()),
});
export type WorktreeListByWorkspacePathsRequest = z.infer<
  typeof worktreeListByWorkspacePathsRequestSchema
>;

export const worktreeListByWorkspacePathsResponseSchema = z.object({
  workspaces: z.array(worktreeWorkspaceSummarySchema),
});
export type WorktreeListByWorkspacePathsResponse = z.infer<
  typeof worktreeListByWorkspacePathsResponseSchema
>;

/**
 * One committed-scripts-at-ref read request.
 * The host reads the committed `<repoRoot>/.traycer/environment.json` at that ref (`git show <ref>:.traycer/environment.json`) without checking it out - exactly one `git show` per entry, never a walk of every branch.
 */
export const worktreeScriptRefSchema = z.object({
  workspacePath: z.string(),
  ref: z.string().min(1),
});
export type WorktreeScriptRef = z.infer<typeof worktreeScriptRefSchema>;

/** The committed scripts resolved for one requested {@link WorktreeScriptRef}. */
export const worktreeScriptsAtRefSchema = z.object({
  workspacePath: z.string(),
  ref: z.string(),
  scripts: workspaceScriptsSchema.nullable(),
});
export type WorktreeScriptsAtRef = z.infer<typeof worktreeScriptsAtRefSchema>;

/** `worktree.listByWorkspacePaths` v1.1 request. */
export const worktreeListByWorkspacePathsRequestSchemaV11 =
  worktreeListByWorkspacePathsRequestSchema.extend({
    scriptRefs: z.array(worktreeScriptRefSchema),
  });
export type WorktreeListByWorkspacePathsRequestV11 = z.infer<
  typeof worktreeListByWorkspacePathsRequestSchemaV11
>;

/** `worktree.listByWorkspacePaths` v1.1 response. */
export const worktreeListByWorkspacePathsResponseSchemaV11 =
  worktreeListByWorkspacePathsResponseSchema.extend({
    scriptsAtRefs: z.array(worktreeScriptsAtRefSchema),
  });
export type WorktreeListByWorkspacePathsResponseV11 = z.infer<
  typeof worktreeListByWorkspacePathsResponseSchemaV11
>;

/**
 * `worktree.listByWorkspacePaths` v1.2 request.
 * An older peer that never sends the field upgrades to `forceRefresh: false` (cached-read behavior unchanged).
 */
export const worktreeListByWorkspacePathsRequestSchemaV12 =
  worktreeListByWorkspacePathsRequestSchemaV11.extend({
    forceRefresh: z.boolean(),
  });
export type WorktreeListByWorkspacePathsRequestV12 = z.infer<
  typeof worktreeListByWorkspacePathsRequestSchemaV12
>;

/**
 * `worktree.listByWorkspacePaths` v1.2 response. Unchanged from v1.1; the
 * minor bump is solely for the additive `forceRefresh` request field.
 */
export const worktreeListByWorkspacePathsResponseSchemaV12 =
  worktreeListByWorkspacePathsResponseSchemaV11;
export type WorktreeListByWorkspacePathsResponseV12 =
  WorktreeListByWorkspacePathsResponseV11;

/**
 * `worktree.listByWorkspacePaths` v1.3 request. Unchanged from v1.2; the
 * minor bump adds the response freshness marker only.
 */
export const worktreeListByWorkspacePathsRequestSchemaV13 =
  worktreeListByWorkspacePathsRequestSchemaV12;
export type WorktreeListByWorkspacePathsRequestV13 =
  WorktreeListByWorkspacePathsRequestV12;

/**
 * The `resolvedAt` a version-bridge stamps for a row coming from a host that predates `resolvedAt` entirely (a v1.2 `listByWorkspacePaths` / v1.3 `listAllForHost` peer).
 */
export const LEGACY_HOST_RESOLVED_AT = 1;

/**
 * `worktree.listByWorkspacePaths` v1.3 summary.
 * `null` means the host has not derived this row yet; clients must not treat schema-safe fallback facts as authoritative until a non-null timestamp arrives.
 */
export const worktreeWorkspaceSummarySchemaV13 =
  worktreeWorkspaceSummarySchema.extend({
    resolvedAt: z.number().nonnegative().nullable(),
  });
export type WorktreeWorkspaceSummaryV13 = z.infer<
  typeof worktreeWorkspaceSummarySchemaV13
>;

export const worktreeListByWorkspacePathsResponseSchemaV13 = z.object({
  workspaces: z.array(worktreeWorkspaceSummarySchemaV13),
  scriptsAtRefs: z.array(worktreeScriptsAtRefSchema),
});
export type WorktreeListByWorkspacePathsResponseV13 = z.infer<
  typeof worktreeListByWorkspacePathsResponseSchemaV13
>;

/**
 * Resolved read of a repository's `.traycer/environment.json` worktree branch-prefix override.
 * `"absent"` means the file/key doesn't exist (or the workspace isn't a git repo) - the client silently inherits the global default.
 */
export const repoBranchPrefixStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("absent") }),
  z.object({ status: z.literal("present"), value: z.string() }),
  z.object({ status: z.literal("malformed") }),
]);
export type RepoBranchPrefixState = z.infer<typeof repoBranchPrefixStateSchema>;

/** `worktree.listByWorkspacePaths` v1.4 summary. */
export const worktreeWorkspaceSummarySchemaV14 =
  worktreeWorkspaceSummarySchemaV13.extend({
    repoBranchPrefix: repoBranchPrefixStateSchema,
  });
export type WorktreeWorkspaceSummaryV14 = z.infer<
  typeof worktreeWorkspaceSummarySchemaV14
>;

/** Whether the selected host can see a workspace path as a directory. */
export const workspacePresenceSchema = z.enum(["present", "absent"]);
export type WorkspacePresence = z.infer<typeof workspacePresenceSchema>;

/** `worktree.listByWorkspacePaths` v1.5 summary. */
export const worktreeWorkspaceSummarySchemaV15 =
  worktreeWorkspaceSummarySchemaV14.extend({
    presence: workspacePresenceSchema,
  });
export type WorktreeWorkspaceSummaryV15 = z.infer<
  typeof worktreeWorkspaceSummarySchemaV15
>;

export const worktreeListByWorkspacePathsRequestSchemaV14 =
  worktreeListByWorkspacePathsRequestSchemaV13;
export type WorktreeListByWorkspacePathsRequestV14 =
  WorktreeListByWorkspacePathsRequestV13;

// A V15 SUMMARY on a V14 RESPONSE is deliberate, not a mismatch.
// The two consumers of this summary carry `presence` on DIFFERENT minors because their released floors differ, not because either line is frozen
export const worktreeListByWorkspacePathsResponseSchemaV14 = z.object({
  workspaces: z.array(worktreeWorkspaceSummarySchemaV15),
  scriptsAtRefs: z.array(worktreeScriptsAtRefSchema),
});
export type WorktreeListByWorkspacePathsResponseV14 = z.infer<
  typeof worktreeListByWorkspacePathsResponseSchemaV14
>;

export const worktreeBranchSchema = z.object({
  name: z.string(),
  isCurrent: z.boolean(),
  isRemoteOnly: z.boolean(),
});
export type WorktreeBranch = z.infer<typeof worktreeBranchSchema>;

export const worktreeListBranchesRequestSchema = z.object({
  workspacePath: z.string(),
  includeRemote: z.boolean(),
});
export type WorktreeListBranchesRequest = z.infer<
  typeof worktreeListBranchesRequestSchema
>;

export const worktreeListBranchesResponseSchema = z.object({
  branches: z.array(worktreeBranchSchema),
  /** Count of distinct paths surfaced by `git status --porcelain -uall`. */
  uncommittedFileCount: z.number().int().nonnegative(),
});
export type WorktreeListBranchesResponse = z.infer<
  typeof worktreeListBranchesResponseSchema
>;

const worktreeOwnerRequestFields = {
  epicId: z.string(),
  ownerId: z.string(),
  ownerKind: worktreeBindingOwnerKindSchema,
} as const;

const worktreeBranchSelectionRequestSchemaV10 =
  worktreeBranchSelectionSchemaV10;

const worktreeBranchSelectionRequestSchemaV11 = z.union([
  z.object({
    ...worktreeNewBranchBaseShape,
    collision: z.literal("fail"),
  }),
  z.object({
    ...worktreeNewBranchBaseShape,
    collision: z.literal("random"),
    retryIdentity: z.string().min(1).max(128),
  }),
  z.object({
    type: z.literal("existing"),
    name: z.string().min(1),
  }),
]);

const worktreeFolderIntentRequestSchemaV10 = worktreeFolderIntentSchemaV10;

const worktreeFolderIntentRequestSchemaV11 = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), ...worktreeFolderIntentBaseShape }),
  z.object({
    kind: z.literal("import"),
    ...worktreeFolderIntentBaseShape,
    worktreePath: z.string(),
  }),
  z.object({
    kind: z.literal("worktree"),
    ...worktreeFolderIntentBaseShape,
    branch: worktreeBranchSelectionRequestSchemaV11,
    scripts: worktreeEntryScriptsSchema.nullable(),
  }),
]);

export const worktreeCreateRequestSchemaV10 = z.object({
  ...worktreeOwnerRequestFields,
  entries: z.array(worktreeFolderIntentRequestSchemaV10),
});

export const worktreeCreateRequestSchema = z.object({
  ...worktreeOwnerRequestFields,
  entries: z.array(worktreeFolderIntentRequestSchemaV11),
});
export type WorktreeCreateRequest = z.infer<typeof worktreeCreateRequestSchema>;

export const worktreePerEntryResultSchema = z.object({
  workspacePath: z.string(),
  ok: z.boolean(),
  worktreePath: z.string().nullable(),
  branch: z.string().nullable(),
  errorMessage: z.string().nullable(),
});
export type WorktreePerEntryResult = z.infer<
  typeof worktreePerEntryResultSchema
>;

export const worktreeCreateResponseSchema = z.object({
  binding: worktreeBindingSchema,
  perEntry: z.array(worktreePerEntryResultSchema),
});
export type WorktreeCreateResponse = z.infer<
  typeof worktreeCreateResponseSchema
>;

/**
 * Entry for `worktree.createPaths` - the ownerless "just make the worktree directories and return their paths" flow.
 */
export const worktreeCreatePathsEntrySchemaV10 = z.object({
  workspacePath: z.string(),
  branch: worktreeBranchSelectionRequestSchemaV10,
});

export const worktreeCreatePathsEntrySchema = z.object({
  workspacePath: z.string(),
  branch: worktreeBranchSelectionRequestSchemaV11,
});
const worktreeCreatePathsEntrySharedSchema = z.object({
  workspacePath: z.string(),
  branch: worktreeBranchSelectionSchema,
});
export type WorktreeCreatePathsEntry = z.infer<
  typeof worktreeCreatePathsEntrySharedSchema
>;

export const worktreeCreatedPathEntrySchema = z.object({
  workspacePath: z.string(),
  path: z.string(),
  mode: worktreeBindingEntryModeSchema,
  repoIdentifier: repoIdentifierSchema.nullable(),
  branch: z.string().nullable(),
});
export type WorktreeCreatedPathEntry = z.infer<
  typeof worktreeCreatedPathEntrySchema
>;

export const worktreeCreatePathsRequestSchemaV10 = z.object({
  entries: z.array(worktreeCreatePathsEntrySchemaV10),
});

export const worktreeCreatePathsRequestSchema = z.object({
  entries: z.array(worktreeCreatePathsEntrySchema),
});
export type WorktreeCreatePathsRequest = z.infer<
  typeof worktreeCreatePathsRequestSchema
>;

export const worktreeCreatePathsResponseSchema = z.object({
  entries: z.array(worktreeCreatedPathEntrySchema),
  perEntry: z.array(worktreePerEntryResultSchema),
});
export type WorktreeCreatePathsResponse = z.infer<
  typeof worktreeCreatePathsResponseSchema
>;

/**
 * `worktreePath` is nullable so a partial multi-repo import keeps every linked workspace in a single request: rows the user chose to leave Local arrive with `worktreePath: null` and persist as Local binding entries.
 */
export const worktreeImportEntrySchema = z.object({
  workspacePath: z.string(),
  worktreePath: z.string().nullable(),
  // Preferred over `origin` parsing so a Local row in a partial multi-repo
  // import still records the repo association.
  repoIdentifier: repoIdentifierSchema.nullable(),
  isPrimary: z.boolean(),
});
export type WorktreeImportEntry = z.infer<typeof worktreeImportEntrySchema>;

export const worktreeImportRequestSchema = z.object({
  ...worktreeOwnerRequestFields,
  entries: z.array(worktreeImportEntrySchema),
});
export type WorktreeImportRequest = z.infer<typeof worktreeImportRequestSchema>;

export const worktreeImportResponseSchema = z.object({
  binding: worktreeBindingSchema,
});
export type WorktreeImportResponse = z.infer<
  typeof worktreeImportResponseSchema
>;

/** Per-folder Local mode flip. */
export const worktreeSetEntryModeRequestSchema = z.object({
  ...worktreeOwnerRequestFields,
  workspacePath: z.string(),
});
export type WorktreeSetEntryModeRequest = z.infer<
  typeof worktreeSetEntryModeRequestSchema
>;

export const worktreeSetEntryModeResponseSchema = z.object({
  binding: worktreeBindingSchema,
});
export type WorktreeSetEntryModeResponse = z.infer<
  typeof worktreeSetEntryModeResponseSchema
>;

/**
 * Owner-scoped folder removal.
 * The host may audit and detach an orphaned Epic-level workspace association in the background; it never deletes any on-disk worktree.
 */
export const workspaceBindingRemoveEntryRequestSchema = z.object({
  ...worktreeOwnerRequestFields,
  workspacePath: z.string(),
});
export type WorkspaceBindingRemoveEntryRequest = z.infer<
  typeof workspaceBindingRemoveEntryRequestSchema
>;

export const workspaceBindingRemoveEntryResponseSchema = z.object({
  binding: worktreeBindingSchema,
});
export type WorkspaceBindingRemoveEntryResponse = z.infer<
  typeof workspaceBindingRemoveEntryResponseSchema
>;

export const worktreeRetrySetupRequestSchema = z.object({
  ...worktreeOwnerRequestFields,
  workspacePath: z.string(),
});
export type WorktreeRetrySetupRequest = z.infer<
  typeof worktreeRetrySetupRequestSchema
>;

export const worktreeRetrySetupResponseSchema = z.object({
  binding: worktreeBindingSchema,
  terminalSessionId: z.string().nullable(),
});
export type WorktreeRetrySetupResponse = z.infer<
  typeof worktreeRetrySetupResponseSchema
>;

// `epicId` scopes the teardown terminal to the current Epic so the tab appears in that Epic's terminal context.
export const worktreeDeleteRequestSchema = z.object({
  epicId: z.string(),
  workspacePath: z.string(),
  worktreePath: z.string(),
});
export type WorktreeDeleteRequest = z.infer<typeof worktreeDeleteRequestSchema>;

/** `worktree.delete@1.1` request. */
export const worktreeDeleteRequestSchemaV11 =
  worktreeDeleteRequestSchema.extend({
    stopOwners: z.boolean().default(false),
  });
export type WorktreeDeleteRequestV11 = z.infer<
  typeof worktreeDeleteRequestSchemaV11
>;

/**
 * Released @1.2 wire validation remains frozen even though the host now
 * ignores the revision. Empty and non-digest strings still fail parsing.
 */
export const expectedHoldersRevisionFieldSchema = z
  .string()
  .regex(HOLDERS_REVISION_DIGEST_PATTERN)
  .optional();

/**
 * Frozen @1.2 constraint: a present revision still requires
 * `stopOwners: true`, even though current hosts ignore the revision value.
 */
export function refineConsentRevisionRequiresStopOwners(
  value: {
    readonly stopOwners: boolean;
    readonly expectedHoldersRevision?: string;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.expectedHoldersRevision === undefined) return;
  if (value.stopOwners) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["expectedHoldersRevision"],
    message: "expectedHoldersRevision requires stopOwners to be true",
  });
}

/**
 * `worktree.delete@1.2` request.
 * The existing digest and `stopOwners: true` parse constraints remain frozen.
 */
export const worktreeDeleteRequestSchemaV12 = worktreeDeleteRequestSchemaV11
  .extend({
    expectedHoldersRevision: expectedHoldersRevisionFieldSchema,
  })
  .superRefine(refineConsentRevisionRequiresStopOwners);
export type WorktreeDeleteRequestV12 = z.infer<
  typeof worktreeDeleteRequestSchemaV12
>;

export const worktreeDeleteResponseSchema = z.object({
  deleted: z.boolean(),
});
export type WorktreeDeleteResponse = z.infer<
  typeof worktreeDeleteResponseSchema
>;

/**
 * `worktree.listHolders@1.0` - path-scoped holder inventory with an optional owner filter.
 * Brand-new method, outside the released floor: an old host simply lacks it (`degrade: unsupported`) and an old client never calls it.
 */
export const worktreeListHoldersRequestSchema = z.object({
  worktreePath: z.string(),
  owner: worktreeBusyOwnerRefSchema.nullable().default(null),
});
export type WorktreeListHoldersRequest = z.infer<
  typeof worktreeListHoldersRequestSchema
>;

export const worktreeListHoldersResponseSchema = z.object({
  holders: worktreeBusyHoldersSchema,
  /**
   * Host-computed digest of `holders`.
   * Present values must match `HOLDERS_REVISION_DIGEST_PATTERN` so a client can echo the field as `expectedHoldersRevision` without a parse round-trip failing.
   */
  holdersRevision: z.string().regex(HOLDERS_REVISION_DIGEST_PATTERN).optional(),
});
export type WorktreeListHoldersResponse = z.infer<
  typeof worktreeListHoldersResponseSchema
>;

/**
 * One worktree under the host's `~/.traycer/worktrees/` creation path, for the Settings ▸ Worktrees section.
 */
export const worktreeHostEntrySchema = z.object({
  worktreePath: z.string(),
  // "owner/repo" or a local basename - drives client-side grouping/display.
  repoLabel: z.string(),
  repoIdentifier: repoIdentifierSchema.nullable(),
  // Branch checked out in the worktree itself (not the repo's main branch).
  branch: z.string().nullable(),
  // Bound to an active chat/agent OR an active-run cwd (path-driven busy check).
  inUse: z.boolean(),
  // Distinct paths from `git status --porcelain -uall`; 0 = clean.
  uncommittedCount: z.number().int().nonnegative(),
  // `false` when the main repo is unresolvable (orphan dir git no longer tracks), so delete falls back to an `fs.rm` cleanup instead of `git worktree remove`.
  gitRemovable: z.boolean(),
  // The scripts currently resolved for this exact worktree path. Settings
  // lets the user review/edit them before starting a host-wide delete.
  scripts: workspaceScriptsSchema.nullable(),
});
export type WorktreeHostEntry = z.infer<typeof worktreeHostEntrySchema>;

// No params - always enumerates the calling host's own worktrees root.
export const worktreeListAllForHostRequestSchema = z.object({});
export type WorktreeListAllForHostRequest = z.infer<
  typeof worktreeListAllForHostRequestSchema
>;

export const worktreeListAllForHostResponseSchema = z.object({
  worktrees: z.array(worktreeHostEntrySchema),
});
export type WorktreeListAllForHostResponse = z.infer<
  typeof worktreeListAllForHostResponseSchema
>;

export const worktreeHostEntryOwnerSchema = z.object({
  epicId: z.string(),
  ownerKind: worktreeBindingOwnerKindSchema,
  ownerId: z.string(),
  updatedAt: z.number(),
});
export type WorktreeHostEntryOwner = z.infer<
  typeof worktreeHostEntryOwnerSchema
>;

/**
 * Best-effort branch position for a worktree, probed only when the v1.1 request sets `includeActivity: true`.
 * Present whenever the default branch resolves - `mergedIntoDefault` is derived from LOCAL ancestry and needs no upstream, so a never-pushed branch still gets a real object.
 */
export const worktreeBranchStatusSchema = z.object({
  // Commits on HEAD not on its upstream / on upstream not on HEAD.
  // `null` when the branch has no upstream (never pushed) - "unknown position", never "zero".
  ahead: z.number().int().nonnegative().nullable(),
  behind: z.number().int().nonnegative().nullable(),
  // `merge-base --is-ancestor HEAD <default>`: the branch's HEAD is fully contained in the repo's default branch, so removing the worktree loses no unmerged commits.
  // Computed from LOCAL ancestry - independent of any upstream - so it holds even for a never-pushed branch.
  mergedIntoDefault: z.boolean(),
});
export type WorktreeBranchStatus = z.infer<typeof worktreeBranchStatusSchema>;

/**
 * GitHub PR merge state for a branch, as discovered by the host's best-effort local `gh` probe.
 * Either way PR data contributes no green and the classifier degrades to the local-ancestry and at-base signals, never an error.
 */
export const worktreePrStateSchema = z.enum([
  "merged",
  "open",
  "closed",
  "none",
]);
export type WorktreePrState = z.infer<typeof worktreePrStateSchema>;

/**
 * Per-owned-submodule merge facts, joined onto a v1.1 listing entry so the Task merge-rollup (True AND across the superproject and every owned submodule) is pure client work.
 * `mergedHeadShaMatches` is the host's live-HEAD comparison (submodule HEAD === the merged head SHA) so the pure client classifier never needs the SHA itself.
 */
export const worktreeSubmoduleMergeFactSchema = z.object({
  repoIdentifier: repoIdentifierSchema,
  branch: z.string(),
  prState: worktreePrStateSchema.nullable(),
  prNumber: z.number().int().nullable(),
  prUrl: z.string().nullable(),
  mergedHeadShaMatches: z.boolean(),
  mergedIntoDefault: z.boolean(),
});
export type WorktreeSubmoduleMergeFact = z.infer<
  typeof worktreeSubmoduleMergeFactSchema
>;

export const worktreeSubmoduleMergeFactSchemaV12 =
  worktreeSubmoduleMergeFactSchema.extend({
    atPinnedCommit: z.boolean(),
    unmergedCommitCount: z.number().int().nonnegative().nullable(),
    unmergedCommitSubjects: z.array(z.string()).max(5).nullable(),
  });
export type WorktreeSubmoduleMergeFactV12 = z.infer<
  typeof worktreeSubmoduleMergeFactSchemaV12
>;

/** `worktree.listAllForHost` v1.1 entry. */
export const worktreeHostEntrySchemaV11 = worktreeHostEntrySchema.extend({
  // max(git HEAD reflog last entry, binding `updatedAt` for this path).
  lastActivityAt: z.number().nullable(),
  // Persisted `WorktreeBindingV1` rows (this host) whose effective directory is
  // this worktree. `[]` = unreferenced.
  owners: z.array(worktreeHostEntryOwnerSchema),
  // `null` when detached / default branch unresolvable / probe failed / `includeActivity` false.
  // Null therefore means "position unknown", never "no upstream".
  branchStatus: worktreeBranchStatusSchema.nullable(),
  // Worktree dir birthtime (fs stat) - a fallback age signal. `null` when stat
  // is unavailable.
  createdAt: z.number().nullable(),
  // Superproject PR facts from the host's best-effort `gh` probe.
  // `mergedHeadShaMatches` is the host's live-HEAD comparison (HEAD === the merged head SHA) - the pure client classifier greens `Merged (PR)` on `prState === "merged" && mergedHeadShaMatches`, so it never needs the SHA.
  prState: worktreePrStateSchema.nullable(),
  prNumber: z.number().int().nullable(),
  prUrl: z.string().nullable(),
  mergedHeadShaMatches: z.boolean(),
  // Per-owned-submodule merge facts for the True-AND Task rollup. `[]` when the
  // worktree owns no submodule branches or `includeActivity` is false.
  submodules: z.array(worktreeSubmoduleMergeFactSchema),
  atBaseCommit: z.boolean(),
});
export type WorktreeHostEntryV11 = z.infer<typeof worktreeHostEntrySchemaV11>;

/**
 * `worktree.listAllForHost` v1.2 entry. The only wire-shape change from v1.1 is
 * the additive `atPinnedCommit` proof on each owned-submodule fact.
 */
export const worktreeHostEntrySchemaV12 = worktreeHostEntrySchemaV11.extend({
  submodules: z.array(worktreeSubmoduleMergeFactSchemaV12),
});
export type WorktreeHostEntryV12 = z.infer<typeof worktreeHostEntrySchemaV12>;

/**
 * `worktree.listAllForHost` v1.4 entry.
 * `null` means the host has not derived this row yet; clients must not treat schema-safe fallback facts as authoritative until a non-null timestamp arrives.
 */
export const worktreeHostEntrySchemaV14 = worktreeHostEntrySchemaV12.extend({
  resolvedAt: z.number().nonnegative().nullable(),
});
export type WorktreeHostEntryV14 = z.infer<typeof worktreeHostEntrySchemaV14>;

/** `worktree.listAllForHost` v1.5 entry. */
export const worktreeHostEntrySchemaV15 = worktreeHostEntrySchemaV14.extend({
  presence: workspacePresenceSchema,
});
export type WorktreeHostEntryV15 = z.infer<typeof worktreeHostEntrySchemaV15>;

/**
 * `worktree.listAllForHost` v1.6 entry.
 * The row IS resolved; its branch and dirty count are unknowable, so clients must not treat it as clean.
 */
export const worktreeHostEntrySchemaV16 = worktreeHostEntrySchemaV15.extend({
  gitUnreadable: z.boolean(),
});
export type WorktreeHostEntryV16 = z.infer<typeof worktreeHostEntrySchemaV16>;

/**
 * `worktree.listAllForHost` v1.1 request.
 * Probes run concurrently, best-effort - a failed probe yields `null`, never fails the listing.
 */
export const worktreeListAllForHostRequestSchemaV11 =
  worktreeListAllForHostRequestSchema
    .extend({
      includeActivity: z.boolean(),
      activityPaths: z.array(z.string()).nullable(),
      cursor: z.string().nullable(),
      // A page size is a count: reject 0, negatives, and fractions. `null` still
      // means "no limit" (the v1.0 full-list posture, allowed only without probes).
      limit: z.number().int().positive().nullable(),
    })
    .superRefine((request, context) => {
      if (request.activityPaths === null) {
        if (request.includeActivity && request.limit === null) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "includeActivity requires a finite limit in paged listing mode",
            path: ["limit"],
          });
        }
        return;
      }

      if (request.cursor !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "selection mode requires cursor to be null",
          path: ["cursor"],
        });
      }

      if (request.limit !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "selection mode requires limit to be null",
          path: ["limit"],
        });
      }
    });
export type WorktreeListAllForHostRequestV11 = z.infer<
  typeof worktreeListAllForHostRequestSchemaV11
>;

/**
 * `worktree.listAllForHost` v1.2 request. Unchanged from v1.1; the minor bump is
 * solely for the additive response fact field.
 */
export const worktreeListAllForHostRequestSchemaV12 =
  worktreeListAllForHostRequestSchemaV11;
export type WorktreeListAllForHostRequestV12 = WorktreeListAllForHostRequestV11;

/** `worktree.listAllForHost` v1.1 response. */
export const worktreeListAllForHostResponseSchemaV11 = z.object({
  worktrees: z.array(worktreeHostEntrySchemaV11),
  nextCursor: z.string().nullable(),
});
export type WorktreeListAllForHostResponseV11 = z.infer<
  typeof worktreeListAllForHostResponseSchemaV11
>;

/**
 * `worktree.listAllForHost` v1.2 response. Same pagination envelope as v1.1,
 * with v1.2 entries carrying `submodules[].atPinnedCommit`.
 */
export const worktreeListAllForHostResponseSchemaV12 = z.object({
  worktrees: z.array(worktreeHostEntrySchemaV12),
  nextCursor: z.string().nullable(),
});
export type WorktreeListAllForHostResponseV12 = z.infer<
  typeof worktreeListAllForHostResponseSchemaV12
>;

/**
 * `worktree.listAllForHost` v1.3 request.
 * An older peer that never sends the field upgrades to `forceRefresh: false` (cached-read behavior unchanged).
 */
export const worktreeListAllForHostRequestSchemaV13 =
  worktreeListAllForHostRequestSchemaV12.extend({
    forceRefresh: z.boolean(),
  });
export type WorktreeListAllForHostRequestV13 = z.infer<
  typeof worktreeListAllForHostRequestSchemaV13
>;

/**
 * `worktree.listAllForHost` v1.3 response. Unchanged from v1.2; the minor
 * bump is solely for the additive `forceRefresh` request field.
 */
export const worktreeListAllForHostResponseSchemaV13 =
  worktreeListAllForHostResponseSchemaV12;
export type WorktreeListAllForHostResponseV13 =
  WorktreeListAllForHostResponseV12;

/**
 * `worktree.listAllForHost` v1.4 request. Unchanged from v1.3; the minor bump
 * adds the response freshness marker only.
 */
export const worktreeListAllForHostRequestSchemaV14 =
  worktreeListAllForHostRequestSchemaV13;
export type WorktreeListAllForHostRequestV14 = WorktreeListAllForHostRequestV13;

export const worktreeListAllForHostResponseSchemaV14 = z.object({
  worktrees: z.array(worktreeHostEntrySchemaV14),
  nextCursor: z.string().nullable(),
});
export type WorktreeListAllForHostResponseV14 = z.infer<
  typeof worktreeListAllForHostResponseSchemaV14
>;

/**
 * `worktree.listAllForHost` v1.5 request. Unchanged from v1.4; this minor
 * adds the response presence fact only.
 */
export const worktreeListAllForHostRequestSchemaV15 =
  worktreeListAllForHostRequestSchemaV14;
export type WorktreeListAllForHostRequestV15 = WorktreeListAllForHostRequestV14;

export const worktreeListAllForHostResponseSchemaV15 = z.object({
  worktrees: z.array(worktreeHostEntrySchemaV15),
  nextCursor: z.string().nullable(),
});
export type WorktreeListAllForHostResponseV15 = z.infer<
  typeof worktreeListAllForHostResponseSchemaV15
>;

/**
 * `worktree.listAllForHost` v1.6 request. Unchanged from v1.5; this minor
 * adds the response `gitUnreadable` fact only.
 */
export const worktreeListAllForHostRequestSchemaV16 =
  worktreeListAllForHostRequestSchemaV15;
export type WorktreeListAllForHostRequestV16 = WorktreeListAllForHostRequestV15;

export const worktreeListAllForHostResponseSchemaV16 = z.object({
  worktrees: z.array(worktreeHostEntrySchemaV16),
  nextCursor: z.string().nullable(),
});
export type WorktreeListAllForHostResponseV16 = z.infer<
  typeof worktreeListAllForHostResponseSchemaV16
>;

/**
 * Returns `null` when no row exists yet so a fresh terminal-agent
 * renders "not selected" without throwing.
 */
export const worktreeGetBindingRequestSchema = z.object({
  ...worktreeOwnerRequestFields,
});
export type WorktreeGetBindingRequest = z.infer<
  typeof worktreeGetBindingRequestSchema
>;

export const worktreeGetBindingResponseSchema = z.object({
  binding: worktreeBindingSchema.nullable(),
  // Computed, ephemeral disk-truth: the `workspacePath` of every binding entry whose effective directory (`worktreePath ?? workspacePath`) is missing on disk, recomputed on each read.
  // Never persisted (the SQLite payload and this wire binding share one type).
  missingWorktreePaths: z.array(z.string()),
});
export type WorktreeGetBindingResponse = z.infer<
  typeof worktreeGetBindingResponseSchema
>;

export const worktreeListBindingsForEpicRequestSchema = z.object({
  epicId: z.string(),
});
export type WorktreeListBindingsForEpicRequest = z.infer<
  typeof worktreeListBindingsForEpicRequestSchema
>;

export const worktreeBindingSelectorDisabledReasonSchema = z.enum([
  "setup_pending",
  "setup_running",
  "setup_failed",
  "setup_cancelled",
  "missing_worktree_path",
]);
export type WorktreeBindingSelectorDisabledReason = z.infer<
  typeof worktreeBindingSelectorDisabledReasonSchema
>;

export const worktreeBindingSelectorSourceSchema = z.object({
  ownerKind: worktreeBindingOwnerKindSchema,
  ownerId: z.string(),
  workspacePath: z.string(),
  isPrimary: z.boolean(),
  mode: worktreeBindingEntryModeSchema,
});
export type WorktreeBindingSelectorSource = z.infer<
  typeof worktreeBindingSelectorSourceSchema
>;

/** Local selector row for Epic-level workspace pickers. */
export const worktreeBindingSelectorRowSchema = z.object({
  hostId: z.string(),
  runningDir: z.string(),
  workspacePath: z.string(),
  worktreePath: z.string().nullable(),
  mode: worktreeBindingEntryModeSchema,
  isGitRepo: z.boolean(),
  repoIdentifier: repoIdentifierSchema.nullable(),
  branch: z.string().nullable(),
  isPrimary: z.boolean(),
  isImported: z.boolean(),
  setupState: worktreeSetupStateSchema,
  disabledReason: worktreeBindingSelectorDisabledReasonSchema.nullable(),
  sources: z.array(worktreeBindingSelectorSourceSchema),
});
export type WorktreeBindingSelectorRow = z.infer<
  typeof worktreeBindingSelectorRowSchema
>;

export const worktreeListBindingsForEpicResponseSchema = z.object({
  rows: z.array(worktreeBindingSelectorRowSchema),
});
export type WorktreeListBindingsForEpicResponse = z.infer<
  typeof worktreeListBindingsForEpicResponseSchema
>;

/** `worktree.listBindingsForEpic` v1.1 response. */
export const worktreeListBindingsForEpicResponseSchemaV11 =
  worktreeListBindingsForEpicResponseSchema.extend({
    folderlessCwd: z.string().min(1).nullable(),
  });
export type WorktreeListBindingsForEpicResponseV11 = z.infer<
  typeof worktreeListBindingsForEpicResponseSchemaV11
>;

/**
 * `worktree.listBindingsForEpic` v1.2 row.
 * Bridged up from a v1.1 host as `false` for every row: a pre-v1.2 host has no pending concept, so its answer is authoritative and must not read as perpetually pending (there is no non-null timestamp coming to clear it).
 */
export const worktreeBindingSelectorRowSchemaV12 =
  worktreeBindingSelectorRowSchema.extend({
    isGitResolvePending: z.boolean(),
  });
export type WorktreeBindingSelectorRowV12 = z.infer<
  typeof worktreeBindingSelectorRowSchemaV12
>;

/**
 * `worktree.listBindingsForEpic` v1.2 response. Unchanged from v1.1 except
 * for the per-row `isGitResolvePending` marker.
 */
export const worktreeListBindingsForEpicResponseSchemaV12 =
  worktreeListBindingsForEpicResponseSchemaV11.extend({
    rows: z.array(worktreeBindingSelectorRowSchemaV12),
  });
export type WorktreeListBindingsForEpicResponseV12 = z.infer<
  typeof worktreeListBindingsForEpicResponseSchemaV12
>;

export const worktreeSetRepoScriptsRequestSchema = z.object({
  epicId: z.string(),
  workspacePath: z.string(),
  setup: osScriptSchema,
  teardown: osScriptSchema,
});
export type WorktreeSetRepoScriptsRequest = z.infer<
  typeof worktreeSetRepoScriptsRequestSchema
>;

export const worktreeSetRepoScriptsResponseSchema = z.object({
  updated: z.boolean(),
});
export type WorktreeSetRepoScriptsResponse = z.infer<
  typeof worktreeSetRepoScriptsResponseSchema
>;

/**
 * `worktree.setRepoBranchPrefix` request.
 * Mirrors `worktreeSetRepoScriptsRequestSchema`'s `epicId`/ `workspacePath` authn/target shape, but the target is always the exact source workspace path (never a new/checkout worktree's own file - see the host resolver.
 */
export const worktreeSetRepoBranchPrefixRequestSchema = z.object({
  epicId: z.string(),
  workspacePath: z.string(),
  branchPrefix: z.string().nullable(),
});
export type WorktreeSetRepoBranchPrefixRequest = z.infer<
  typeof worktreeSetRepoBranchPrefixRequestSchema
>;

export const worktreeSetRepoBranchPrefixResponseSchema = z.object({
  updated: z.boolean(),
});
export type WorktreeSetRepoBranchPrefixResponse = z.infer<
  typeof worktreeSetRepoBranchPrefixResponseSchema
>;
