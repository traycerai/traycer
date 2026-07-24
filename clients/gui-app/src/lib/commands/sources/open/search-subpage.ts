/**
 * Opener "Text search" sub-page - STEP 1 of the two-step content-search flow:
 * pick a search target. The list is the explicitly labeled artifact
 * workspace (always present, even with no code workspace attached) plus every
 * attached workspace/worktree root browsable for the active Epic/host.
 *
 * Selecting a target pushes a step-2 sub-page ({@link searchRunSubpageId}); the
 * pane opener recognizes that id and renders `SearchRunView` (query + options +
 * results) rather than the generic fuzzy list. Artifact targets run
 * `epic.searchArtifacts`; code targets run `workspace.searchText`.
 */
import { useMemo } from "react";
import { getBasename } from "@/lib/path/cross-platform-path";
import { useWorktreeListBindingsForEpic } from "@/hooks/worktree/use-worktree-list-bindings-for-epic-query";
import { isBrowsable } from "@/lib/worktree/worktree-row-browsable";
import { openerSubpageLeaf } from "@/lib/commands/sources/open/open-leaf";
import {
  searchRunSubpageId,
  type SearchRunTarget,
} from "@/lib/commands/sources/open/search-target";
import type {
  CommandContext,
  CommandItem,
  CommandSubpage,
} from "@/lib/commands/types";

function makeRunSubpage(
  target: SearchRunTarget,
  title: string,
): CommandSubpage {
  // `useItems` is never consulted: the pane opener special-cases this id and
  // renders `SearchRunView` instead of the generic list. Kept as an empty
  // passthrough so the shared `CommandSubpage` shape needs no new field.
  return { id: searchRunSubpageId(target), title, useItems: () => [] };
}

export function useSearchOpenerItems(
  ctx: CommandContext,
): ReadonlyArray<CommandItem> {
  const bindingsQuery = useWorktreeListBindingsForEpic({
    epicId: ctx.activeEpicId ?? "",
    enabled: ctx.activeEpicId !== null,
  });
  const workspaceRoots = useMemo(
    () => bindingsQuery.data?.rows.filter(isBrowsable) ?? [],
    [bindingsQuery.data?.rows],
  );

  return useMemo<ReadonlyArray<CommandItem>>(() => {
    const artifactLeaf = openerSubpageLeaf({
      id: "open:search:target:artifact",
      label: "Artifacts",
      keywords: ["artifact", "artifacts", "spec", "ticket", "story", "review"],
      subpage: makeRunSubpage({ kind: "artifact" }, "Artifacts"),
    });
    const codeLeaves = workspaceRoots.map((row) =>
      openerSubpageLeaf({
        id: `open:search:target:code:${row.hostId}:${row.runningDir}`,
        label: getBasename(row.runningDir),
        keywords: [row.runningDir],
        subpage: makeRunSubpage(
          { kind: "code", hostId: row.hostId, root: row.runningDir },
          getBasename(row.runningDir),
        ),
      }),
    );
    return [artifactLeaf, ...codeLeaves];
  }, [workspaceRoots]);
}
