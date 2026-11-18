import type {
  WorktreeCreateRequest,
  WorktreeFolderIntent,
} from "@traycer/protocol/host/worktree-schemas";

/**
 * Promotes shared/persisted folder intents into the current create RPC shape.
 * Intents written before collision policy existed are intentionally exact-name
 * (`fail`): only a fresh generated proposal carries the retry identity needed
 * for random collision retries.
 */
export function worktreeCreateEntries(
  entries: ReadonlyArray<WorktreeFolderIntent>,
): WorktreeCreateRequest["entries"] {
  return entries.map((entry): WorktreeCreateRequest["entries"][number] => {
    if (entry.kind !== "worktree") return entry;
    const branch = entry.branch;
    if (branch.type === "existing") return { ...entry, branch };
    if (branch.collision === "random") {
      return {
        ...entry,
        branch: {
          type: "new",
          name: branch.name,
          source: branch.source,
          carryUncommittedChanges: branch.carryUncommittedChanges,
          collision: "random",
          retryIdentity: branch.retryIdentity,
        },
      };
    }
    return {
      ...entry,
      branch: {
        type: "new",
        name: branch.name,
        source: branch.source,
        carryUncommittedChanges: branch.carryUncommittedChanges,
        collision: "fail",
      },
    };
  });
}
