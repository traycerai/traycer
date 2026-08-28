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

/**
 * The surface-level context a scripts edit needs to resolve its save target.
 * Pre-create surfaces (landing / launcher / fork) pass `epicId: ""`,
 * `ownerId: null`, `binding: null` - the edit can only ride the staged intent or
 * write the repo's own file (Local). In-epic surfaces pass the real owner + live
 * binding so an edit can target a bound worktree's own
 * `.traycer/environment.json`.
 */
export interface WorktreeScriptsContext {
  readonly epicId: string;
  readonly ownerId: string | null;
  readonly ownerKind: WorktreeBindingOwnerKind | null;
  readonly binding: WorktreeBinding | null;
  readonly stagingKey: WorktreeStagingKey;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  /**
   * Composes the branch name `workspacePath` would get for `prefixState` at
   * `suffix` - the SAME production composition path (multi-repo repository
   * slugging + truncation included) real branch staging uses, given an
   * explicit caller-supplied suffix instead of a fresh random one. Branch
   * naming's live preview and its Apply/Remove candidate capture both call
   * this with the SAME stable suffix, so whatever candidate is displayed is
   * exactly what "Use new prefix" later stages - never a second, independent
   * random pick. Deliberately synchronous and independent of the
   * summary-invalidation refetch a save also triggers - that refetch lands
   * on its own time and this must not wait on it. `null` when the workspace
   * isn't known to the picker.
   */
  readonly regenerateBranchNameForWorkspace: (
    workspacePath: string,
    freshRepoBranchPrefix: RepoBranchPrefixState,
    suffix: string,
  ) => string | null;
}

/** The folder a scripts edit targets, captured when the footer is clicked. */
export interface WorktreeScriptsTarget {
  readonly workspacePath: string;
  readonly summary: WorktreeWorkspaceSummaryV14;
}

/**
 * Per-folder setup/teardown editor, opened from the workspace picker's
 * Environment footer. The modal stacks on the still-open picker (the picker's
 * `preserveWhenNestedOverlay` keeps it from dismissing), so closing the modal
 * returns to the picker. Reuses the Settings ▸ Worktrees modal design
 * (`ScriptsReviewDialog`). Where the edit lands follows what the folder is set
 * to run in:
 *  - a staged NEW worktree → rides the worktree intent (host writes it at create);
 *  - an EXISTING worktree (adopted, or a live in-epic binding) → its own env file;
 *  - Local → the source repo's env file (committable).
 */
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

/**
 * Holds the last non-null staged entry for `workspacePath` across a render
 * where the live lookup goes transiently null - e.g. a staging-key
 * transition (the landing draft's key migrating off its pre-draft null id)
 * landing a render before the entry is carried over to the new key. Falling
 * through to `resolveScriptsTarget`'s "local" default for that one render
 * would flip `resolved.kind`, change `seedKey`, and remount the scripts
 * editor below - wiping an in-progress branch-prefix edit. A genuine switch
 * to Local always stages an explicit `kind: "local"` entry (never an
 * unstage), so holding here never masks a real user choice.
 *
 * Render-phase state adjustment (React docs pattern, also used by
 * `LandingDraftSurface`'s id-rotation): writing here re-renders synchronously
 * before commit, so the returned value is already correct on the very render
 * that would otherwise have shown the gap.
 */
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

  // An existing worktree prefills from ITS OWN env file - the same host-wide
  // source Settings reads (shared query key, so this is a warm cache hit once
  // the picker has fetched it, not a new round-trip).
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

  // A new/checkout worktree forks from a SOURCE ref, so it inherits that ref's
  // committed `.traycer/environment.json` - NOT the primary checkout's on-disk
  // file (`summary.scripts`). Preview the source branch's scripts by reading
  // them at the ref. `null` for non-worktree targets disables the read.
  const sourceRef = sourceRefForStagedEntry(effectiveStagedEntry);
  // Preview the SOURCE branch's committed scripts. There is no dedicated
  // `worktree.readScriptsAtRef` method - a new method name would break the wire
  // method-set against an older host - so the read rides `listByWorkspacePaths`
  // v1.1 as a pure point-read: empty `workspacePaths` + a single `scriptRefs`
  // entry, so the host runs exactly one `git show` and returns a tiny payload (no
  // branch list, regardless of repo branch count). An older host bridges the
  // request down and returns `scriptsAtRefs: []`, so the preview falls back to the
  // primary checkout's scripts.
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
      // A pure `git show` point-read at a ref; the TTL-cached workspace
      // summaries this flag governs are not even consulted, so a forced
      // recompute would buy nothing.
      forceRefresh: false,
    },
    options: { enabled: sourceRef !== null },
  });
  const branchScripts =
    branchScriptsQuery.data?.scriptsAtRefs[0]?.scripts ?? null;
  // The source-branch read is "settled" once it succeeds or errors; until then
  // (and only when no staged edit already supplies the seed) the dialog shows a
  // spinner instead of flashing the primary checkout's scripts.
  const branchReadSettled =
    sourceRef === null ||
    branchScriptsQuery.isSuccess ||
    branchScriptsQuery.isError;
  // A FAILED source-branch read is distinct from "no committed scripts": it must
  // NOT silently seed the primary checkout (the stale value this whole flow
  // avoids). Surface it and start the editor blank instead.
  const branchReadFailed = sourceRef !== null && branchScriptsQuery.isError;
  const stagedScripts =
    effectiveStagedEntry !== null && effectiveStagedEntry.kind === "worktree"
      ? effectiveStagedEntry.scripts
      : null;
  const seedPending = !branchReadSettled && stagedScripts === null;

  const saveMutation = useWorktreeSetRepoScriptsFor(context.hostClient);

  // Radix's Dialog dismissable layer listens for Escape on `document` in the
  // capture phase - before any bubbling `onKeyDown` inside the content ever
  // runs - so an inline editor cannot reliably turn Escape into "cancel just
  // this edit" from its own keydown handler alone. `RepoBranchPrefixSection`
  // registers its current cancel-editing handler here (via
  // `onEditingCancelAvailable`, `null` whenever it isn't actively editing) so
  // `ScriptsReviewDialog`'s `onEscapeKeyDown` can intercept Escape at the
  // correct boundary: prevent the dialog dismissal and cancel the edit
  // instead, never both. A ref (not state) because it must be read
  // synchronously inside that Radix callback, not through a render.
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
      // `null`, not an always-truthy element wrapping a component that
      // internally renders nothing, so `ScriptsReviewDialog` can tell a real
      // Branch naming section apart from "none for this non-Git folder" -
      // it uses this to decide whether to show the "Setup & teardown
      // scripts" eyebrow that only makes sense when both sections exist.
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

/**
 * Dialog-wide description naming both concerns the "Worktree environment"
 * dialog hierarchy covers (core-flows/worktree-environment-layered-settings)
 * - Branch naming has no section of its own to describe itself in for
 * non-Git folders, since it doesn't render at all there.
 */
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

/**
 * The Environment dialog's "Repository defaults" section plus the
 * "single-picker opt-in draft replacement" offer that can follow a save.
 * Extracted from `WorktreeScriptsDialogBody` to keep this branching (whether
 * to render at all, whether to offer regeneration) out of that already-large
 * function's complexity count - `summary.isGitRepo`, the just-saved state,
 * and the offer's visibility are all local to this one concern.
 *
 * Non-Git folders contractually have no repository override (the ticket:
 * "Non-Git folders have no repository override and use the global
 * fallback") - never render an editor that could offer to write one, and
 * never let a stale/vanished-checkout `updated: false` response (handled
 * inside `RepoBranchPrefixSection` itself) reach this far in the first
 * place for a folder this component already knows isn't git.
 */
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
  // The picker's actual current proposal for this workspace (`null` when
  // there isn't one, e.g. an existing/checked-out branch or a non-worktree
  // target) - fed to Branch naming so its "Effective branch" row shows the
  // TRUTH of what's staged instead of an unrelated fabricated preview.
  readonly currentProposedBranchName: string | null;
  readonly onEditingCancelAvailable: (cancel: (() => void) | null) => void;
}) {
  const { workspacePath, summary, context } = props;
  // Captured together at the moment Apply/Remove succeeds: `candidate` is the
  // EXACT string Branch naming displayed as "Effective branch" right then
  // (see `RepoBranchPrefixSection`'s `onSaved`), and `previousProposal` is a
  // SNAPSHOT of what the picker had staged just before that (never re-read
  // live from `props.currentProposedBranchName` while the offer is up - that
  // prop already reflects `candidate` once "Use new prefix" restages it, so a
  // live read would show the offer identifying its own new value as "old").
  // While this is non-null, Branch naming must show `candidate` as its
  // effective result (not the old proposal) so what's visible is exactly
  // what "Use new prefix" stages - the offer separately names the value it
  // would replace. Dismissing ("Keep current") or confirming both clear it,
  // letting the ordinary `currentProposedBranchName` precedence resume.
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
        // `cancel !== null` means Branch naming just entered editing - a
        // stale offer from the PREVIOUS save/remove must not keep showing
        // (and stay actionable) alongside a brand-new draft the user hasn't
        // saved yet; dismiss it here, at the same notification this section
        // already fires for the Escape-boundary wiring below, rather than
        // adding a second "editing began" channel. A subsequent successful
        // save still creates its own fresh offer through the unchanged
        // `onSaved` path - never two actionable candidates at once.
        onEditingCancelAvailable={(cancel) => {
          if (cancel !== null) setRegenerateOffer(null);
          props.onEditingCancelAvailable(cancel);
        }}
        // "Single-picker opt-in draft replacement": only offered when THIS
        // staged intent has a generated (`type: "new"`) branch to replace -
        // an existing checkout branch has nothing to regenerate, and the
        // offer must never touch any other staged folder or an
        // already-created worktree. `onSaved` only fires for an actually
        // persisted write (see `RepoBranchPrefixSection`'s `updated` check).
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

/**
 * "Single-picker opt-in draft replacement" offer: shown after a repository
 * branch-prefix save when this picker has a staged generated (`type: "new"`)
 * branch name to replace. Never fires automatically - the user opts in.
 * Names the OLD staged proposal explicitly (core-flows/worktree-environment-
 * layered-settings' "Saved override" frame: "This picker already proposed
 * X.") - Branch naming itself is showing the NEW candidate as its effective
 * result for the whole time this offer is up, so the offer is the only place
 * the value it would replace stays visible.
 *
 * Amber alert treatment so the decision sits apart from Branch naming's
 * ordinary controls rather than reading as another muted inline row.
 */
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

/**
 * Resolve which worktree (if any) a scripts edit targets, by the same precedence
 * the picker uses: a staged choice wins over the live binding.
 */
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

/**
 * The git ref a new/checkout worktree forks from - the source whose committed
 * `.traycer/environment.json` the worktree inherits. `new` forks from
 * `branch.source`; `existing` checks out `branch.name`. `null` for non-worktree
 * targets (local / import), which have no fork source to read.
 */
function sourceRefForStagedEntry(
  stagedEntry: WorktreeFolderIntent | null,
): string | null {
  if (stagedEntry === null || stagedEntry.kind !== "worktree") return null;
  return stagedEntry.branch.type === "new"
    ? stagedEntry.branch.source
    : stagedEntry.branch.name;
}

/**
 * React `key` for the seeded form, bumped when the async seed source for this
 * target resolves so the form re-seeds on a cold cache. A staged edit still
 * wins in `resolveScriptSeed`, so a remount is a no-op re-seed to the same
 * value.
 */
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
    // Otherwise preview the SOURCE branch's committed scripts - the file the new
    // worktree actually inherits - falling back to the primary checkout only
    // when the ref carries none.
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
    // No path block here (core-flows/worktree-environment-layered-settings:
    // "remove the disconnected top-level 'New worktree branch' presentation")
    // - the branch name it would show is already covered by Branch naming's
    // own effective-branch preview above.
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
