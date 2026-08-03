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
  const [open, setOpen] = useState<boolean>(false);
  // Elapsed heartbeat while the command runs. A backgrounded command renders in
  // the CARD variant (promoted out of the activity timeline), so both variants
  // need it - the card shows it as its collapsed preview.
  const streamingFooter = isStreaming ? (
    <StreamingActivityFooter startedAt={startedAt} progress={progress} />
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
    // Streaming footer (elapsed; commands carry no progress line) sits beneath
    // the nested row via SegmentRow's `footer` slot.
    return (
      <SegmentRow
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
      // The card variant is the promoted background command; its heartbeat has
      // no row footer to live in, so it rides the collapsed preview.
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
