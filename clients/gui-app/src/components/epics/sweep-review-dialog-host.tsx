import type { ReactNode } from "react";
import { SweepWorktreesFlow } from "@/components/epics/sweep-worktrees-flow";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import {
  useSweepSessionStore,
  type SweepReviewTarget,
} from "@/stores/epics/sweep-session-store";

/** A toast can outlive its task pane, so its review is hosted by the shell. */
export function SweepReviewDialogHost(): ReactNode {
  const target = useSweepSessionStore((state) => state.reviewTarget);
  return target === null ? null : (
    <SweepReviewDialog key={target.sessionKey} target={target} />
  );
}

function SweepReviewDialog(props: {
  readonly target: SweepReviewTarget;
}): ReactNode {
  const { target } = props;
  const hostClient = useHostClientForHostId(target.hostId);
  return (
    <SweepWorktreesFlow
      epicIds={target.epicIds}
      surfaceHostClient={hostClient}
      surfaceHostId={target.hostId}
      taskTitle={target.taskTitle}
      onOpenChange={(open) => {
        if (!open) useSweepSessionStore.getState().closeReview();
      }}
    />
  );
}
