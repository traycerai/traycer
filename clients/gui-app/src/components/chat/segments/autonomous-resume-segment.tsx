import { CheckCheck, RotateCw, XCircle } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import type { AutonomousResumeTrigger } from "@traycer/protocol/persistence/epic/content-blocks";
import {
  useScrollToChatBlock,
  type ChatScrollCardKind,
  type ScrollToChatBlock,
} from "@/components/chat/chat-scroll-to-block";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { cn, formatSingleLine } from "@/lib/utils";
import { AgentReferenceMarkdown } from "./agent-reference-markdown";
import { SegmentCard } from "./segment-card";
import { SegmentPanel } from "./segment-panel";

/**
 * Lean marker at the head of an AUTONOMOUS turn (one with no user message),
 * naming which backgrounded command/Monitor/subagent completion woke the agent
 * - so the resume reads as a consequence, not an abrupt reply.
 *
 * - Command / monitor triggers with an output file: rendered as expandable
 *   cards that lazy-fetch output on expand.
 * - Subagent triggers with a result summary: rendered as expandable cards
 *   showing the full markdown result.
 * - Triggers without expanded content remain inline in the compact row.
 */
interface AutonomousResumeSegmentProps {
  triggers: ReadonlyArray<AutonomousResumeTrigger>;
}

const RESUME_OUTPUT_FILE_MAX_BYTES = 500_000;

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

function hasExpandedResumeContent(trigger: AutonomousResumeTrigger): boolean {
  if (trigger.kind === "subagent") return trigger.summary.trim().length > 0;
  return trigger.outputFile !== null;
}

export function AutonomousResumeSegment(props: AutonomousResumeSegmentProps) {
  const { triggers } = props;
  const scrollToBlock = useScrollToChatBlock();

  const cardTriggers = triggers.filter(hasExpandedResumeContent);
  const inlineTriggers = triggers.filter((t) => !hasExpandedResumeContent(t));

  return (
    <div className="flex flex-col gap-2">
      {inlineTriggers.length > 0 || cardTriggers.length === 0 ? (
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
      {cardTriggers.map((trigger) => (
        <ResumeCompletionCard key={triggerKey(trigger)} trigger={trigger} />
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
 * Expandable card for a settled background task. Subagents render their
 * markdown result inline; command/monitor triggers fetch their output file on
 * expand through workspace.readFile.
 */
function ResumeCompletionCard(props: {
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
        {resumeStatusTitle(trigger)}
      </span>
      <span aria-hidden className="shrink-0 text-muted-foreground/40">
        ·
      </span>
      <span className="min-w-0 flex-1 truncate text-ui-sm font-medium text-foreground/85">
        {title}
      </span>
    </>
  );

  const preview =
    trigger.summary.trim().length > 0 ? (
      <p className="m-0 line-clamp-2 text-ui-sm leading-6 text-foreground/85">
        {formatSingleLine(trigger.summary, { maxLength: 180, ellipsis: "…" })}
      </p>
    ) : null;

  const body = open ? (
    <div className="flex flex-col gap-2">
      {trigger.kind === "subagent" ? (
        <ResumeResultPanel result={trigger.summary} />
      ) : (
        <ResumeOutputPanel outputFile={trigger.outputFile} enabled={open} />
      )}
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

function resumeStatusTitle(trigger: AutonomousResumeTrigger): string {
  const noun = resumeKindTitle(trigger.kind);
  switch (trigger.status) {
    case "completed":
      return `${noun} completed`;
    case "failed":
      return `${noun} failed`;
    case "stopped":
      return `${noun} stopped`;
  }
}

function resumeKindTitle(kind: AutonomousResumeTrigger["kind"]): string {
  switch (kind) {
    case "command":
      return "Command";
    case "monitor":
      return "Monitor";
    case "subagent":
      return "Subagent";
  }
}

function ResumeResultPanel(props: { readonly result: string }) {
  return (
    <SegmentPanel
      label="Result"
      copyValue={props.result}
      tone="default"
      bodyChrome="framed"
      className={undefined}
    >
      <div className="max-h-[min(40vh,24rem)] overflow-auto px-3 py-2">
        <AgentReferenceMarkdown
          isStreaming={false}
          markdown={props.result}
          proseSize="compact"
        />
      </div>
    </SegmentPanel>
  );
}

function ResumeOutputPanel(props: {
  readonly outputFile: AutonomousResumeTrigger["outputFile"];
  readonly enabled: boolean;
}) {
  const outputQuery = useResumeOutputFileQuery(props.outputFile, props.enabled);
  const content = outputQuery.data?.content ?? null;
  const readError =
    outputQuery.data?.error ?? outputQuery.error?.message ?? null;
  const isLoading =
    outputQuery.isPending ||
    (outputQuery.isFetching && outputQuery.data === undefined);
  const copyValue = content !== null && content.length > 0 ? content : null;
  const tone = readError === null ? "default" : "destructive";
  const body = resumeOutputBody({
    outputFileAvailable: props.outputFile !== null,
    isLoading,
    readError,
    content,
    truncated: outputQuery.data?.truncated === true,
  });

  return (
    <SegmentPanel
      label="Output"
      copyValue={copyValue}
      tone={tone}
      bodyChrome="framed"
      className={undefined}
    >
      <div className="max-h-[min(40vh,24rem)] overflow-auto px-3 py-2">
        {body}
      </div>
    </SegmentPanel>
  );
}

function resumeOutputBody(input: {
  readonly outputFileAvailable: boolean;
  readonly isLoading: boolean;
  readonly readError: string | null;
  readonly content: string | null;
  readonly truncated: boolean;
}): ReactNode {
  if (!input.outputFileAvailable) {
    return (
      <p className="m-0 text-ui-sm text-muted-foreground">
        Output file unavailable.
      </p>
    );
  }
  if (input.isLoading) {
    return (
      <div className="flex items-center gap-2 text-ui-sm text-muted-foreground">
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
        <span>Fetching output</span>
      </div>
    );
  }
  if (input.readError !== null) {
    return <p className="m-0 text-ui-sm text-destructive">{input.readError}</p>;
  }
  if (input.content === null || input.content.length === 0) {
    return <p className="m-0 text-ui-sm text-muted-foreground">No output.</p>;
  }
  return (
    <>
      <pre className="m-0 whitespace-pre-wrap font-mono text-code-sm text-foreground/90">
        {input.content}
      </pre>
      {input.truncated ? (
        <div className="mt-2 text-ui-xs text-muted-foreground">
          Output truncated
        </div>
      ) : null}
    </>
  );
}

function useResumeOutputFileQuery(
  outputFile: AutonomousResumeTrigger["outputFile"],
  enabled: boolean,
) {
  const client = useHostClient();
  return useHostQuery<HostRpcRegistry, "workspace.readFile">({
    client,
    method: "workspace.readFile",
    params: {
      workspacePath: outputFile?.workspacePath ?? "",
      filePath: outputFile?.filePath ?? "",
      maxBytes: RESUME_OUTPUT_FILE_MAX_BYTES,
    },
    options: {
      enabled: enabled && outputFile !== null,
      staleTime: 30 * 1000,
      retry: false,
    },
  });
}
