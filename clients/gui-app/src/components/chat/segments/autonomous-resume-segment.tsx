import { CheckCheck, RotateCw, XCircle } from "lucide-react";
import { Fragment, useState } from "react";
import type { AutonomousResumeTrigger } from "@traycer/protocol/persistence/epic/content-blocks";
import {
  useScrollToChatBlock,
  type ChatScrollCardKind,
  type ScrollToChatBlock,
} from "@/components/chat/chat-scroll-to-block";
import { cn, formatSingleLine } from "@/lib/utils";
import { AgentReferenceMarkdown } from "./agent-reference-markdown";
import { SegmentCard } from "./segment-card";
import { SegmentPanel } from "./segment-panel";

/**
 * Lean marker at the head of an AUTONOMOUS turn (one with no user message),
 * naming which backgrounded command/Monitor/subagent completion woke the agent
 * - so the resume reads as a consequence, not an abrupt reply.
 *
 * - Command / monitor triggers: rendered inline in the compact "Resumed ·" row
 * - Subagent triggers with a result summary: rendered as expandable cards
 *   showing the full markdown result (similar to A2A "Received message" cards)
 */
interface AutonomousResumeSegmentProps {
  triggers: ReadonlyArray<AutonomousResumeTrigger>;
}

function kindNoun(kind: AutonomousResumeTrigger["kind"]): string {
  switch (kind) {
    case "command":
      return "command";
    case "monitor":
      return "monitor";
    case "subagent":
      return "subagent";
  }
}

function statusVerb(status: AutonomousResumeTrigger["status"]): string {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
  }
}

function subagentStatusTitle(
  status: AutonomousResumeTrigger["status"],
): string {
  switch (status) {
    case "completed":
      return "Subagent completed";
    case "failed":
      return "Subagent failed";
    case "stopped":
      return "Subagent stopped";
  }
}

function cardKindForTrigger(
  kind: AutonomousResumeTrigger["kind"],
): ChatScrollCardKind {
  return kind === "subagent" ? "subagent" : "tool";
}

function triggerKey(trigger: AutonomousResumeTrigger): string {
  return `${trigger.kind}:${trigger.blockId}:${trigger.title}:${trigger.status}`;
}

export function AutonomousResumeSegment(props: AutonomousResumeSegmentProps) {
  const { triggers } = props;
  const scrollToBlock = useScrollToChatBlock();

  // Subagent triggers with a meaningful summary are rendered as expandable
  // cards. All other triggers remain inline in the compact "Resumed ·" row.
  const subagentCardTriggers = triggers.filter(
    (t) => t.kind === "subagent" && t.summary.trim().length > 0,
  );
  const inlineTriggers = triggers.filter(
    (t) => t.kind !== "subagent" || t.summary.trim().length === 0,
  );

  return (
    <div className="flex flex-col gap-2">
      {inlineTriggers.length > 0 || subagentCardTriggers.length === 0 ? (
        <div
          data-testid="autonomous-resume-marker"
          className={cn(
            "flex w-fit min-w-0 max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5",
            "rounded-md border border-border/40 bg-muted/20 px-2 py-1",
            "text-ui-xs text-muted-foreground",
          )}
        >
          <RotateCw className="size-3.5 shrink-0" aria-hidden />
          <span className="shrink-0 font-medium text-foreground/80">
            Resumed
          </span>
          {inlineTriggers.length > 0 ? (
            <span aria-hidden className="shrink-0 text-muted-foreground/40">
              ·
            </span>
          ) : null}
          {inlineTriggers.map((trigger, index) => (
            <Fragment key={triggerKey(trigger)}>
              {index > 0 ? (
                <span aria-hidden className="shrink-0 text-muted-foreground/40">
                  ·
                </span>
              ) : null}
              <ResumeTriggerRef trigger={trigger} onScroll={scrollToBlock} />
            </Fragment>
          ))}
        </div>
      ) : null}
      {subagentCardTriggers.map((trigger) => (
        <SubagentCompletionCard key={triggerKey(trigger)} trigger={trigger} />
      ))}
    </div>
  );
}

function ResumeTriggerRef(props: {
  readonly trigger: AutonomousResumeTrigger;
  readonly onScroll: ScrollToChatBlock | null;
}) {
  const { trigger, onScroll } = props;
  const title = formatSingleLine(trigger.title, {
    maxLength: 60,
    ellipsis: "…",
  });
  const content = (
    <>
      <span className="text-muted-foreground">{kindNoun(trigger.kind)}</span>{" "}
      <span className="font-medium text-foreground/85">{title}</span>{" "}
      <span className="text-muted-foreground">
        {statusVerb(trigger.status)}
      </span>
    </>
  );
  // No scroll target (older trigger missing its block id, or no chat tile in
  // context) → render the reference as inert text rather than a dead button.
  if (onScroll === null || trigger.blockId.length === 0) {
    return <span className="min-w-0">{content}</span>;
  }
  return (
    <button
      type="button"
      onClick={() =>
        onScroll(trigger.blockId, cardKindForTrigger(trigger.kind))
      }
      className={cn(
        "-mx-1 min-w-0 rounded px-1 text-left underline-offset-2 transition-colors",
        "hover:text-foreground hover:underline",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )}
    >
      {content}
    </button>
  );
}

/**
 * Expandable card for a settled background subagent, showing the full markdown
 * result. Modelled after the A2A "Received message" card.
 */
function SubagentCompletionCard(props: {
  readonly trigger: AutonomousResumeTrigger;
}) {
  const { trigger } = props;
  const [open, setOpen] = useState(false);

  const title = formatSingleLine(trigger.title, {
    maxLength: 60,
    ellipsis: "…",
  });
  const StatusIcon = trigger.status === "completed" ? CheckCheck : XCircle;

  const header = (
    <>
      <StatusIcon
        className="size-3.5 shrink-0 text-foreground/60"
        aria-hidden
      />
      <span className="shrink-0 text-ui-sm font-medium text-foreground/85">
        {subagentStatusTitle(trigger.status)}
      </span>
      <span aria-hidden className="shrink-0 text-muted-foreground/40">
        ·
      </span>
      <span className="min-w-0 flex-1 truncate text-ui-sm font-medium text-foreground/85">
        {title}
      </span>
    </>
  );

  const preview = (
    <p className="m-0 line-clamp-2 text-ui-sm leading-6 text-foreground/85">
      {formatSingleLine(trigger.summary, { maxLength: 180, ellipsis: "…" })}
    </p>
  );

  const body = open ? (
    <div className="flex flex-col gap-2">
      <SegmentPanel
        label="Result"
        copyValue={trigger.summary}
        tone="default"
        bodyChrome="framed"
        className={undefined}
      >
        <div className="max-h-[min(40vh,24rem)] overflow-auto px-3 py-2">
          <AgentReferenceMarkdown
            isStreaming={false}
            markdown={trigger.summary}
            proseSize="compact"
          />
        </div>
      </SegmentPanel>
    </div>
  ) : null;

  return (
    <div className="w-full max-w-[min(100%,48rem)]">
      <SegmentCard
        open={open}
        onOpenChange={setOpen}
        header={header}
        headerAction={null}
        collapsedPreview={preview}
        body={body}
        tone="default"
        headerPosition="normal"
        bodyOverflow="hidden"
        expandable
        className={undefined}
      />
    </div>
  );
}
