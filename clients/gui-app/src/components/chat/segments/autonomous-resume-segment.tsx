import { isDocumentAssetPath } from "@/lib/assets/image-extension-allowlist";
import { Activity, AlarmClockCheck, CheckCheck, XCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { AutonomousResumeTrigger } from "@traycer/protocol/persistence/epic/content-blocks";
import { formatWorkedFor } from "@/lib/format-duration";
import type {
  BackgroundEventEnding,
  FoldedBackgroundEvent,
} from "@/stores/composer/chat-store";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { ManagedCommandTranscriptDoor } from "@/components/managed-commands/managed-command-transcript-door";
import { ManagedCommandMonitorIcon } from "@/components/managed-commands/managed-command-monitor-icon";
import { useMaybeChatTranscript } from "@/components/chat/chat-transcript-context";
import { managedCommandNoun } from "@/lib/managed-commands/managed-command-copy";
import { useManagedCommandDoor } from "@/lib/managed-commands/use-managed-command-door";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { useManagedCommandPresence } from "@/stores/managed-commands/managed-commands-for-chat";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { collapseToSingleLine } from "@/lib/text/format-single-line";
import { AgentReferenceMarkdown } from "./agent-reference-markdown";
import { SegmentCard, SegmentCardHeaderActionCell } from "./segment-card";
import { SegmentRow } from "./segment-row";
import { SegmentPanel } from "./segment-panel";
import { isShellDelivery } from "../chat-monitor-delivery";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";

/**
 * The card for a background event that woke the agent - a shell or monitor
 * update, a shell or background command that ended, a background MCP call, a
 * subagent result, a scheduled wake - so the resume reads as a consequence,
 * not an abrupt reply.
 *
 * - Shell / monitor deliveries: a static card header with an inline summary
 *   and the existing output shortcut, at the same density as a start card.
 * - Other command / wakeup triggers: lazy-fetch captured output on expand.
 * - Subagent triggers with a result summary: rendered as expandable cards
 *   showing the full markdown result.
 *
 * Two densities. `card` is every event drawn on its own: at the head of the
 * turn it woke, or an outcome that arrived mid-turn. `row` is the line inside
 * an activity group, for an update that arrived while the agent was already
 * working.
 *
 * The last card of a segment carries two more things in its foot: how the
 * turn it heads ended when it drew no reply (`ending`), and the earlier events
 * from the same source the agent let pass, whose own rows were folded into this
 * one (`folded`, see `foldBackgroundEventRows`). Both live inside the card, so
 * a finished event never leaves a second row under it, and a card never
 * changes its form when the turn it heads ends.
 */
type AutonomousResumeVariant = "card" | "row";

/** How the turn a card heads ended when it drew no reply. */
export interface BackgroundEventCardEnding {
  readonly value: BackgroundEventEnding;
  /** The turn's details (provider, model, timing) for a tooltip, or `null`. */
  readonly details: ReactNode | null;
}

interface AutonomousResumeSegmentProps {
  readonly triggers: ReadonlyArray<AutonomousResumeTrigger>;
  readonly variant: AutonomousResumeVariant;
  readonly ending: BackgroundEventCardEnding | null;
  readonly folded: ReadonlyArray<FoldedBackgroundEvent>;
}

const RESUME_OUTPUT_FILE_MAX_BYTES = 500_000;

const NO_FOLDED_EVENTS: ReadonlyArray<FoldedBackgroundEvent> = [];

function triggerKey(trigger: AutonomousResumeTrigger): string {
  return `${trigger.kind}:${trigger.managedCommand?.commandId ?? "none"}:${trigger.blockId}:${trigger.title}:${trigger.status}`;
}

export function AutonomousResumeSegment(props: AutonomousResumeSegmentProps) {
  const { triggers } = props;
  const lastIndex = triggers.length - 1;

  return (
    <div className="flex flex-col gap-2">
      {triggers.map((trigger, index) => (
        <ResumeCompletionCard
          key={triggerKey(trigger)}
          trigger={trigger}
          variant={props.variant}
          ending={index === lastIndex ? props.ending : null}
          folded={index === lastIndex ? props.folded : NO_FOLDED_EVENTS}
        />
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
  readonly variant: AutonomousResumeVariant;
  readonly ending: BackgroundEventCardEnding | null;
  readonly folded: ReadonlyArray<FoldedBackgroundEvent>;
}) {
  const { trigger, folded } = props;
  const [open, setOpen] = useState(false);
  const compact = isShellDelivery(trigger);
  // Every line in this header is uncapped: each span below `truncate`s itself
  // at the row's width (the full text stays in its tooltip), so a character
  // cap in front could only end it early on a wide reading column.
  const deliverySummary = shellDeliverySummary(trigger);

  // An auto-backgrounded MCP call rides a "command" trigger (the kind enum is
  // frozen for old-host chat parses); the structured identity is what marks it
  // as MCP work, so prefer it over the CLI's freeform "server/tool" title.
  const rawTitle =
    trigger.mcp === null
      ? trigger.title
      : `${trigger.mcp.serverName} · ${trigger.mcp.toolName}`;
  const title = collapseToSingleLine(rawTitle);
  // Non-subagent triggers only have something to reveal when there's a captured
  // output file - without one the body is just "Output file unavailable." every
  // time, so collapse to a static single-row card. Shell and wakeup triggers
  // do not normally have capturable output files; subagents always have a
  // markdown result to show.
  const hasOwnBody =
    !compact && (trigger.kind === "subagent" || trigger.outputFile !== null);
  const header = (
    <>
      {resumeStatusIcon(trigger)}
      <span className="shrink-0 text-ui-sm font-medium text-foreground/85">
        {resumeStatusTitle(trigger)}
      </span>
      <span aria-hidden className="shrink-0 text-muted-foreground/40">
        ·
      </span>
      <TooltipWrapper
        label={rawTitle}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <span className="min-w-0 flex-1 truncate text-ui-sm font-medium text-foreground/85">
          {title}
        </span>
      </TooltipWrapper>
      {compact && deliverySummary.length > 0 ? (
        <TooltipWrapper
          label={trigger.summary}
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <span className="max-w-[40%] shrink truncate text-ui-xs text-muted-foreground">
            {deliverySummary}
          </span>
        </TooltipWrapper>
      ) : null}
    </>
  );

  const preview =
    !compact && trigger.summary.trim().length > 0 ? (
      <p className="m-0 line-clamp-2 text-ui-sm leading-6 text-foreground/85">
        {/* Uncapped: `line-clamp-2` cuts it at two lines of the row's width. */}
        {collapseToSingleLine(trigger.summary)}
      </p>
    ) : null;

  if (props.variant === "row") {
    return (
      <ResumeCompletionLine
        trigger={trigger}
        header={header}
        open={open}
        onOpenChange={setOpen}
      />
    );
  }

  // The earlier events open with the card's own disclosure, below whatever
  // the event itself has to show, so a card has one chevron, never two.
  const body = open ? (
    <div className="flex flex-col gap-2">
      {hasOwnBody ? (
        <ResumeCompletionCardBody trigger={trigger} enabled={open} />
      ) : null}
      {folded.length > 0 ? <FoldedBackgroundEventList folded={folded} /> : null}
    </div>
  ) : null;
  const footer =
    props.ending === null && folded.length === 0 ? null : (
      <BackgroundEventFooter ending={props.ending} folded={folded} />
    );
  return (
    <div className="w-full">
      <SegmentCard
        open={open}
        onOpenChange={setOpen}
        header={header}
        headerAction={
          <ResumeManagedCommandDoor trigger={trigger} variant="card" />
        }
        collapsedPreview={preview}
        body={body}
        footer={footer}
        tone="default"
        headerPosition="normal"
        bodyOverflow="hidden"
        headerFindUnitId={null}
        bodyFindUnitId={null}
        expandable={hasOwnBody || folded.length > 0}
        className={undefined}
      />
    </div>
  );
}

/** The static line an update takes inside an activity group. */
function ResumeCompletionLine(props: {
  readonly trigger: AutonomousResumeTrigger;
  readonly header: ReactNode;
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
}) {
  return (
    <SegmentRow
      header={props.header}
      headerAction={
        <ResumeManagedCommandDoor trigger={props.trigger} variant="row" />
      }
      // A static line never opens: nothing sets `open` without a trigger.
      open={props.open}
      onOpenChange={props.onOpenChange}
      body={null}
      tone="default"
      stickyHeader={false}
      expandable={false}
      headerFindUnitId={null}
      bodyFindUnitId={null}
      className="w-fit max-w-full"
      footer={null}
    />
  );
}

/**
 * The card's foot: how the turn it heads ended, then how many earlier events
 * it holds. "No reply" goes on the count only when the card has no ending of
 * its own to say it - that is, when the agent acted on this event, or is still
 * reading it, after letting the earlier ones pass.
 */
function BackgroundEventFooter(props: {
  readonly ending: BackgroundEventCardEnding | null;
  readonly folded: ReadonlyArray<FoldedBackgroundEvent>;
}) {
  const { ending, folded } = props;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
      {ending === null ? null : <BackgroundEventEndingLabel ending={ending} />}
      {ending !== null && folded.length > 0 ? (
        <span aria-hidden className="text-muted-foreground/40">
          ·
        </span>
      ) : null}
      {folded.length > 0 ? (
        <span>{foldedEventsSummary(folded, ending === null)}</span>
      ) : null}
    </span>
  );
}

function BackgroundEventEndingLabel(props: {
  readonly ending: BackgroundEventCardEnding;
}) {
  const label = backgroundEventEndingLabel(props.ending.value);
  if (props.ending.details === null) return <span>{label}</span>;
  // A button so the details are on the keyboard path as well as the
  // pointer's, the way the elapsed footer they replace offered them.
  return (
    <TooltipWrapper
      label={props.ending.details}
      side="top"
      sideOffset={6}
      align="start"
    >
      <button
        type="button"
        data-testid="background-event-ending"
        className="cursor-default rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {label}
      </button>
    </TooltipWrapper>
  );
}

function backgroundEventEndingLabel(ending: BackgroundEventEnding): string {
  return ending.kind === "no-reply"
    ? `No reply · ${formatWorkedFor(ending.elapsedMs)}`
    : "Agent not resumed";
}

function foldedEventsSummary(
  folded: ReadonlyArray<FoldedBackgroundEvent>,
  sayNoReply: boolean,
): string {
  const count = `${folded.length} earlier ${foldedEventsNoun(folded)}`;
  return sayNoReply && folded.every((event) => event.ending.kind === "no-reply")
    ? `${count}, no reply`
    : count;
}

function foldedEventsNoun(
  folded: ReadonlyArray<FoldedBackgroundEvent>,
): string {
  const one = folded.length === 1;
  if (folded.every((event) => event.trigger.kind === "wakeup")) {
    return one ? "wake" : "wakes";
  }
  if (folded.every((event) => event.trigger.live)) {
    return one ? "update" : "updates";
  }
  return one ? "event" : "events";
}

/** The earlier events, oldest first, each with how it ended. */
function FoldedBackgroundEventList(props: {
  readonly folded: ReadonlyArray<FoldedBackgroundEvent>;
}) {
  return (
    <SegmentPanel
      label="Earlier"
      copyValue={null}
      tone="default"
      bodyChrome="framed"
      className={undefined}
    >
      <ul className="m-0 flex list-none flex-col gap-1 px-3 py-2">
        {props.folded.map((event) => (
          <li
            key={event.key}
            className="flex min-w-0 items-center gap-1.5 text-ui-xs text-muted-foreground"
          >
            <span className="min-w-0 truncate">
              {foldedEventText(event.trigger)}
            </span>
            <span aria-hidden className="shrink-0 text-muted-foreground/40">
              ·
            </span>
            <span className="shrink-0">
              {backgroundEventEndingLabel(event.ending)}
            </span>
          </li>
        ))}
      </ul>
    </SegmentPanel>
  );
}

/**
 * What one earlier event said. A shell's events all share its title, so its
 * summary is what tells them apart; any other event is named by its title.
 */
function foldedEventText(trigger: AutonomousResumeTrigger): string {
  if (!isShellDelivery(trigger)) return collapseToSingleLine(trigger.title);
  const summary = shellDeliverySummary(trigger);
  return summary.length > 0 ? summary : collapseToSingleLine(trigger.title);
}

/** A shell delivery's summary without its "still running" lead-in. */
function shellDeliverySummary(trigger: AutonomousResumeTrigger): string {
  return collapseToSingleLine(
    trigger.summary.replace(/^still running\s*(?:[-–—·:]\s*)?/i, ""),
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
  readonly variant: "card" | "row";
}) {
  const managedCommand = props.trigger.managedCommand;
  const epicId = useMaybeOpenEpicHandle()?.epicId ?? null;
  const transcript = useMaybeChatTranscript();
  // The host the digest named as the shell's, or null for a shell the chat's
  // own host produced. Normalized BEFORE anything reads it: a body that
  // reached the store through an older host's full-snapshot line
  // (`chat.subscribe@1.6`/`1.7`) was validated structurally, not deep-parsed,
  // so a key that host never wrote is `undefined` there - and `undefined`
  // must classify as "the chat's own host", not as a foreign one.
  const originHostId = managedCommand?.hostId ?? null;
  // A shell whose digest named its host is not in this tab's set even when
  // the two hosts coincide: a chat cloned onto its remote shell's host still
  // does not own that shell (the source chat does), so a presence read here
  // would call it deleted the moment the owner's snapshot lands. The named
  // host is the only one that could answer, and the door stays open - the
  // output window it opens gives its own account of what it finds, exactly
  // the `unknown` contract. Only a null-origin digest, which the chat's own
  // host wrote for its own shell, takes the deletion gate.
  const presence = useManagedCommandPresence({
    epicId,
    commandId: managedCommand?.commandId ?? "",
    owner: originHostId === null ? transcript : null,
  });
  const openOutput = useManagedCommandDoor();
  if (managedCommand === null || openOutput === null) return null;
  const door = (
    <ManagedCommandTranscriptDoor
      commandId={managedCommand.commandId}
      hostId={originHostId}
      gone={presence.kind === "absent"}
      onOpen={(commandId) => {
        openOutput(commandId, originHostId);
      }}
      testId={`resume-managed-command-door-${props.trigger.blockId}`}
    />
  );
  return props.variant === "card" ? (
    <SegmentCardHeaderActionCell>{door}</SegmentCardHeaderActionCell>
  ) : (
    door
  );
}

function resumeStatusTitle(trigger: AutonomousResumeTrigger): string {
  if (trigger.kind === "wakeup") return wakeupStatusTitle(trigger.status);
  const noun = resumeNoun(trigger);
  // A producer that is still running has no terminal outcome: `status` is
  // carrying its least-wrong placeholder for readers that predate `live`, and
  // showing it here would tell the user the command finished when it has not.
  // The NOUN is still accurate though - the generic "Command" is only for a
  // legacy trigger that names no kind at all, not for every live one. The
  // card is about what the producer just reported, not that it runs: the
  // shell's own card and its dock row already say that.
  if (trigger.live) {
    return `${noun} update`;
  }
  // A settled MCP trigger is always a call the CLI moved to the background
  // (a foreground call settles on its own card and raises no trigger). Saying
  // so keeps "MCP tool failed" from reading as the agent's present state when
  // the outcome lands long after the turn that made the call.
  const settledNoun =
    trigger.mcp !== null && trigger.managedCommand === null
      ? `Background ${noun}`
      : noun;
  switch (trigger.status) {
    case "completed":
      return `${settledNoun} completed`;
    case "failed":
      return `${settledNoun} failed`;
    case "stopped":
      return `${settledNoun} stopped`;
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
  if (trigger.live) {
    if (isShellDelivery(trigger)) {
      return (
        <ManagedCommandMonitorIcon
          monitoring={trigger.managedCommand?.monitoring ?? true}
          decorative
          className={className}
        />
      );
    }
    return <Activity className={className} aria-hidden />;
  }
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
  // A document output file (PDF, Word) would render as raw bytes through the
  // text pipeline - don't even fetch it. Show the path and nothing more: the
  // output folder is often outside every bound root, so any "open it from X"
  // instruction would point somewhere the file cannot be found.
  const isDocumentOutput = isDocumentAssetPath(props.outputFile.filePath);
  const outputQuery = useResumeOutputFileQuery(
    props.outputFile,
    props.enabled && !isDocumentOutput,
  );
  if (isDocumentOutput) {
    return (
      <SegmentPanel
        label="Output"
        copyValue={null}
        tone="default"
        bodyChrome="framed"
        className={undefined}
      >
        <div className="px-3 py-2">
          <p className="m-0 break-all font-mono text-code-sm text-muted-foreground">
            {props.outputFile.filePath}
          </p>
        </div>
      </SegmentPanel>
    );
  }
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
