import { useMemo } from "react";
import type {
  WorktreeBinding,
  WorktreeBindingEntry,
  WorktreeBindingOwnerKind,
  WorktreeEntryScripts,
  WorktreeFolderIntent,
  WorktreeWorkspaceSummary,
} from "@traycer/protocol/host/worktree-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useWorktreeSetRepoScriptsFor } from "@/hooks/worktree/use-worktree-set-repo-scripts-mutation";
import { ScriptsReviewDialog } from "@/components/workspaces/scripts-review-dialog";
import { type RepoScriptsSeed } from "@/components/workspaces/repo-scripts-form";
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
}

/** The folder a scripts edit targets, captured when the footer is clicked. */
export interface WorktreeScriptsTarget {
  readonly workspacePath: string;
  readonly summary: WorktreeWorkspaceSummary;
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

function WorktreeScriptsDialogBody(props: {
  readonly workspacePath: string;
  readonly summary: WorktreeWorkspaceSummary;
  readonly context: WorktreeScriptsContext;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { context, summary, workspacePath } = props;
  const stageScripts = useWorktreeIntentStagingStore((s) => s.stageScripts);
  const stagedEntry = useWorktreeIntentStagingStore(
    (s) =>
      s.intentByKey[worktreeStagingKeyString(context.stagingKey)]?.entries.find(
        (entry) => entry.workspacePath === workspacePath,
      ) ?? null,
  );
  const bindingEntry =
    context.binding?.entries.find(
      (entry) => entry.workspacePath === workspacePath,
    ) ?? null;

  const resolved = resolveScriptsTarget({ stagedEntry, bindingEntry });

  // An existing worktree prefills from ITS OWN env file - the same host-wide
  // source Settings reads (shared query key, so this is a warm cache hit once
  // the picker has fetched it, not a new round-trip).
  const hostWorktreesQuery = useHostQuery<
    HostRpcRegistry,
    "worktree.listAllForHost"
  >({
    client: context.hostClient,
    method: "worktree.listAllForHost",
    params: {},
    options: { enabled: resolved.kind === "existing-worktree" },
  });
  const worktreeOwnScripts = useMemo<RepoScriptsSeed | null>(() => {
    if (resolved.kind !== "existing-worktree") return null;
    const match = (hostWorktreesQuery.data?.worktrees ?? []).find(
      (entry) => entry.worktreePath === resolved.worktreePath,
    );
    return match?.scripts ?? null;
  }, [hostWorktreesQuery.data, resolved]);

  const saveMutation = useWorktreeSetRepoScriptsFor(context.hostClient);

  const scriptSeed = resolveScriptSeed({
    resolved,
    summary,
    stagedEntry,
    worktreeOwnScripts,
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

  // Re-seed once an existing worktree's own scripts resolve (cold cache only;
  // the picker usually warms this query before the footer is clicked).
  const seedKey =
    resolved.kind === "existing-worktree"
      ? `existing:${resolved.worktreePath}:${hostWorktreesQuery.isSuccess ? "1" : "0"}`
      : `${resolved.kind}:${workspacePath}`;

  return (
    <ScriptsReviewDialog
      key={seedKey}
      testId="worktree-scripts-dialog"
      title="Manage setup and teardown scripts"
      description={descriptor.description}
      pathLabel={descriptor.pathLabel}
      pathValue={descriptor.pathValue}
      scriptSeed={scriptSeed}
      inUseNote={null}
      onSave={handleSave}
      onOpenChange={props.onOpenChange}
    />
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

function resolveScriptSeed(input: {
  readonly resolved: ResolvedScriptsTarget;
  readonly summary: WorktreeWorkspaceSummary;
  readonly stagedEntry: WorktreeFolderIntent | null;
  readonly worktreeOwnScripts: RepoScriptsSeed | null;
}): RepoScriptsSeed | null {
  const { resolved, summary, stagedEntry, worktreeOwnScripts } = input;
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
    return staged ?? summary.scripts;
  }
  return summary.scripts;
}

function describeTarget(input: {
  readonly resolved: ResolvedScriptsTarget;
  readonly workspacePath: string;
}): {
  readonly pathLabel: string;
  readonly pathValue: string;
  readonly description: string;
} {
  if (input.resolved.kind === "existing-worktree") {
    return {
      pathLabel: "Worktree path",
      pathValue: input.resolved.worktreePath,
      description:
        "Edit the setup and teardown scripts for this worktree. Saved to its own environment file, never the source checkout.",
    };
  }
  if (input.resolved.kind === "new-branch-worktree") {
    return {
      pathLabel: "New worktree branch",
      pathValue: input.resolved.branchName,
      description:
        "These scripts ride the worktree request - the host writes them into the new worktree when the chat starts.",
    };
  }
  if (input.resolved.kind === "checkout-branch-worktree") {
    return {
      pathLabel: "Existing branch",
      pathValue: input.resolved.branchName,
      description:
        "This branch is checked out into a new worktree. The scripts ride the request - written into the new worktree at create.",
    };
  }
  return {
    pathLabel: "Folder",
    pathValue: input.workspacePath,
    description:
      "This folder runs in your checkout. Saved to the repo's own environment file - commit it to share.",
  };
}
