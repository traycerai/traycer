import { AlarmClockCheck, CheckCheck, XCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { AutonomousResumeTrigger } from "@traycer/protocol/persistence/epic/content-blocks";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { formatSingleLine } from "@/lib/utils";
import { AgentReferenceMarkdown } from "./agent-reference-markdown";
import { SegmentCard } from "./segment-card";
import { SegmentPanel } from "./segment-panel";

/**
 * Lean marker at the head of an AUTONOMOUS turn (one with no user message),
 * naming which backgrounded command/Monitor/subagent completion woke the agent
 * - so the resume reads as a consequence, not an abrupt reply.
 *
 * - Command / monitor triggers: rendered as expandable cards that lazy-fetch
 *   output on expand when an output file is available.
 * - Subagent triggers with a result summary: rendered as expandable cards
 *   showing the full markdown result.
 */
interface AutonomousResumeSegmentProps {
  triggers: ReadonlyArray<AutonomousResumeTrigger>;
}

const RESUME_OUTPUT_FILE_MAX_BYTES = 500_000;

function triggerKey(trigger: AutonomousResumeTrigger): string {
  return `${trigger.kind}:${trigger.blockId}:${trigger.title}:${trigger.status}`;
}

export function AutonomousResumeSegment(props: AutonomousResumeSegmentProps) {
  const { triggers } = props;

  return (
    <div className="flex flex-col gap-2">
      {triggers.map((trigger) =>
        trigger.kind === "wakeup" ? (
          <WakeupResumeDivider key={triggerKey(trigger)} trigger={trigger} />
        ) : (
          <ResumeCompletionCard key={triggerKey(trigger)} trigger={trigger} />
        ),
      )}
    </div>
  );
}

function WakeupResumeDivider(props: {
  readonly trigger: AutonomousResumeTrigger;
}) {
  const { trigger } = props;
  const reason = formatSingleLine(trigger.title, {
    maxLength: 80,
    ellipsis: "…",
  });
  const prompt =
    trigger.summary.trim().length > 0
      ? formatSingleLine(trigger.summary, { maxLength: 180, ellipsis: "…" })
      : null;

  return (
    <div className="flex w-full flex-col gap-1">
      <div className="flex items-center gap-3">
        <span aria-hidden className="h-px flex-1 bg-border/60" />
        <div
          role="separator"
          aria-label={`Woke on schedule: ${reason}`}
          className="flex min-w-0 items-center gap-2 text-ui-xs text-muted-foreground"
        >
          <AlarmClockCheck className="size-3.5 shrink-0" aria-hidden />
          <span className="shrink-0">Woke on schedule:</span>
          <span className="min-w-0 truncate text-muted-foreground/90">
            {reason}
          </span>
        </div>
        <span aria-hidden className="h-px flex-1 bg-border/60" />
      </div>
      {prompt === null ? null : (
        <p className="mx-auto m-0 w-full max-w-[min(90vw,42rem)] rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-ui-sm leading-6 text-foreground/85">
          {prompt}
        </p>
      )}
    </div>
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
      <ResumeCompletionCardBody trigger={trigger} enabled={open} />
    </div>
  ) : null;

  // Command/monitor triggers only have something to reveal when there's a
  // captured output file - without one the body is just "Output file
  // unavailable." every time, so collapse to a static single-row card.
  // Monitor never has a capturable output file (it watches/polls rather than
  // captures stdout - see `claudeOutputFileRef`); subagents always have a
  // markdown result to show.
  const expandable = trigger.kind === "subagent" || trigger.outputFile !== null;

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
        headerFindUnitId={null}
        bodyFindUnitId={null}
        expandable={expandable}
        className={undefined}
      />
    </div>
  );
}

function ResumeCompletionCardBody(props: {
  readonly trigger: AutonomousResumeTrigger;
  readonly enabled: boolean;
}) {
  const { trigger } = props;
  if (trigger.kind === "subagent") {
    return <ResumeResultPanel result={trigger.summary} />;
  }
  if (trigger.outputFile === null) {
    return <ResumeOutputUnavailablePanel />;
  }
  return (
    <ResumeOutputPanel
      outputFile={trigger.outputFile}
      enabled={props.enabled}
    />
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
    case "wakeup":
      return "Wake";
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
      <div className="px-3 py-2">
        <AgentReferenceMarkdown
          isStreaming={false}
          markdown={props.result}
          proseSize="compact"
        />
      </div>
    </SegmentPanel>
  );
}

function ResumeOutputUnavailablePanel() {
  return (
    <SegmentPanel
      label="Output"
      copyValue={null}
      tone="default"
      bodyChrome="framed"
      className={undefined}
    >
      <div className="px-3 py-2">
        {resumeOutputBody({
          outputFileAvailable: false,
          isLoading: false,
          readError: null,
          content: null,
          truncated: false,
        })}
      </div>
    </SegmentPanel>
  );
}

function ResumeOutputPanel(props: {
  readonly outputFile: NonNullable<AutonomousResumeTrigger["outputFile"]>;
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
    outputFileAvailable: true,
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
      <div className="px-3 py-2">{body}</div>
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
  outputFile: NonNullable<AutonomousResumeTrigger["outputFile"]>,
  enabled: boolean,
) {
  const client = useTabHostClient();
  return useHostQuery<HostRpcRegistry, "workspace.readFile">({
    client,
    method: "workspace.readFile",
    params: {
      workspacePath: outputFile.workspacePath,
      filePath: outputFile.filePath,
      maxBytes: RESUME_OUTPUT_FILE_MAX_BYTES,
    },
    options: {
      enabled,
      staleTime: 30 * 1000,
      retry: false,
    },
  });
}
