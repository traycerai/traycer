import { TerminalSquare } from "lucide-react";
import { useState } from "react";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { LivePulse } from "@/components/ui/live-pulse";
import { cn } from "@/lib/utils";
import { SegmentCard } from "./segment-card";
import { SegmentPanel } from "./segment-panel";
import { SegmentRow } from "./segment-row";
import { StreamingActivityFooter } from "./streaming-activity-footer";
import { SegmentEndStateBadge } from "./segment-end-state-badge";
import { LiveElapsed } from "./segment-elapsed";
import type { SegmentEndState } from "@/stores/composer/chat-store";

interface CommandSegmentProps {
  command: string;
  cwd: string | null;
  exitCode: number | null;
  isStreaming: boolean;
  // Terminal outcome when the turn ended mid-run (else null): drives a neutral
  // "stopped"/"superseded" badge instead of a spinner.
  endState: SegmentEndState;
  // True when the run ended because the host stopped it rather than because the
  // command failed: the provider reports its own kill with a synthetic exit
  // code, and showing that would blame the command for something we did.
  stopped: boolean;
  // Latest progress line (null today; commands carry no progress signal yet).
  progress: string | null;
  // Wall-clock start (epoch ms) driving the elapsed heartbeat while streaming.
  startedAt: number;
  variant: "card" | "row";
  headerFindUnitId: string | null;
  // Seeds the disclosure at mount, once. Open state is local here, so the copy
  // of this row inside the bounded live activity window cannot hand its own
  // over: a click there promotes, and this is how the copy that replaces it
  // knows it was the row asked for.
  initiallyOpen: boolean;
}

// Mirrors `toolCardTone` so a promoted background command reads the same as a
// promoted background tool call: live work is tinted, a failure is destructive.
function commandCardTone(
  errored: boolean,
  isStreaming: boolean,
): "default" | "destructive" | "primary" {
  if (errored) return "destructive";
  if (isStreaming) return "primary";
  return "default";
}

export function CommandSegment(props: CommandSegmentProps) {
  const { command, cwd, exitCode, isStreaming, variant } = props;
  const { endState, stopped, progress, startedAt } = props;
  const errored = !stopped && exitCode !== null && exitCode !== 0;
  const [open, setOpen] = useState<boolean>(props.initiallyOpen);
  // Progress line under a running command, when one exists.
  // Progress only, and only when there is some. Commands carry no progress
  // signal today, so in practice a running command now renders no footer at all
  // - its heartbeat is the elapsed counter and pulse in the header row.
  const streamingFooter =
    isStreaming && progress !== null && progress.length > 0 ? (
      <StreamingActivityFooter progress={progress} />
    ) : null;

  const exitBadge = (() => {
    if (isStreaming) return null;
    // A stop is reported by the provider as a synthetic exit code; the
    // "Stopped" badge below is the honest rendering of it.
    if (stopped) return null;
    if (exitCode === null) return null;
    return (
      <span
        className={cn(
          "shrink-0 rounded border px-1 font-mono text-code-xs font-medium",
          errored
            ? "border-destructive/40 bg-destructive/10 text-destructive"
            : "border-border/50 bg-muted/50 text-muted-foreground",
        )}
      >
        exit {exitCode}
      </span>
    );
  })();

  const commandLabelEl = (
    <span className="min-w-0 flex-1 truncate font-mono text-code-sm text-foreground/85">
      {command}
    </span>
  );

  const header = (
    <>
      <TerminalSquare
        className="size-3.5 shrink-0 text-muted-foreground/80"
        aria-hidden
      />
      <TooltipWrapper
        label={
          cwd === null || cwd.length === 0 ? null : (
            <span className="font-mono text-code-sm">cwd: {cwd}</span>
          )
        }
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        {commandLabelEl}
      </TooltipWrapper>
      {/* Elapsed, then the pulse, then the outcome - the same trailing cluster
          `GenericToolHeader` and the subagent rows build, so a mixed group lines
          its right edge up. The counter used to sit in the streaming footer,
          which gave a running command a second row holding nothing but "37s":
          commands report no progress, so the footer existed only to carry it.

          Only while it runs. A settled row shows no total, which is unchanged -
          the counter only ever existed while streaming - and is a density call
          for a list of finished rows, NOT a deferral to the group header, whose
          summary carries a duration for thinking alone.

          `data-find-skip` because it is inside the row's find anchor now, and
          the projection indexes the command, not the ticking digits. */}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {isStreaming ? (
          <span data-find-skip className="contents">
            <LiveElapsed startedAt={startedAt} />
          </span>
        ) : null}
        {isStreaming ? (
          <LivePulse
            size="xs"
            tone="active"
            ariaLabel="Command running"
            className={undefined}
          />
        ) : null}
        {exitBadge}
        <SegmentEndStateBadge endState={endState} stopped={stopped} />
      </span>
    </>
  );

  const body = open ? (
    <div className="flex flex-col gap-2">
      <SegmentPanel
        label="Command"
        copyValue={command}
        tone="default"
        bodyChrome="framed"
        className={undefined}
      >
        <pre className="m-0 px-3 py-2 font-mono text-code-sm whitespace-pre-wrap text-foreground/90">
          <span className="text-muted-foreground">$ </span>
          {command}
        </pre>
      </SegmentPanel>
    </div>
  ) : null;

  if (variant === "row") {
    return (
      <SegmentRow
        headerAction={null}
        open={open}
        onOpenChange={setOpen}
        header={header}
        body={body}
        tone={errored ? "destructive" : "default"}
        stickyHeader
        expandable
        headerFindUnitId={props.headerFindUnitId}
        bodyFindUnitId={null}
        className={undefined}
        footer={streamingFooter}
      />
    );
  }
  return (
    <SegmentCard
      open={open}
      onOpenChange={setOpen}
      header={header}
      headerAction={null}
      // The card variant is the promoted background command. Its heartbeat -
      // elapsed and pulse - is in the shared header now, so this carries only a
      // progress line, and only if one is ever reported.
      collapsedPreview={streamingFooter}
      body={body}
      tone={commandCardTone(errored, isStreaming)}
      headerPosition="normal"
      bodyOverflow="hidden"
      expandable
      headerFindUnitId={props.headerFindUnitId}
      bodyFindUnitId={null}
      className={undefined}
    />
  );
}
