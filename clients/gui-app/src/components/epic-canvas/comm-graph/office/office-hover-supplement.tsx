/** Appended under `AgentHoverTooltip`'s own content rather than replacing any of it. */
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
