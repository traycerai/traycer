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
}

export function OfficeHoverSupplement(props: OfficeHoverSupplementProps) {
  const { modelTier, status } = props;
  return (
    <p
      className="text-ui-xs text-muted-foreground"
      data-testid="comm-graph-office-hover-supplement"
    >
      {STATUS_LABELS[status]} · {modelTier} model
    </p>
  );
}
