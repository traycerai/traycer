import type { ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";

export const DELETE_IN_FLIGHT_TOOLTIP = "This task is being deleted.";

/**
 * The trailing mark of a row whose task is being deleted: the delete's
 * progress, where the row's own actions sit at rest. Always visible, unlike
 * those actions, because it is state rather than an affordance.
 */
export function HistoryRowDeletingIndicator(props: {
  readonly displayTitle: string;
  readonly className: string | undefined;
}): ReactNode {
  return (
    <span
      role="status"
      aria-label={`Deleting ${props.displayTitle}`}
      data-testid="epics-list-row-deleting"
      className={props.className}
    >
      <AgentSpinningDots
        className={undefined}
        testId={undefined}
        variant={undefined}
      />
    </span>
  );
}
