import type { ReactNode } from "react";
import type { PrDetailTileRef } from "@/stores/epics/canvas/types";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { PrDetailBody } from "@/components/epic-canvas/pr/pr-detail-body";
import { PrDetailDeadTileBanner } from "./dead-tile-banner";

interface PrDetailTileProps {
  readonly node: PrDetailTileRef;
  readonly epicId: string;
  readonly viewTabId: string;
  readonly isActive: boolean;
}

/**
 * Gates on the tile's BOUND host reachability only. Git-diff tiles are
 * tab-pinned the same way: they no longer go dead when the active host
 * changes. The detail subscription hook resolves and subscribes through
 * the bound host's own client (`use-pr-detail-subscription.ts`).
 */
export function PrDetailTile(props: PrDetailTileProps): ReactNode {
  const tabHostId = useTabHostId();
  const reachability = useHostReachability(tabHostId);

  if (reachability.status === "unreachable") {
    return (
      <PrDetailDeadTileBanner
        hostLabel={reachability.hostLabel}
        testId={`pr-detail-tile-${props.node.id}`}
      />
    );
  }

  return (
    <PrDetailBody
      epicId={props.epicId}
      viewTabId={props.viewTabId}
      githubHost={props.node.githubHost}
      owner={props.node.owner}
      repo={props.node.repo}
      prNumber={props.node.prNumber}
      isActive={props.isActive}
    />
  );
}
