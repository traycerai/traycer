/**
 * What the FLOOR knows about an agent that the shared card does not: the
 * posture it is drawn in, and the size class its desk is drawn at.
 *
 * Appended under `AgentHoverTooltip`'s own content rather than replacing any
 * of it. The harness and model are deliberately absent here even though the
 * office carries them: the shared card resolves those from the host, which is
 * the authority, and repeating a second-hand copy beside it is exactly how the
 * two would come to disagree.
 */
import type {
  OfficeAgentStatus,
  OfficeModelTier,
} from "@/lib/comm-graph/office/office-types";

/** One word per status, in the vocabulary the rest of the app already uses. */
const STATUS_LABELS: Readonly<Record<OfficeAgentStatus, string>> = {
  failure: "Crashed",
  attention: "Needs attention",
  awaiting: "Waiting for reply",
  working: "Working",
  background: "In background",
  idle: "Idle",
  archived: "Archived",
};

export interface OfficeHoverSupplementProps {
  readonly status: OfficeAgentStatus;
  readonly modelTier: OfficeModelTier;
  /**
   * WHERE this agent is, in the words its own floor plan uses - its room, the
   * quiet stack, or wherever it has walked to. `null` before the first layout,
   * and for an agent the seat book does not know.
   *
   * Asked of the SCENE, never of the plan: a plan-time label stops being true
   * the moment somebody gets up, and getting up is most of what the office
   * does.
   */
  readonly whereabouts: string | null;
}

export function OfficeHoverSupplement(props: OfficeHoverSupplementProps) {
  const { modelTier, status, whereabouts } = props;
  return (
    <div data-testid="comm-graph-office-hover-supplement">
      <p className="text-ui-xs text-muted-foreground">
        {STATUS_LABELS[status]} · {modelTier} model
      </p>
      {whereabouts === null ? null : (
        <p
          className="text-ui-xs text-muted-foreground"
          data-testid="comm-graph-office-hover-where"
        >
          {whereabouts}
        </p>
      )}
    </div>
  );
}
