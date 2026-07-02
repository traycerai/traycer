import { Check, X } from "lucide-react";
import { useState } from "react";
import type { ApprovalDecision } from "@traycer/protocol/persistence/epic/schemas";
import type { ToolInputDetail } from "@traycer/protocol/host/agent/gui/tool-input-detail";
import { cn } from "@/lib/utils";
import { SegmentCard } from "./segment-card";
import { SegmentRow } from "./segment-row";
import { ToolInputPanel } from "./tool-input-panel";

interface ResolvedApprovalSegmentProps {
  toolName: string | null;
  description: string | null;
  inputSummary: string | null;
  // Precomputed expand body for the pending tool's input (raw input not stored).
  inputDetail: ToolInputDetail | null;
  decision: ApprovalDecision;
  variant: "card" | "row";
  headerFindUnitId: string | null;
}

/**
 * Inline-history view of an approval that has already been resolved. Pending
 * approvals are routed to `ComposerSlotApprovalQueue`; the inline path is
 * resolved-only by construction (see `isSuppressedForComposerSlot` and
 * `isWorkStep`), so this component does not accept Approve/Deny callbacks.
 */
export function ResolvedApprovalSegment(props: ResolvedApprovalSegmentProps) {
  const {
    toolName,
    description,
    inputSummary,
    inputDetail,
    decision,
    variant,
  } = props;
  const [open, setOpen] = useState<boolean>(false);
  const label = toolName ?? description ?? "approval";
  const header = (
    <ResolvedApprovalHeader
      label={label}
      inputSummary={inputSummary}
      decision={decision}
    />
  );
  const body = (
    <ResolvedApprovalBody
      description={description}
      inputDetail={inputDetail}
      decision={decision}
    />
  );
  const tone = decision.approved ? "default" : "destructive";

  if (variant === "row") {
    return (
      <SegmentRow
        open={open}
        onOpenChange={setOpen}
        header={header}
        body={body}
        tone={tone}
        stickyHeader
        expandable
        headerFindUnitId={props.headerFindUnitId}
        bodyFindUnitId={null}
        className={undefined}
        footer={null}
      />
    );
  }
  return (
    <SegmentCard
      open={open}
      onOpenChange={setOpen}
      header={header}
      headerAction={null}
      collapsedPreview={null}
      body={body}
      tone={tone}
      headerPosition="normal"
      bodyOverflow="hidden"
      expandable
      headerFindUnitId={props.headerFindUnitId}
      bodyFindUnitId={null}
      className={undefined}
    />
  );
}

function ResolvedApprovalHeader(props: {
  label: string;
  inputSummary: string | null;
  decision: ApprovalDecision;
}) {
  const { label, inputSummary, decision } = props;
  const verdictLabel = decision.approved ? "Approved" : "Denied";
  const VerdictIcon = decision.approved ? Check : X;
  return (
    <>
      <VerdictIcon
        className={cn(
          "size-3.5 shrink-0",
          decision.approved ? "text-emerald-500" : "text-destructive",
        )}
        aria-hidden
      />
      <span
        className={cn(
          "shrink-0 text-ui-sm font-medium",
          decision.approved ? "text-foreground/85" : "text-destructive",
        )}
      >
        {verdictLabel}
      </span>
      <span aria-hidden className="shrink-0 text-muted-foreground/40">
        ·
      </span>
      <span className="shrink-0 font-mono text-code-sm text-muted-foreground">
        {label}
      </span>
      {inputSummary !== null ? (
        <>
          <span aria-hidden className="shrink-0 text-muted-foreground/40">
            ·
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-code-sm text-muted-foreground">
            {inputSummary}
          </span>
        </>
      ) : (
        <span aria-hidden className="flex-1" />
      )}
      {!decision.approved && decision.reason !== null ? (
        <span
          className="@max-[28rem]:hidden shrink-0 truncate text-ui-xs text-destructive/80"
          title={decision.reason}
        >
          {decision.reason}
        </span>
      ) : null}
    </>
  );
}

function ResolvedApprovalBody(props: {
  description: string | null;
  inputDetail: ToolInputDetail | null;
  decision: ApprovalDecision;
}) {
  const { description, inputDetail, decision } = props;
  return (
    <div className="flex flex-col gap-2">
      {description !== null ? (
        <div className="flex flex-col gap-1">
          <span className="select-none font-medium uppercase text-overline text-muted-foreground/80">
            Request
          </span>
          <p className="m-0 whitespace-pre-wrap text-foreground/85">
            {description}
          </p>
        </div>
      ) : null}
      {inputDetail !== null ? <ToolInputPanel detail={inputDetail} /> : null}
      {decision.reason !== null ? (
        <div className="flex flex-col gap-1">
          <span className="select-none font-medium uppercase text-overline text-muted-foreground/80">
            Reason
          </span>
          <p
            className={cn(
              "m-0 whitespace-pre-wrap",
              decision.approved ? "text-foreground/85" : "text-destructive/90",
            )}
          >
            {decision.reason}
          </p>
        </div>
      ) : null}
    </div>
  );
}
