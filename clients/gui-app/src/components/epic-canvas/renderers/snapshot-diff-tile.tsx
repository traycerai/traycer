import type { ReactNode } from "react";
import type { SnapshotDiffTileRef } from "@/stores/epics/canvas/types";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { GitDiffDeadTileBanner } from "./dead-tile-banner";
import { SnapshotDiffTileBody } from "./snapshot-diff-tile-body";

interface SnapshotDiffTileProps {
  readonly node: SnapshotDiffTileRef;
  readonly viewTabId: string;
}

export function SnapshotDiffTile(props: SnapshotDiffTileProps): ReactNode {
  const tabHostId = useTabHostId();
  const activeHostId = useReactiveActiveHostId();
  const reachability = useHostReachability(tabHostId);

  if (reachability.status === "unreachable") {
    return (
      <GitDiffDeadTileBanner
        hostLabel={reachability.hostLabel}
        reason="offline"
        testId={`snapshot-diff-tile-${props.node.id}`}
      />
    );
  }
  if (tabHostId !== activeHostId) {
    return (
      <GitDiffDeadTileBanner
        hostLabel={reachability.hostLabel}
        reason="inactive"
        testId={`snapshot-diff-tile-${props.node.id}`}
      />
    );
  }

  return <SnapshotDiffTileBody node={props.node} viewTabId={props.viewTabId} />;
}
