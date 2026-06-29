import { RotateCw } from "lucide-react";
import { Fragment } from "react";
import type { AutonomousResumeTrigger } from "@traycer/protocol/persistence/epic/content-blocks";
import {
  useScrollToChatBlock,
  type ChatScrollCardKind,
  type ScrollToChatBlock,
} from "@/components/chat/chat-scroll-to-block";
import { cn, formatSingleLine } from "@/lib/utils";

/**
 * Lean marker at the head of an AUTONOMOUS turn (one with no user message),
 * naming which backgrounded command/Monitor/subagent completion woke the agent
 * - so the resume reads as a consequence, not an abrupt reply. Each trigger is
 * a clickable reference that scrolls back to (and expands) its originating card.
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
  return (
    <div
      data-testid="autonomous-resume-marker"
      className={cn(
        "flex w-fit min-w-0 max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5",
        "rounded-md border border-border/40 bg-muted/20 px-2 py-1",
        "text-ui-xs text-muted-foreground",
      )}
    >
      <RotateCw className="size-3.5 shrink-0" aria-hidden />
      <span className="shrink-0 font-medium text-foreground/80">Resumed</span>
      {triggers.length > 0 ? (
        <span aria-hidden className="shrink-0 text-muted-foreground/40">
          ·
        </span>
      ) : null}
      {triggers.map((trigger, index) => (
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
