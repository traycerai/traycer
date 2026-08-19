/**
 * Opener "Artifacts" sub-page: existing spec / ticket / story / review
 * artifacts only (no "new" - artifacts are agent-created). Each opens a fresh
 * instance into the target group. Artifact projections carry no hostId, so
 * they bind to the default host (matching the sidebar's fallback).
 */
import { useMemo } from "react";
import { v4 as uuidv4 } from "uuid";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { openerExistingLeaf } from "@/lib/commands/sources/open/open-leaf";
import {
  useActiveEpicHostId,
  useActiveEpicProjection,
} from "@/lib/commands/sources/open/use-active-epic-projection";
import type { CommandContext, CommandItem } from "@/lib/commands/types";
import { isOpenableEpicNodeKind } from "@/stores/epics/canvas/types";

export function useArtifactsOpenerItems(
  ctx: CommandContext,
): ReadonlyArray<CommandItem> {
  // The tile binds for life to the host that serves this epic's projection -
  // never the app-wide host, which may already point elsewhere mid re-point.
  const defaultHostId =
    useActiveEpicHostId(ctx.activeEpicId) ?? UNKNOWN_HOST_PLACEHOLDER;
  const projection = useActiveEpicProjection(ctx.activeEpicId);

  return useMemo<ReadonlyArray<CommandItem>>(() => {
    if (projection === null) return [];
    return projection.artifacts.allIds.flatMap((id) => {
      const artifact = projection.artifacts.byId[id];
      if (!isOpenableEpicNodeKind(artifact.kind)) return [];
      return [
        openerExistingLeaf(
          "artifacts",
          ctx,
          {
            id: artifact.id,
            instanceId: uuidv4(),
            type: artifact.kind,
            name:
              artifact.title.length > 0
                ? artifact.title
                : `Untitled ${artifact.kind}`,
            hostId: defaultHostId,
          },
          // Artifacts carry no per-item hostId (verified host-agnostic, audit
          // G3) - never badged.
          null,
        ),
      ];
    });
  }, [ctx, projection, defaultHostId]);
}
