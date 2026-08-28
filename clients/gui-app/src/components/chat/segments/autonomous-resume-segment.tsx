import { Activity, AlarmClockCheck, CheckCheck, XCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { AutonomousResumeTrigger } from "@traycer/protocol/persistence/epic/content-blocks";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { ManagedCommandTranscriptDoor } from "@/components/managed-commands/managed-command-transcript-door";
import { useMaybeChatTranscript } from "@/components/chat/chat-transcript-context";
import { managedCommandNoun } from "@/lib/managed-commands/managed-command-copy";
import { useManagedCommandDoor } from "@/lib/managed-commands/use-managed-command-door";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { useManagedCommandPresence } from "@/stores/managed-commands/managed-commands-for-chat";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { formatSingleLine } from "@/lib/utils";
import { AgentReferenceMarkdown } from "./agent-reference-markdown";
import { SegmentCard, SegmentCardHeaderActionCell } from "./segment-card";
import { SegmentPanel } from "./segment-panel";

/**
 * Lean marker at the head of an AUTONOMOUS turn (one with no user message),
 * naming which backgrounded command/shell/subagent completion or scheduled
 * wakeup woke the agent - so the resume reads as a consequence, not an abrupt
 * reply.
 *
 * - Command / shell / wakeup triggers: rendered as cards that lazy-fetch
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
      {triggers.map((trigger) => (
        <ResumeCompletionCard key={triggerKey(trigger)} trigger={trigger} />
      ))}
    </div>
  );
}

/**
 * Card for a trigger that resumed an autonomous turn. Subagents render their
 * markdown result inline; output-backed triggers fetch their output file on
 * expand through workspace.readFile.
 */
function ResumeCompletionCard(props: {
  readonly trigger: AutonomousResumeTrigger;
}) {
  const { trigger } = props;
  const [open, setOpen] = useState(false);

  // An auto-backgrounded MCP call rides a "command" trigger (the kind enum is
  // frozen for old-host chat parses); the structured identity is what marks it
  // as MCP work, so prefer it over the CLI's freeform "server/tool" title.
  const rawTitle =
    trigger.mcp === null
      ? trigger.title
      : `${trigger.mcp.serverName} · ${trigger.mcp.toolName}`;
  const title = formatSingleLine(rawTitle, {
    maxLength: 60,
    ellipsis: "…",
  });
  const header = (
    <>
      {resumeStatusIcon(trigger)}
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

  // Non-subagent triggers only have something to reveal when there's a captured
  // output file - without one the body is just "Output file unavailable." every
  // time, so collapse to a static single-row card. Shell and wakeup triggers
  // do not normally have capturable output files; subagents always have a
  // markdown result to show.
  const expandable = trigger.kind === "subagent" || trigger.outputFile !== null;

  return (
    <div className="w-full max-w-[min(100%,48rem)]">
      <SegmentCard
        open={open}
        onOpenChange={setOpen}
        header={header}
        headerAction={<ResumeManagedCommandDoor trigger={props.trigger} />}
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

/**
 * Opens the output window for the command whose delivery woke this turn
 * (`UI.md` §5). Absent on an older trigger that carries no command id - there
 * is nothing to open, and a dead button would be worse than none.
 *
 * The same door the start and restart cards use, presence gate included: this
 * card outlives its shell too, and a live button on a deleted one would open -
 * or drag onto the canvas - a tile for output that no longer exists.
 */
function ResumeManagedCommandDoor(props: {
  readonly trigger: AutonomousResumeTrigger;
}) {
  const managedCommand = props.trigger.managedCommand;
  const epicId = useMaybeOpenEpicHandle()?.epicId ?? null;
  const presence = useManagedCommandPresence({
    epicId,
    commandId: managedCommand?.commandId ?? "",
    owner: useMaybeChatTranscript(),
  });
  const openOutput = useManagedCommandDoor();
  if (managedCommand === null || openOutput === null) return null;
  return (
    <SegmentCardHeaderActionCell>
      <ManagedCommandTranscriptDoor
        commandId={managedCommand.commandId}
        gone={presence.kind === "absent"}
        onOpen={openOutput}
        testId={`resume-managed-command-door-${props.trigger.blockId}`}
      />
    </SegmentCardHeaderActionCell>
  );
}

function resumeStatusTitle(trigger: AutonomousResumeTrigger): string {
  if (trigger.kind === "wakeup") return wakeupStatusTitle(trigger.status);
  const noun = resumeNoun(trigger);
  // A producer that is still running has no terminal outcome: `status` is
  // carrying its least-wrong placeholder for readers that predate `live`, and
  // showing it here would tell the user the command finished when it has not.
  // The NOUN is still accurate though - the generic "Command" is only for a
  // legacy trigger that names no kind at all, not for every live one.
  if (trigger.live) {
    return trigger.managedCommand === null
      ? "Command still running"
      : `${noun} still running`;
  }
  switch (trigger.status) {
    case "completed":
      return `${noun} completed`;
    case "failed":
      return `${noun} failed`;
    case "stopped":
      return `${noun} stopped`;
  }
}

function resumeNoun(trigger: AutonomousResumeTrigger): string {
  // A trigger WITH a managed-command block names a Traycer shell, so it is
  // named the way every other shell surface names one - by its monitor flag. A
  // divider persisted before the flag existed reads as `false`, so an old chat
  // says Shell rather than guessing at a watcher.
  const managedCommand = trigger.managedCommand;
  if (managedCommand !== null) {
    return managedCommandNoun(managedCommand.monitoring);
  }
  if (trigger.mcp !== null) return "MCP tool";
  return resumeKindTitle(trigger.kind);
}

function wakeupStatusTitle(status: AutonomousResumeTrigger["status"]): string {
  switch (status) {
    case "completed":
      return "Woke on schedule";
    case "failed":
      return "Scheduled wake failed";
    case "stopped":
      return "Scheduled wake canceled";
  }
}

function resumeKindTitle(kind: AutonomousResumeTrigger["kind"]): string {
  switch (kind) {
    case "command":
      return "Command";
    // NOT the Traycer shell entity: a trigger with no `managedCommand` block
    // that still says "monitor" is the harness's OWN background task - Claude
    // Code's native Monitor tool - and keeps that tool's real name. Traycer
    // shells are titled through `resumeNoun`'s `managedCommand` branch, which
    // now reaches the same word for a watching shell; the two dividers still
    // differ where it counts, since only a Traycer shell offers a door into
    // its output window.
    case "monitor":
      return "Monitor";
    case "subagent":
      return "Subagent";
    case "wakeup":
      return "Wake";
  }
}

function resumeStatusIcon(trigger: AutonomousResumeTrigger): ReactNode {
  const className = "size-3.5 shrink-0 text-foreground/60";
  // Neither a success check nor a failure cross: nothing has settled yet.
  if (trigger.live) return <Activity className={className} aria-hidden />;
  if (trigger.status !== "completed") {
    return <XCircle className={className} aria-hidden />;
  }
  if (trigger.kind === "wakeup") {
    return <AlarmClockCheck className={className} aria-hidden />;
  }
  return <CheckCheck className={className} aria-hidden />;
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
          quotable={false}
          components={null}
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
    cacheKeyIdentity: undefined,
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
