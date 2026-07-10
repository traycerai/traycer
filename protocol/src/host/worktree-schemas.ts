/**
 * Schemas for the `worktree.*` host RPC surface plus the per-device
 * `WorktreeBinding` projected into chat snapshots. Binding state is local
 * to the host (SQLite); cloud collaborators must not see another
 * collaborator's local paths or setup status.
 *
 * Per-entry `mode` is the source of truth for folder-backed bindings. The
 * optional top-level `workspaceMode` only distinguishes an explicit no-folder
 * owner binding from an old/null empty binding that should inherit the Epic's
 * folders.
 */
import { z } from "zod";

// Inlined to avoid a circular import with `epic-schemas.ts` (which
// references `worktreeIntentSchema`). Structurally compatible with
// `TaskRepoIdentifier`.
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

/**
 * Per-entry mode. A binding may carry a mix - one folder Local, another
 * on a worktree. `mode === "local"` means the working directory is the
 * workspace path itself; `mode === "worktree"` means the entry runs
 * against a sibling worktree directory.
 */
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
 * A submodule branch a worktree binding OWNS - recorded at creation, after the
 * setup script checks each submodule out on a branch matching the parent
 * worktree. This is the *owned* set (what the binding created), distinct from
 * whatever live checkout state a later probe discovers. It exists so the Task
 * merge-rollup can require every owned branch - the superproject binding branch
 * AND each submodule branch - to have landed (True AND). A detached / pinned
 * submodule with no branch is not owned and never recorded here.
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
  // `[]` when the repo has no submodules, or none were checked out on a branch.
  // Optional on the wire: this entry shape is embedded, unversioned, in many
  // already-released response/stream payloads (worktree.create,
  // worktree.getBinding, worktree.import, worktree.retrySetup,
  // worktree.setEntryMode, workspaceBinding.removeEntry, chat.subscribe), so a
  // released host that predates this field simply omits the key - it must not
  // become a required-field wire break. The host's own binding-v1->v2
  // persistence migration still backfills `[]` on every locally-read row, so a
  // current host always produces a concrete array in practice.
  ownedSubmodules: z.array(worktreeOwnedSubmoduleSchema).optional(),
});
export type WorktreeBindingEntry = z.infer<typeof worktreeBindingEntrySchema>;

export const worktreeBindingSchema = z.object({
  workspaceMode: worktreeBindingWorkspaceModeSchema.optional(),
  entries: z.array(worktreeBindingEntrySchema),
});
export type WorktreeBinding = z.infer<typeof worktreeBindingSchema>;

/**
 * Per-OS command shape (Codex-style local environments). `default` is the
 * fallback applied when the host's platform field is empty; the host
 * resolves `macos` / `windows` / `linux` against its own `process.platform`
 * and falls back to `default`. An empty resolved string models "no script
 * configured" - there is no separate optional flag.
 */
export const osScriptSchema = z.object({
  default: z.string(),
  macos: z.string().nullable(),
  windows: z.string().nullable(),
  linux: z.string().nullable(),
});
export type OsScript = z.infer<typeof osScriptSchema>;

/**
 * Setup/teardown scripts for a repo. Persisted as
 * `<repoRoot>/.traycer/environment.json` on the host's disk (committable
 * & shareable, Codex-style) - no longer in host-local SQLite. The file is
 * keyed by the workspace's git toplevel; the owning repo is conveyed by the
 * enclosing `WorktreeWorkspaceSummary.repoIdentifier`, so it is not
 * duplicated here. `updatedAt` is stamped on every write.
 */
export const workspaceScriptsSchema = z.object({
  setup: osScriptSchema,
  teardown: osScriptSchema,
  updatedAt: z.number(),
});
export type WorkspaceScripts = z.infer<typeof workspaceScriptsSchema>;

/**
 * Branch selection for a `kind: "worktree"` folder intent.
 *
 * `new` forks a fresh branch from `source` (a branch name; default = the
 * current branch) and `carryUncommittedChanges` snapshots the source's
 * tracked + untracked work into the new worktree.
 *
 * `existing` checks an already-existing branch out into a fresh worktree with
 * no new branch (`git worktree add` without `-b`); it carries nothing.
 *
 * Both variants carry `name` as `min(1)`: a git branch name is never empty, so
 * an empty name is structurally impossible to express on either side.
 */
export const worktreeBranchSelectionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("new"),
    name: z.string().min(1),
    // A fork source is a branch name, never empty - `min(1)` rejects a malformed
    // empty-source request at the schema boundary (consistent with `name`).
    source: z.string().min(1),
    carryUncommittedChanges: z.boolean(),
  }),
  z.object({
    type: z.literal("existing"),
    name: z.string().min(1),
  }),
]);
export type WorktreeBranchSelection = z.infer<
  typeof worktreeBranchSelectionSchema
>;

/**
 * Setup/teardown override carried on a `kind:"worktree"` folder intent. The
 * user enters/prefills these in the Environment chip; the host writes them
 * into the new worktree's `<root>/.traycer/environment.json` at create time
 * (before reading + running setup), so the override reaches the worktree
 * without ever writing the source checkout. `updatedAt` is omitted here - it
 * is stamped by `writeWorkspaceScriptsAtRoot` on write.
 */
export const worktreeEntryScriptsSchema = z.object({
  setup: osScriptSchema,
  teardown: osScriptSchema,
});
export type WorktreeEntryScripts = z.infer<typeof worktreeEntryScriptsSchema>;

/**
 * Fields shared by every folder-intent variant. `repoIdentifier` is preferred
 * over origin parsing so workspaces without a parseable `origin` still resolve
 * repo-scoped base paths and scripts.
 */
const worktreeFolderIntentBaseShape = {
  workspacePath: z.string(),
  repoIdentifier: repoIdentifierSchema.nullable(),
  isPrimary: z.boolean(),
} as const;

/**
 * The canonical "what the user picked for this folder" shape - staged at pick
 * time and materialized into a binding at send / turn-start. One representation
 * for every mode:
 *  - `local`    - run against the workspace checkout itself (no git).
 *  - `import`   - adopt an existing on-disk worktree at `worktreePath`.
 *  - `worktree` - create or check out a worktree per `branch`.
 *
 * Only `worktree` carries a `scripts` override: the Environment chip's
 * setup/teardown (prefilled from the repo's existing values). The host writes
 * it into the new worktree at create, before reading + running setup, so the
 * override reaches the worktree without writing the source checkout. `null`
 * leaves whatever the branch committed untouched.
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

export const diskWorktreeEntrySchema = z.object({
  worktreePath: z.string(),
  branch: z.string().nullable(),
  // Best-effort branch this worktree was forked / checked out from. Git does
  // not store this as first-class worktree metadata, so older / detached rows
  // may omit it or report null.
  sourceBranch: z.string().nullable().optional(),
  head: z.string().nullable(),
  isMain: z.boolean(),
  isLocked: z.boolean(),
});
export type DiskWorktreeEntry = z.infer<typeof diskWorktreeEntrySchema>;

export const worktreeWorkspaceSummarySchema = z.object({
  workspacePath: z.string(),
  // Use this - not `repoIdentifier !== null` - to gate worktree-create /
  // worktree-import affordances. `repoIdentifier` may be populated from a
  // cloud association for a non-git folder so per-repo scripts still
  // resolve, so it cannot stand in for git eligibility.
  isGitRepo: z.boolean(),
  repoIdentifier: repoIdentifierSchema.nullable(),
  mainBranch: z.string().nullable(),
  worktrees: z.array(diskWorktreeEntrySchema),
  scripts: workspaceScriptsSchema.nullable(),
});
export type WorktreeWorkspaceSummary = z.infer<
  typeof worktreeWorkspaceSummarySchema
>;

/**
 * Pre-Epic disk-truth listing. `repoIdentifier` here is sourced from the disk
 * `origin` only - callers may supplement with a workspace-known association
 * before forwarding to create/import.
 */
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
 * One committed-scripts-at-ref read request. `ref` is a branch name - the fork
 * `source` for a new branch, or the branch `name` for an existing-branch
 * checkout. The host reads the committed `<repoRoot>/.traycer/environment.json`
 * at that ref (`git show <ref>:.traycer/environment.json`) without checking it
 * out - exactly one `git show` per entry, never a walk of every branch.
 */
export const worktreeScriptRefSchema = z.object({
  workspacePath: z.string(),
  ref: z.string().min(1),
});
export type WorktreeScriptRef = z.infer<typeof worktreeScriptRefSchema>;

/**
 * The committed scripts resolved for one requested {@link WorktreeScriptRef}.
 * `scripts` is `null` when the ref carries no committed `environment.json` (or
 * the file fails schema validation), so the renderer falls back to its prior
 * seed.
 */
export const worktreeScriptsAtRefSchema = z.object({
  workspacePath: z.string(),
  ref: z.string(),
  scripts: workspaceScriptsSchema.nullable(),
});
export type WorktreeScriptsAtRef = z.infer<typeof worktreeScriptsAtRefSchema>;

/**
 * `worktree.listByWorkspacePaths` v1.1 request. Adds `scriptRefs` - a batch of
 * committed-scripts-at-ref reads - so the create-worktree Environment editor can
 * preview a SOURCE branch's scripts WITHOUT a dedicated `worktree.readScriptsAtRef`
 * method (the wire method-set must stay identical to v1.0.0; see the RPC
 * backward-compat decision log). Reading is per-ref and lazy: one `git show` per
 * entry. Pass `[]` to list workspaces only; pass `workspacePaths: []` with a
 * single `scriptRefs` entry for a pure point-read (the create-worktree dialog's
 * preview path).
 */
export const worktreeListByWorkspacePathsRequestSchemaV11 =
  worktreeListByWorkspacePathsRequestSchema.extend({
    scriptRefs: z.array(worktreeScriptRefSchema),
  });
export type WorktreeListByWorkspacePathsRequestV11 = z.infer<
  typeof worktreeListByWorkspacePathsRequestSchemaV11
>;

/**
 * `worktree.listByWorkspacePaths` v1.1 response. Adds `scriptsAtRefs`, one entry
 * per request `scriptRefs` entry (order-aligned). Empty when no refs were
 * requested, or `[]` after bridging down to a v1.0 host (the renderer then falls
 * back to the primary checkout's on-disk scripts).
 */
export const worktreeListByWorkspacePathsResponseSchemaV11 =
  worktreeListByWorkspacePathsResponseSchema.extend({
    scriptsAtRefs: z.array(worktreeScriptsAtRefSchema),
  });
export type WorktreeListByWorkspacePathsResponseV11 = z.infer<
  typeof worktreeListByWorkspacePathsResponseSchemaV11
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
  /**
   * Count of distinct paths surfaced by `git status --porcelain -uall`.
   * Drives the "Working tree (N file changes)" pseudo-entry the
   * Create-worktree modal injects above the current branch when the
   * working tree is dirty - picking that entry triggers the carry-stash
   * path on the host. Consumers derive presence as `count > 0`.
   */
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

// `worktree.create` takes the canonical folder-intent union directly: the
// orchestrator resolves each entry's `kind` (and, for `worktree`, its
// `branch.type`) into a binding. The `perEntry` channel reports per-folder
// success/failure unchanged.
export const worktreeCreateRequestSchema = z.object({
  ...worktreeOwnerRequestFields,
  entries: z.array(worktreeFolderIntentSchema),
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
 * Entry for `worktree.createPaths` - the ownerless "just make the worktree
 * directories and return their paths" flow. Intentionally minimal: the caller
 * states only which workspace and a `branch` selection (the same union the
 * owner-bound `worktree.create` folder intent uses), so this flow can create a
 * new branch or check an existing branch out into a fresh worktree.
 *
 * It does NOT carry `repoIdentifier` or `isPrimary`:
 *  - `repoIdentifier` (where the worktree is bucketed on disk) is derived by
 *    the host from the workspace's git remote. The caller - a CLI/agent on
 *    the same machine - has no more authoritative source than the host, so
 *    asking for it is pure burden. The host falls back to a local base path
 *    when the remote is unparseable. The derived value is echoed in the
 *    response so the caller still learns where it landed.
 *  - `isPrimary` (which directory an AGENT runs in) is decided later, when the
 *    paths are bound to an agent (`agent.create`'s `workspace.entries`).
 *
 * Contrast the owner-bound `worktree.create` folder intent
 * (`worktreeFolderIntentSchema`), which keeps both because that flow is driven
 * by epic/cloud metadata that is authoritative and may differ from local git.
 */
export const worktreeCreatePathsEntrySchema = z.object({
  workspacePath: z.string(),
  branch: worktreeBranchSelectionSchema,
});
export type WorktreeCreatePathsEntry = z.infer<
  typeof worktreeCreatePathsEntrySchema
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
 * `worktreePath` is nullable so a partial multi-repo import keeps every
 * linked workspace in a single request: rows the user chose to leave Local
 * arrive with `worktreePath: null` and persist as Local binding entries
 * instead of dropping out.
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

/**
 * Per-folder Local mode flip. Sibling entries in the binding are
 * preserved. Transitions into "worktree" mode go through `worktree.create`
 * / `worktree.import`, which already write per-entry mode and carry the
 * branch / worktreePath the entry needs.
 */
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
 * Owner-scoped folder removal. This only removes one entry from the local
 * chat/terminal-agent binding. The host may audit and detach an orphaned
 * Epic-level workspace association in the background; it never deletes any
 * on-disk worktree.
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

// `epicId` scopes the teardown terminal to the current Epic so the tab
// appears in that Epic's terminal context. `worktreePath` still drives the
// deterministic teardown session id and the busy-check / unlink paths.
export const worktreeDeleteRequestSchema = z.object({
  epicId: z.string(),
  workspacePath: z.string(),
  worktreePath: z.string(),
});
export type WorktreeDeleteRequest = z.infer<typeof worktreeDeleteRequestSchema>;

export const worktreeDeleteResponseSchema = z.object({
  deleted: z.boolean(),
});
export type WorktreeDeleteResponse = z.infer<
  typeof worktreeDeleteResponseSchema
>;

/**
 * One worktree under the host's `~/.traycer/worktrees/` creation path,
 * for the Settings ▸ Worktrees section. The list is **disk-truth** (a walk
 * of that directory), so a worktree whose owning epic/chat was deleted but
 * whose folder lingers - an orphan - still surfaces. Binding state is
 * cross-referenced only to compute `inUse`.
 */
export const worktreeHostEntrySchema = z.object({
  worktreePath: z.string(),
  // "owner/repo" or a local basename - drives client-side grouping/display.
  repoLabel: z.string(),
  repoIdentifier: repoIdentifierSchema.nullable(),
  // Branch checked out in the worktree itself (not the repo's main branch).
  branch: z.string().nullable(),
  // Bound to an active chat/agent OR an active-run cwd (path-driven busy
  // check). Disables the row's delete; the host also rejects an in-use
  // delete as a backstop.
  inUse: z.boolean(),
  // Distinct paths from `git status --porcelain -uall`; 0 = clean.
  uncommittedCount: z.number().int().nonnegative(),
  // `false` when the main repo is unresolvable (orphan dir git no longer
  // tracks), so delete falls back to an `fs.rm` cleanup instead of
  // `git worktree remove`.
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

/**
 * One persisted `WorktreeBindingV1` reference that points at a host worktree,
 * joined into the v1.1 listing so callers can see WHICH epics/sessions still
 * reference a path. An empty `owners` array on an entry means no binding
 * references it ("unreferenced" - distinct from the disk-orphan `gitRemovable:
 * false` signal). `updatedAt` is the binding row's last-touch stamp, one of the
 * inputs to the derived `lastActivityAt`.
 */
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
 * Best-effort branch position for a worktree, probed only when the v1.1 request
 * sets `includeActivity: true`. Present whenever the default branch resolves -
 * `mergedIntoDefault` is derived from LOCAL ancestry and needs no upstream, so a
 * never-pushed branch still gets a real object. `ahead`/`behind` are the
 * upstream diff and go `null` when the branch has no upstream to diff against
 * (they say nothing about merged state - read `mergedIntoDefault` for that).
 * The whole object is `null` only when the position can't be probed at all: a
 * detached HEAD, or an unresolvable default branch (see `branchStatus` on the
 * v1.1 entry). A failed probe never fails the listing.
 */
export const worktreeBranchStatusSchema = z.object({
  // Commits on HEAD not on its upstream / on upstream not on HEAD. `null` when
  // the branch has no upstream (never pushed) - "unknown position", never
  // "zero". `mergedIntoDefault` is the independent, upstream-free signal.
  ahead: z.number().int().nonnegative().nullable(),
  behind: z.number().int().nonnegative().nullable(),
  // `merge-base --is-ancestor HEAD <default>`: the branch's HEAD is fully
  // contained in the repo's default branch, so removing the worktree loses no
  // unmerged commits. Computed from LOCAL ancestry - independent of any
  // upstream - so it holds even for a never-pushed branch.
  mergedIntoDefault: z.boolean(),
});
export type WorktreeBranchStatus = z.infer<typeof worktreeBranchStatusSchema>;

/**
 * GitHub PR merge state for a branch, as discovered by the host's best-effort
 * local `gh` probe. `"none"` is the catch-all no-green state: EITHER the probe
 * ran and found no PR, OR the probe could not run at all (`gh` absent / unauth /
 * timed out / errored) - the host cannot distinguish these via its string-only
 * runner, so both collapse to `"none"` (a short-TTL negative). The entry
 * `prState` is `null` only when the branch was NOT probed (e.g.
 * `includeActivity: false`). Either way PR data contributes no green and the
 * classifier degrades to the local-ancestry and at-base signals, never an error.
 */
export const worktreePrStateSchema = z.enum([
  "merged",
  "open",
  "closed",
  "none",
]);
export type WorktreePrState = z.infer<typeof worktreePrStateSchema>;

/**
 * Per-owned-submodule merge facts, joined onto a v1.1 listing entry so the Task
 * merge-rollup (True AND across the superproject and every owned submodule) is
 * pure client work. Mirrors the superproject's PR fields plus the local-ancestry
 * `mergedIntoDefault`. `mergedHeadShaMatches` is the host's live-HEAD comparison
 * (submodule HEAD === the merged head SHA) so the pure client classifier never
 * needs the SHA itself.
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

/**
 * v1.2 adds the submodule equivalent of `atBaseCommit`: the owned branch's live
 * checkout or resolved tip is exactly the superproject's pinned gitlink, so it
 * carries no committed work beyond what the superproject already references.
 */
export const worktreeSubmoduleMergeFactSchemaV12 =
  worktreeSubmoduleMergeFactSchema.extend({
    atPinnedCommit: z.boolean(),
  });
export type WorktreeSubmoduleMergeFactV12 = z.infer<
  typeof worktreeSubmoduleMergeFactSchemaV12
>;

/**
 * `worktree.listAllForHost` v1.1 entry. Adds the staleness signals the
 * housekeeping skill and the Settings ▸ Worktrees tab use, on top of every
 * v1.0 field.
 *
 * `includeActivity` gates ONLY the git probes - `lastActivityAt` and
 * `branchStatus` - which carry the per-worktree cost; both are `null` when the
 * flag is `false`. The other two fields are cheap and ALWAYS populated,
 * regardless of the flag:
 *  - `owners` - a SQLite binding-table read (the same join `ensureIndexHydrated`
 *    already performs). Consumers rely on this being present even with
 *    `includeActivity: false`: the Task-delete dialog derives "unreferenced"
 *    worktrees purely from `owners` (owner set ⊆ the deleted epics, and
 *    `!inUse`) with no activity probes at all.
 *  - `createdAt` - a single fs stat (worktree dir birthtime).
 */
export const worktreeHostEntrySchemaV11 = worktreeHostEntrySchema.extend({
  // max(git HEAD reflog last entry, binding `updatedAt` for this path).
  // Derived, never persisted. `null` when `includeActivity` is false or no
  // signal is available.
  lastActivityAt: z.number().nullable(),
  // Persisted `WorktreeBindingV1` rows (this host) whose effective directory is
  // this worktree. `[]` = unreferenced.
  owners: z.array(worktreeHostEntryOwnerSchema),
  // `null` when detached / default branch unresolvable / probe failed /
  // `includeActivity` false. A never-pushed branch is NOT null here: its
  // `mergedIntoDefault` is proved from local ancestry (with `ahead`/`behind`
  // null). Null therefore means "position unknown", never "no upstream".
  branchStatus: worktreeBranchStatusSchema.nullable(),
  // Worktree dir birthtime (fs stat) - a fallback age signal. `null` when stat
  // is unavailable.
  createdAt: z.number().nullable(),
  // Superproject PR facts from the host's best-effort `gh` probe. When the
  // branch WAS probed but no green PR resulted - no PR found, or `gh`
  // absent/unauth/failed (indistinguishable to the host) - `prState` is `"none"`
  // and `prNumber`/`prUrl` are `null`. `prState` is `null` only when the branch
  // was NOT probed (`includeActivity: false`). `mergedHeadShaMatches` is the
  // host's live-HEAD comparison (HEAD === the merged head SHA) - the pure client
  // classifier greens `Merged (PR)` on `prState === "merged" &&
  // mergedHeadShaMatches`, so it never needs the SHA. `false` whenever unproven.
  prState: worktreePrStateSchema.nullable(),
  prNumber: z.number().int().nullable(),
  prUrl: z.string().nullable(),
  mergedHeadShaMatches: z.boolean(),
  // Per-owned-submodule merge facts for the True-AND Task rollup. `[]` when the
  // worktree owns no submodule branches or `includeActivity` is false.
  submodules: z.array(worktreeSubmoduleMergeFactSchema),
  // Host-computed "At base commit" signal: the worktree is untouched - clean,
  // its HEAD is contained in the default branch, and its HEAD reflog carries no
  // authored-`commit` entry. Derived retroactively from signals available for
  // EVERY worktree (no creation-time anchor), so it works for pre-existing and
  // imported worktrees too:
  //   `uncommittedCount === 0 && branchStatus.mergedIntoDefault === true &&
  //    hasReflogCommits === false`.
  // `mergedIntoDefault` is the REQUIRED safety floor (HEAD contained in default
  // ⇒ deleting loses nothing); the reflog-no-`commit` guard only splits the
  // LABEL (an untouched worktree reads "At base commit" instead of "Merged").
  // The pure client classifier greens "At base commit" on this boolean alone.
  // FAILS CLOSED: an unknown reflog (`null`) is NOT at-base. `false` whenever
  // unproven: dirty, HEAD not contained in default, an authored-commit reflog
  // entry, or `includeActivity` false (the probes are gated).
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
 * `worktree.listAllForHost` v1.1 request. Adds `includeActivity`: the git
 * probes (reflog, ahead/behind, merged) add per-worktree cost, so the Settings
 * tab passes `false` (or stays on v1.0) to keep the panel snappy while the
 * housekeeping CLI passes `true`. Probes run concurrently, best-effort - a
 * failed probe yields `null`, never fails the listing. The flag gates ONLY
 * these git probes (`lastActivityAt`, `branchStatus`); `owners` and `createdAt`
 * are cheap and returned either way.
 *
 * The request has two mutually-exclusive modes:
 *  - Paged listing mode (`activityPaths: null`): `cursor` and `limit` apply.
 *    The cursor is a `worktreePath`; the host returns entries strictly after it
 *    in stable path-lexicographic order. `limit: null` preserves the v1.0
 *    bridge's full-list posture, but only without activity probes: no request
 *    can buy an unbounded probe pass.
 *  - Selection mode (`activityPaths: [<worktreePath>, ...]`): probes are
 *    bounded by the array itself, so `cursor` and `limit` must both be `null`
 *    and the response's `nextCursor` is `null`.
 *
 * `activityPaths` selects between two response modes, so the GUI can render the
 * base list instantly and then lazily enrich only the rows scrolled into view
 * instead of paying the whole-list probe cost up front:
 *  - `activityPaths: null` (default): unchanged - return ALL worktrees, each
 *    enriched iff `includeActivity` is true, else base-only.
 *  - `activityPaths: [<worktreePath>, ...]`: per-viewport lazy-enrichment mode.
 *    Return ONLY the worktrees whose path matches one of these (host-normalized
 *    compare), each FULLY enriched - the activity probes run for them REGARDLESS
 *    of `includeActivity`. Paths not found on disk are omitted (no error). Pass
 *    `[]` to enrich nothing (returns no worktrees).
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
export type WorktreeListAllForHostRequestV12 =
  WorktreeListAllForHostRequestV11;

/**
 * `worktree.listAllForHost` v1.1 response. Same `worktrees` field, enriched
 * entry shape ({@link worktreeHostEntrySchemaV11}), plus `nextCursor` for the
 * caller to continue when more entries remain.
 */
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
  // Computed, ephemeral disk-truth: the `workspacePath` of every binding entry
  // whose effective directory (`worktreePath ?? workspacePath`) is missing on
  // disk, recomputed on each read. Never persisted (the SQLite payload and this
  // wire binding share one type). The terminal-agent toolbar gates launch on
  // this; `[]` when the binding is null or every bound directory exists.
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

/**
 * Local selector row for Epic-level workspace pickers. `runningDir` is the
 * actual directory Git commands should run against: `workspacePath` for
 * Local rows, `worktreePath` for Worktree rows. Rows are deduped by
 * `(hostId, runningDir)` and carry source owner refs so the GUI can
 * resolve current chat/agent names without host coupling. `isGitRepo`
 * tells Git surfaces whether the row can run Git operations; file tree and
 * terminal surfaces can still use non-git rows.
 */
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

/**
 * `worktree.listBindingsForEpic` v1.1 response. Adds `folderlessCwd` - the
 * host-owned fallback cwd (the epic's root directory) for terminal launches on
 * an epic with no bound workspace rows - so folderless epics need no dedicated
 * RPC (the wire method-set must stay identical to v1.0.0; see the RPC
 * backward-compat decision log). `null` only after bridging up from a v1.0
 * host, which predates folderless workspaces; the picker then keeps its
 * launch action disabled.
 */
export const worktreeListBindingsForEpicResponseSchemaV11 =
  worktreeListBindingsForEpicResponseSchema.extend({
    folderlessCwd: z.string().min(1).nullable(),
  });
export type WorktreeListBindingsForEpicResponseV11 = z.infer<
  typeof worktreeListBindingsForEpicResponseSchemaV11
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
