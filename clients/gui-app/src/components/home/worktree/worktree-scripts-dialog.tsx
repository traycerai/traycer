import { useCallback, useMemo, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import type {
  RepoBranchPrefixState,
  WorktreeBinding,
  WorktreeBindingEntry,
  WorktreeBindingOwnerKind,
  WorktreeEntryScripts,
  WorktreeFolderIntent,
  WorktreeWorkspaceSummaryV14,
} from "@traycer/protocol/host/worktree-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useWorktreeSetRepoScriptsFor } from "@/hooks/worktree/use-worktree-set-repo-scripts-mutation";
import { ScriptsReviewDialog } from "@/components/workspaces/scripts-review-dialog";
import { type RepoScriptsSeed } from "@/components/workspaces/repo-scripts-form";
import { RepoBranchPrefixSection } from "@/components/home/worktree/repo-branch-prefix-section";
import { Button } from "@/components/ui/button";
import {
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";

/** Pre-create surfaces (landing / launcher / fork) pass `epicId: ""`, `ownerId: null`, `binding: null` - the
 * edit can only ride the staged intent or write the repo's own file (Local). */
export interface WorktreeScriptsContext {
  readonly epicId: string;
  readonly ownerId: string | null;
  readonly ownerKind: WorktreeBindingOwnerKind | null;
  readonly binding: WorktreeBinding | null;
  readonly stagingKey: WorktreeStagingKey;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  /** Deliberately synchronous and independent of the summary-invalidation refetch a save also triggers - that
   * refetch lands on its own time and this must not wait on it. */
  readonly regenerateBranchNameForWorkspace: (
    workspacePath: string,
    freshRepoBranchPrefix: RepoBranchPrefixState,
    suffix: string,
  ) => string | null;
}

export interface WorktreeScriptsTarget {
  readonly workspacePath: string;
  readonly summary: WorktreeWorkspaceSummaryV14;
}

/** Per-folder setup/teardown editor, opened from the workspace picker's Environment footer. */
export function WorktreeScriptsDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly target: WorktreeScriptsTarget | null;
  readonly context: WorktreeScriptsContext;
}) {
  if (!props.open || props.target === null) return null;
  return (
    <WorktreeScriptsDialogBody
      workspacePath={props.target.workspacePath}
      summary={props.target.summary}
      context={props.context}
      onOpenChange={props.onOpenChange}
    />
  );
}

/** A genuine switch to Local always stages an explicit `kind: "local"` entry (never an unstage), so holding
 * here never masks a real user choice. */
function useHeldStagedEntry(
  stagedEntry: WorktreeFolderIntent | null,
  workspacePath: string,
): WorktreeFolderIntent | null {
  const [held, setHeld] = useState<{
    readonly workspacePath: string;
    readonly entry: WorktreeFolderIntent;
  } | null>(null);
  if (
    stagedEntry !== null &&
    (held === null ||
      held.workspacePath !== workspacePath ||
      held.entry !== stagedEntry)
  ) {
    setHeld({ workspacePath, entry: stagedEntry });
  }
  return (
    stagedEntry ?? (held?.workspacePath === workspacePath ? held.entry : null)
  );
}

function WorktreeScriptsDialogBody(props: {
  readonly workspacePath: string;
  readonly summary: WorktreeWorkspaceSummaryV14;
  readonly context: WorktreeScriptsContext;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { context, summary, workspacePath } = props;
  const stageScripts = useWorktreeIntentStagingStore((s) => s.stageScripts);
  const stageBranchName = useWorktreeIntentStagingStore(
    (s) => s.stageBranchName,
  );
  const stagedEntry = useWorktreeIntentStagingStore(
    (s) =>
      s.intentByKey[worktreeStagingKeyString(context.stagingKey)]?.entries.find(
        (entry) => entry.workspacePath === workspacePath,
      ) ?? null,
  );
  const effectiveStagedEntry = useHeldStagedEntry(stagedEntry, workspacePath);
  const bindingEntry =
    context.binding?.entries.find(
      (entry) => entry.workspacePath === workspacePath,
    ) ?? null;

  const resolved = resolveScriptsTarget({
    stagedEntry: effectiveStagedEntry,
    bindingEntry,
  });

  // An existing worktree prefills from its own env file - the same host-wide source Settings reads (shared query
  // key, so this is a warm cache hit once the picker has fetched it, not a new round-trip).
  const hostWorktreesQuery = useHostQuery<
    HostRpcRegistry,
    "worktree.listAllForHost"
  >({
    cacheKeyIdentity: undefined,
    client: context.hostClient,
    method: "worktree.listAllForHost",
    // Whole-list mode (no per-viewport selection); base fields only.
    params: {
      includeActivity: false,
      activityPaths: null,
      cursor: null,
      limit: null,
      // A background read: serve the host's TTL-cached view. Only the
      // Settings toolbar's explicit Refresh forces a disk recompute.
      forceRefresh: false,
    },
    options: { enabled: resolved.kind === "existing-worktree" },
  });
  const worktreeOwnScripts = useMemo<RepoScriptsSeed | null>(() => {
    if (resolved.kind !== "existing-worktree") return null;
    const match = (hostWorktreesQuery.data?.worktrees ?? []).find(
      (entry) => entry.worktreePath === resolved.worktreePath,
    );
    return match?.scripts ?? null;
  }, [hostWorktreesQuery.data, resolved]);

  // A new/checkout worktree forks from a source ref, so it inherits that ref's committed
  // `.traycer/environment.json` - not the primary checkout's on-disk file (`summary.scripts`).
  const sourceRef = sourceRefForStagedEntry(effectiveStagedEntry);
  // There is no dedicated `worktree.readScriptsAtRef` method - a new method name would break the wire method-set
  // against an older host.
  const branchScriptsQuery = useHostQuery<
    HostRpcRegistry,
    "worktree.listByWorkspacePaths"
  >({
    cacheKeyIdentity: undefined,
    client: context.hostClient,
    method: "worktree.listByWorkspacePaths",
    params: {
      workspacePaths: [],
      scriptRefs: sourceRef !== null ? [{ workspacePath, ref: sourceRef }] : [],
      // A pure `git show` point-read at a ref; the ttl-cached workspace summaries this flag governs are not even
      // consulted, so a forced recompute would buy nothing.
      forceRefresh: false,
    },
    options: { enabled: sourceRef !== null },
  });
  const branchScripts =
    branchScriptsQuery.data?.scriptsAtRefs[0]?.scripts ?? null;
  // The source-branch read is "settled" once it succeeds or errors; until then (and only when no staged edit
  // already supplies the seed) the dialog shows a spinner instead of flashing the primary checkout's scripts.
  const branchReadSettled =
    sourceRef === null ||
    branchScriptsQuery.isSuccess ||
    branchScriptsQuery.isError;
  // A failed source-branch read is distinct from "no committed scripts": it must not silently seed the primary
  // checkout (the stale value this whole flow avoids).
  const branchReadFailed = sourceRef !== null && branchScriptsQuery.isError;
  const stagedScripts =
    effectiveStagedEntry !== null && effectiveStagedEntry.kind === "worktree"
      ? effectiveStagedEntry.scripts
      : null;
  const seedPending = !branchReadSettled && stagedScripts === null;

  const saveMutation = useWorktreeSetRepoScriptsFor(context.hostClient);

  // Radix's Dialog dismissable layer listens for Escape on `document` in the capture phase - before any bubbling
  // `onKeyDown` inside the content ever runs.
  const cancelBranchEditingRef = useRef<(() => void) | null>(null);
  const handleEditingCancelAvailable = useCallback(
    (cancel: (() => void) | null): void => {
      cancelBranchEditingRef.current = cancel;
    },
    [],
  );

  const scriptSeed = resolveScriptSeed({
    resolved,
    summary,
    stagedEntry: effectiveStagedEntry,
    worktreeOwnScripts,
    branchScripts,
    branchReadFailed,
  });
  const descriptor = describeTarget({ resolved, workspacePath });

  const handleSave = (scripts: WorktreeEntryScripts): Promise<unknown> => {
    if (
      resolved.kind === "new-branch-worktree" ||
      resolved.kind === "checkout-branch-worktree"
    ) {
      // Staging a worktree intent is a synchronous store write that cannot fail.
      stageScripts(context.stagingKey, workspacePath, scripts);
      return Promise.resolve();
    }
    const targetPath =
      resolved.kind === "existing-worktree"
        ? resolved.worktreePath
        : workspacePath;
    // `mutateAsync` rejects on a host/write failure, so the dialog won't show a
    // false "Saved" (the mutation's onError still surfaces the toast).
    return saveMutation.mutateAsync({
      epicId: context.epicId,
      workspacePath: targetPath,
      setup: scripts.setup,
      teardown: scripts.teardown,
    });
  };

  // Re-seed when the async source for this target resolves (cold cache only;
  // the picker usually warms these queries before the footer is clicked).
  const seedKey = resolveSeedKey({
    resolved,
    workspacePath,
    sourceRef,
    worktreeScriptsResolved: hostWorktreesQuery.isSuccess,
    branchScriptsResolved: branchReadSettled,
  });

  return (
    <ScriptsReviewDialog
      key={seedKey}
      testId="worktree-scripts-dialog"
      title="Worktree environment"
      description={environmentDialogDescription(summary, workspacePath)}
      pathLabel={descriptor.pathLabel}
      pathValue={descriptor.pathValue}
      scriptSeed={scriptSeed}
      seedPending={seedPending}
      errorNote={
        branchReadFailed
          ? "Couldn't read this branch's committed scripts — starting blank. Saving will set new scripts for the worktree."
          : null
      }
      scriptsNote={descriptor.scriptsNote}
      // `null`, not an always-truthy element wrapping a component that internally renders nothing, so
      // `ScriptsReviewDialog` can tell a real Branch naming section apart from "none for this non-Git folder".
      repositoryDefaultsSlot={
        summary.isGitRepo ? (
          <RepositoryDefaultsSlot
            workspacePath={workspacePath}
            summary={summary}
            context={context}
            stagedEntry={effectiveStagedEntry}
            stageBranchName={stageBranchName}
            currentProposedBranchName={
              resolved.kind === "new-branch-worktree"
                ? resolved.branchName
                : null
            }
            onEditingCancelAvailable={handleEditingCancelAvailable}
          />
        ) : null
      }
      inUseNote={null}
      saveLabel="Save scripts"
      onSave={handleSave}
      onEscapeKeyDown={(event) => {
        if (cancelBranchEditingRef.current === null) return;
        event.preventDefault();
        cancelBranchEditingRef.current();
      }}
      onOpenChange={props.onOpenChange}
    />
  );
}

/** Dialog-wide description naming both concerns the "Worktree environment" dialog hierarchy covers
 * (core-flows/worktree-environment-layered-settings). */
function environmentDialogDescription(
  summary: WorktreeWorkspaceSummaryV14,
  workspacePath: string,
): string {
  const label =
    summary.repoIdentifier !== null
      ? `${summary.repoIdentifier.owner}/${summary.repoIdentifier.repo}`
      : lastPathSegment(workspacePath);
  return summary.isGitRepo
    ? `Configure lifecycle scripts and branch prefix for ${label}.`
    : `Configure lifecycle scripts for ${label}.`;
}

function lastPathSegment(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/);
  return parts.at(-1) ?? path;
}

/** Non-Git folders contractually have no repository override (the ticket: "Non-Git folders have no repository
 * override and use the global fallback"). */
function RepositoryDefaultsSlot(props: {
  readonly workspacePath: string;
  readonly summary: WorktreeWorkspaceSummaryV14;
  readonly context: WorktreeScriptsContext;
  readonly stagedEntry: WorktreeFolderIntent | null;
  readonly stageBranchName: (
    key: WorktreeStagingKey,
    workspacePath: string,
    name: string,
  ) => void;
  // The picker's actual current proposal for this workspace (`null` when there isn't one, e.g. an
  // existing/checked-out branch or a non-worktree target).
  readonly currentProposedBranchName: string | null;
  readonly onEditingCancelAvailable: (cancel: (() => void) | null) => void;
}) {
  const { workspacePath, summary, context } = props;
  // Captured together at the moment Apply/Remove succeeds: `candidate` is the exact string Branch naming
  // displayed as "Effective branch" right then (see `RepoBranchPrefixSection`'s `onSaved`).
  const [regenerateOffer, setRegenerateOffer] = useState<{
    readonly candidate: string;
    readonly previousProposal: string;
  } | null>(null);

  if (!summary.isGitRepo) return null;

  return (
    <div className="flex flex-col gap-3">
      <RepoBranchPrefixSection
        key={workspacePath}
        workspacePath={workspacePath}
        repoIdentifier={summary.repoIdentifier}
        repoBranchPrefixState={summary.repoBranchPrefix}
        epicId={context.epicId}
        hostClient={context.hostClient}
        currentProposedBranchName={props.currentProposedBranchName}
        activeRegenerateCandidate={regenerateOffer?.candidate ?? null}
        composeCandidateBranch={(prefixState, suffix) =>
          context.regenerateBranchNameForWorkspace(
            workspacePath,
            prefixState,
            suffix,
          )
        }
        // `cancel !== null` means Branch naming just entered editing.
        onEditingCancelAvailable={(cancel) => {
          if (cancel !== null) setRegenerateOffer(null);
          props.onEditingCancelAvailable(cancel);
        }}
        // "Single-picker opt-in draft replacement": only offered when this staged intent has a generated (`type:
        // "new"`) branch to replace.
        onSaved={(_newState, candidateBranchName) => {
          setRegenerateOffer(
            candidateBranchName !== null &&
              props.currentProposedBranchName !== null &&
              stagedEntryHasNewBranch(props.stagedEntry)
              ? {
                  candidate: candidateBranchName,
                  previousProposal: props.currentProposedBranchName,
                }
              : null,
          );
        }}
      />
      {regenerateOffer !== null ? (
        <RegenerateBranchNameOffer
          previousProposal={regenerateOffer.previousProposal}
          onDismiss={() => setRegenerateOffer(null)}
          onConfirm={() => {
            props.stageBranchName(
              context.stagingKey,
              workspacePath,
              regenerateOffer.candidate,
            );
            setRegenerateOffer(null);
          }}
        />
      ) : null}
    </div>
  );
}

/** Never fires automatically - the user opts in. */
function RegenerateBranchNameOffer(props: {
  readonly previousProposal: string;
  readonly onConfirm: () => void;
  readonly onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      className="flex gap-2.5 rounded-md border border-amber-500/35 bg-amber-500/10 px-3 py-2.5 text-amber-950 dark:text-amber-100"
      data-testid="repo-branch-prefix-regenerate-offer"
    >
      <TriangleAlert
        className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
        aria-hidden
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-col gap-1">
          <span className="text-ui-sm font-medium">
            Update the staged branch name?
          </span>
          <p className="text-ui-xs text-amber-950/80 dark:text-amber-100/80">
            This picker already proposed{" "}
            <code className="rounded bg-amber-500/15 px-1 py-0.5 font-mono text-amber-950 dark:text-amber-50">
              {props.previousProposal}
            </code>
            . Apply the new prefix to that staged name, or keep it as-is.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-amber-950 hover:bg-amber-500/15 hover:text-amber-950 dark:text-amber-100 dark:hover:bg-amber-500/20 dark:hover:text-amber-50"
            onClick={props.onDismiss}
          >
            Keep current
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-amber-600/40 bg-background/60 text-amber-950 hover:bg-amber-500/15 hover:text-amber-950 dark:border-amber-400/40 dark:text-amber-50 dark:hover:bg-amber-500/20 dark:hover:text-amber-50"
            onClick={props.onConfirm}
          >
            Use new prefix
          </Button>
        </div>
      </div>
    </div>
  );
}

function stagedEntryHasNewBranch(
  stagedEntry: WorktreeFolderIntent | null,
): boolean {
  return (
    stagedEntry !== null &&
    stagedEntry.kind === "worktree" &&
    stagedEntry.branch.type === "new"
  );
}

type ResolvedScriptsTarget =
  // Forking a brand-new branch into a worktree.
  | { readonly kind: "new-branch-worktree"; readonly branchName: string }
  // Checking out an existing branch into a (new) worktree.
  | { readonly kind: "checkout-branch-worktree"; readonly branchName: string }
  // An existing worktree on disk (adopted, or the live in-epic binding).
  | { readonly kind: "existing-worktree"; readonly worktreePath: string }
  | { readonly kind: "local" };

/** Resolve which worktree (if any) a scripts edit targets, by the same precedence the picker uses: a staged
 * choice wins over the live binding. */
function resolveScriptsTarget(input: {
  readonly stagedEntry: WorktreeFolderIntent | null;
  readonly bindingEntry: WorktreeBindingEntry | null;
}): ResolvedScriptsTarget {
  const { stagedEntry, bindingEntry } = input;
  if (stagedEntry !== null) {
    if (stagedEntry.kind === "worktree") {
      return stagedEntry.branch.type === "new"
        ? { kind: "new-branch-worktree", branchName: stagedEntry.branch.name }
        : {
            kind: "checkout-branch-worktree",
            branchName: stagedEntry.branch.name,
          };
    }
    if (stagedEntry.kind === "import") {
      return {
        kind: "existing-worktree",
        worktreePath: stagedEntry.worktreePath,
      };
    }
    return { kind: "local" };
  }
  if (
    bindingEntry !== null &&
    bindingEntry.mode === "worktree" &&
    bindingEntry.worktreePath !== null
  ) {
    return {
      kind: "existing-worktree",
      worktreePath: bindingEntry.worktreePath,
    };
  }
  return { kind: "local" };
}

/** The git ref a new/checkout worktree forks from - the source whose committed `.traycer/environment.json` the
 * worktree inherits. */
function sourceRefForStagedEntry(
  stagedEntry: WorktreeFolderIntent | null,
): string | null {
  if (stagedEntry === null || stagedEntry.kind !== "worktree") return null;
  return stagedEntry.branch.type === "new"
    ? stagedEntry.branch.source
    : stagedEntry.branch.name;
}

/** React `key` for the seeded form, bumped when the async seed source for this target resolves so the form
 * re-seeds on a cold cache. */
function resolveSeedKey(input: {
  readonly resolved: ResolvedScriptsTarget;
  readonly workspacePath: string;
  readonly sourceRef: string | null;
  readonly worktreeScriptsResolved: boolean;
  readonly branchScriptsResolved: boolean;
}): string {
  const {
    resolved,
    workspacePath,
    sourceRef,
    worktreeScriptsResolved,
    branchScriptsResolved,
  } = input;
  if (resolved.kind === "existing-worktree") {
    return `existing:${resolved.worktreePath}:${worktreeScriptsResolved ? "1" : "0"}`;
  }
  if (
    resolved.kind === "new-branch-worktree" ||
    resolved.kind === "checkout-branch-worktree"
  ) {
    return `${resolved.kind}:${workspacePath}:${sourceRef ?? ""}:${branchScriptsResolved ? "1" : "0"}`;
  }
  return `${resolved.kind}:${workspacePath}`;
}

function resolveScriptSeed(input: {
  readonly resolved: ResolvedScriptsTarget;
  readonly summary: WorktreeWorkspaceSummaryV14;
  readonly stagedEntry: WorktreeFolderIntent | null;
  readonly worktreeOwnScripts: RepoScriptsSeed | null;
  readonly branchScripts: RepoScriptsSeed | null;
  readonly branchReadFailed: boolean;
}): RepoScriptsSeed | null {
  const {
    resolved,
    summary,
    stagedEntry,
    worktreeOwnScripts,
    branchScripts,
    branchReadFailed,
  } = input;
  if (resolved.kind === "existing-worktree") {
    // The worktree's own env, falling back to the repo's scripts if it isn't in
    // the host worktrees list (e.g. an externally-created worktree).
    return worktreeOwnScripts ?? summary.scripts;
  }
  if (
    resolved.kind === "new-branch-worktree" ||
    resolved.kind === "checkout-branch-worktree"
  ) {
    const staged =
      stagedEntry !== null && stagedEntry.kind === "worktree"
        ? stagedEntry.scripts
        : null;
    if (staged !== null) return staged;
    // A failed source-branch read must NOT seed the primary checkout (the stale
    // value this flow avoids); start blank and surface the error to the user.
    if (branchReadFailed) return null;
    // Otherwise preview the source branch's committed scripts - the file the new worktree actually inherits -
    // falling back to the primary checkout only when the ref carries none.
    return branchScripts ?? summary.scripts;
  }
  return summary.scripts;
}

function describeTarget(input: {
  readonly resolved: ResolvedScriptsTarget;
  readonly workspacePath: string;
}): {
  readonly pathLabel: string | null;
  readonly pathValue: string | null;
  readonly scriptsNote: string;
} {
  if (input.resolved.kind === "existing-worktree") {
    return {
      pathLabel: "Worktree path",
      pathValue: input.resolved.worktreePath,
      scriptsNote:
        "Edit the setup and teardown scripts for this worktree. Saved to its own environment file, never the source checkout.",
    };
  }
  if (input.resolved.kind === "new-branch-worktree") {
    // No path block here (core-flows/worktree-environment-layered-settings: "remove the disconnected top-level
    // 'New worktree branch' presentation").
    return {
      pathLabel: null,
      pathValue: null,
      scriptsNote:
        "These scripts ride the worktree request - the host writes them into the new worktree when the agent starts.",
    };
  }
  if (input.resolved.kind === "checkout-branch-worktree") {
    return {
      pathLabel: "Existing branch",
      pathValue: input.resolved.branchName,
      scriptsNote:
        "This branch is checked out into a new worktree. The scripts ride the request - written into the new worktree at create.",
    };
  }
  return {
    pathLabel: "Folder",
    pathValue: input.workspacePath,
    scriptsNote:
      "This folder runs in your checkout. Saved to the repo's own environment file - commit it to share.",
  };
}
