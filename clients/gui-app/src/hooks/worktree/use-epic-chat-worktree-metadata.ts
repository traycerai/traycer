import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  WorktreeBindingSelectorRowV12,
  WorktreeHostEntryV12,
} from "@traycer/protocol/host/worktree-schemas";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useWorktreeListBindingsForEpicForClient } from "@/hooks/worktree/use-worktree-list-bindings-for-epic-query";
import type { HostRpcRegistry } from "@/lib/host";
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";
import {
  worktreePrReferences,
  type WorktreePrReference,
} from "@/components/worktree/worktree-pr-metadata-model";

const EMPTY_ROWS: readonly WorktreeBindingSelectorRowV12[] = [];
export const EMPTY_CHAT_ROW_WORKTREE_METADATA: ReadonlyMap<
  string,
  ChatRowWorktreeMetadata
> = new Map<string, ChatRowWorktreeMetadata>();

/**
 * Everything the sidebar's row 2 renders for ONE owner (a chat or a
 * terminal-agent), already reduced to display shape so the row component holds
 * no data logic.
 */
export interface ChatRowWorktreeMetadata {
  /**
   * The owner's primary workspace: its branch, or the folder name when the
   * binding recorded no branch (a non-git / local checkout). An owner with no
   * binding directory at all is absent from the map entirely rather than
   * carrying an empty label, so its row collapses back to a single line.
   */
  readonly label: string;
  /** Extra directories beyond the primary, plus owned submodules. */
  readonly extraCount: number;
  readonly prReferences: readonly WorktreePrReference[];
}

/**
 * Batches row-2 workspace/PR metadata for every chat + terminal-agent row of
 * ONE host into two RPCs, regardless of row count. Mount it once per host (see
 * `EpicChatWorktreeMetadataProvider`) and read per row from context - the `gh`
 * PR probes behind phase 2 are far too expensive to issue per row.
 *
 * Phase 1 - `worktree.listBindingsForEpic`: the cheap owner index. Its rows are
 * deduped by running directory and carry `sources[]` (`ownerId` + `ownerKind` +
 * that owner's `isPrimary`/`mode`), which is what makes the owner→directory
 * mapping native rather than re-derived. The epic filter is HOST-side here, so
 * no other epic's binding ever crosses the wire.
 *
 * Phase 2 - `worktree.listAllForHost` (`includeActivity: true`) bounded to the
 * worktree paths phase 1 proved this epic owns: branch/PR/submodule facts for
 * exactly those rows and nothing else.
 *
 * **Why phase 1 is not the plan's `worktree.listAllForHost` index.** That
 * listing is a disk walk of the host's `~/.traycer/worktrees/` tree, so an
 * owner running `mode: "local"` (in the user's own checkout, no Traycer
 * worktree) has NO entry in it - the folder-name half of row 2 was unreachable
 * through it. `worktree.listBindingsForEpic` covers local and worktree owners
 * alike, at the same two-calls-per-host cost.
 *
 * **Why the labels can't flash.** `branch` and `mode` on a selector row come
 * straight off the persisted binding entry, never from a git probe, so row 2
 * never reads the cold host's `{ isGitRepo: false }` placeholder (the signal
 * `isGitResolvePending` exists to mark). There is no cold-start window where a
 * branch renders as a folder name.
 */
export function useEpicChatWorktreeMetadataForHost(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly enabled: boolean;
}): ReadonlyMap<string, ChatRowWorktreeMetadata> {
  const bindingsQuery = useWorktreeListBindingsForEpicForClient({
    client: args.client,
    epicId: args.epicId,
    enabled: args.enabled,
  });
  const rows = bindingsQuery.data?.rows ?? EMPTY_ROWS;
  const ownedWorktreePaths = useMemo(() => {
    const paths = new Set(
      rows.flatMap((row) =>
        row.worktreePath === null ? [] : [row.worktreePath],
      ),
    );
    // Sorted so the request - and therefore the query key - is stable across
    // binding-row reordering; the batch is one cache entry per host and must
    // not re-key itself into a fresh fetch on incidental churn.
    return [...paths].sort();
  }, [rows]);
  const enrichedQuery = useHostQuery<
    HostRpcRegistry,
    "worktree.listAllForHost"
  >({
    cacheKeyIdentity: undefined,
    client: args.client,
    method: "worktree.listAllForHost",
    params: {
      includeActivity: true,
      activityPaths: ownedWorktreePaths,
      cursor: null,
      limit: null,
      // A background read: the host serves its resolved row cache and only
      // re-derives paths whose facts were never resolved or whose `gh` probe
      // has not landed yet. Only the Settings toolbar's explicit Refresh
      // forces a disk recompute.
      forceRefresh: false,
    },
    options: { enabled: args.enabled && ownedWorktreePaths.length > 0 },
  });

  const enrichedWorktrees = enrichedQuery.data?.worktrees;
  return useMemo(
    () => buildChatRowWorktreeMetadata(rows, enrichedWorktrees ?? []),
    [rows, enrichedWorktrees],
  );
}

/**
 * Folds the two phases into one `ownerId` → row-2 view. Pure, so the mapping
 * is exercised directly rather than through a rendered tree.
 *
 * Owners are keyed by `ownerId` alone: it is a uuid, unique across both owner
 * kinds AND across hosts, so per-host maps merge without collision.
 */
export function buildChatRowWorktreeMetadata(
  rows: readonly WorktreeBindingSelectorRowV12[],
  enrichedWorktrees: readonly WorktreeHostEntryV12[],
): ReadonlyMap<string, ChatRowWorktreeMetadata> {
  if (rows.length === 0) return EMPTY_CHAT_ROW_WORKTREE_METADATA;
  const enrichedByPath = new Map(
    enrichedWorktrees.map((worktree) => [worktree.worktreePath, worktree]),
  );
  // One entry per (owner, directory). A directory shared by two owners appears
  // once per owner, since the wire row is deduped by directory and fans back
  // out through `sources`.
  const entriesByOwnerId = new Map<string, OwnerDirectoryEntry[]>();
  for (const row of rows) {
    for (const source of row.sources) {
      const entry: OwnerDirectoryEntry = {
        workspacePath: source.workspacePath,
        worktreePath: row.worktreePath,
        branch: row.branch,
        isPrimary: source.isPrimary,
      };
      const current = entriesByOwnerId.get(source.ownerId);
      if (current === undefined) entriesByOwnerId.set(source.ownerId, [entry]);
      else current.push(entry);
    }
  }

  const metadataByOwnerId = new Map<string, ChatRowWorktreeMetadata>();
  for (const [ownerId, entries] of entriesByOwnerId) {
    // `isPrimary` is per binding ENTRY (the owner's own flag on `sources`),
    // not the epic-wide single-primary the row level carries, so this picks
    // the directory THIS owner leads with. Insertion order is the fallback.
    const primary = entries.find((entry) => entry.isPrimary) ?? entries[0];
    // Deduped by path: two binding entries can name the same running
    // directory (an imported worktree bound under a second workspace path),
    // and a repeated entry would emit two PR references with the same key.
    const ownerWorktrees = [
      ...new Set(
        entries.flatMap((entry) => {
          const enriched =
            entry.worktreePath === null
              ? undefined
              : enrichedByPath.get(entry.worktreePath);
          return enriched === undefined ? [] : [enriched];
        }),
      ),
    ];
    const submoduleCount = ownerWorktrees.reduce(
      (total, worktree) => total + worktree.submodules.length,
      0,
    );
    // Counted over DISTINCT running directories, not raw binding entries. The
    // same running directory can be reached through two binding entries (an
    // imported worktree bound under a second workspace path - the case the
    // dedupe above exists for), and the badge reads "+N more workspaces", so
    // counting that twice claims a place the agent does not actually work in.
    // Local-mode entries have no `worktreePath`, and their workspace path IS
    // the running directory, which is why the key falls back to it.
    const distinctDirectories = new Set(
      entries.map((entry) => entry.worktreePath ?? entry.workspacePath),
    );
    metadataByOwnerId.set(ownerId, {
      label: primary.branch ?? workspaceFolderName(primary.workspacePath),
      extraCount: distinctDirectories.size - 1 + submoduleCount,
      prReferences: worktreePrReferences(ownerWorktrees),
    });
  }
  return metadataByOwnerId;
}

interface OwnerDirectoryEntry {
  readonly workspacePath: string;
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly isPrimary: boolean;
}
