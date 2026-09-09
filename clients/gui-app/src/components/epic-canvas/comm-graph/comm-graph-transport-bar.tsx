/**
 * The media-player transport docked under the graph: play/pause, speed, and a
 * scrubber whose track carries one marker per captured event.
 *
 * IT OWNS THE CURSOR, and it is the only thing that does. The sidebar panel that
 * used to own playback is gone; the per-epic cursor store survived it, so the
 * graph still remembers where it was left when the tile is closed and reopened.
 *
 * THE TRACK IS THE LOG. Markers are the events themselves, one per row, at their
 * own timestamps - not buckets, not a sample. Crowding IS the information: a
 * burst of traffic should look like a burst.
 *
 * LIVE IS THE RIGHT EDGE, not a mode. `cursor === null` puts the playhead at the
 * end of everything captured and lets new rows extend the track under it;
 * scrubbing back sets a cursor and detaches, exactly like the old scroller
 * detach did; scrubbing (or playing) to the end re-attaches. There is no
 * separate "live" rendering path that could disagree with the replayed one.
 *
 * SEEKING HAS A KEYBOARD PATH, and not only for accessibility: pointer seeking
 * needs a laid-out track (`getBoundingClientRect`), which jsdom does not
 * provide, so the arrow-key path is also the one an integrated test can drive
 * against the real store. All the positional math lives in
 * `lib/comm-graph/comm-graph-transport.ts` where it can be tested on numbers.
 */
import {
  useCallback,
  useMemo,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { PauseIcon, PlayIcon } from "lucide-react";
import { cn, formatSingleLine } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { LivePulse } from "@/components/ui/live-pulse";
import { markdownToPlainText } from "@/lib/markdown/markdown-to-plain-text";
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";
import {
  commGraphEventAtFraction,
  commGraphPlayheadFraction,
  commGraphTimeRange,
  commGraphTransportMarkers,
  type CommGraphTransportMarker,
} from "@/lib/comm-graph/comm-graph-transport";
import {
  useCommGraphTransport,
  type CommGraphTransport,
} from "@/components/epic-canvas/comm-graph/use-comm-graph-transport";

const MARKER_PREVIEW_MAX_CHARS = 120;

export interface CommGraphTransportBarProps {
  readonly epicId: string;
  /**
   * The FULL merged array, not the as-of prefix: the track spans everything
   * captured, and the playhead moves across it. Handing this the projection
   * would shrink the track every time the user scrubbed back.
   */
  readonly events: ReadonlyArray<CommGraphEvent>;
}

function markerTitle(event: CommGraphEvent): string {
  const when = new Date(event.timestamp).toLocaleTimeString();
  const text = event.messageText;
  if (text === null || text.length === 0) return when;
  const preview = formatSingleLine(markdownToPlainText(text), {
    maxLength: MARKER_PREVIEW_MAX_CHARS,
    ellipsis: "…",
  });
  if (preview.length === 0) return when;
  return `${when} — ${preview}`;
}

export function CommGraphTransportBar(props: CommGraphTransportBarProps) {
  const { epicId, events } = props;
  const transport = useCommGraphTransport(epicId, events);

  const range = useMemo(() => commGraphTimeRange(events), [events]);
  const markers = useMemo(
    () => (range === null ? [] : commGraphTransportMarkers(events, range)),
    [events, range],
  );
  const playhead = commGraphPlayheadFraction(transport.cursor, range);

  const seekToFraction = useCallback(
    (fraction: number) => {
      if (range === null) return;
      const event = commGraphEventAtFraction(events, range, fraction);
      if (event === null) return;
      transport.seekToEvent(event);
    },
    [events, range, transport],
  );

  return (
    <div
      data-testid="comm-graph-transport"
      className="flex w-full min-w-0 shrink-0 items-center gap-2 border-t border-border/60 bg-background px-2 py-1.5"
    >
      <ButtonGroup>
        <Button
          type="button"
          size="icon-xs"
          variant="outline"
          aria-label={transport.playing ? "Pause playback" : "Play timeline"}
          data-testid="comm-graph-transport-play"
          disabled={events.length === 0}
          onClick={transport.togglePlay}
        >
          {transport.playing ? <PauseIcon /> : <PlayIcon />}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          aria-label={`Playback speed ${transport.speed}x`}
          data-testid="comm-graph-transport-speed"
          className="tabular-nums"
          onClick={transport.cycleSpeed}
        >
          {transport.speed}×
        </Button>
      </ButtonGroup>

      <CommGraphTransportTrack
        transport={transport}
        events={events}
        markers={markers}
        playhead={playhead}
        onSeekToFraction={seekToFraction}
      />

      {/*
        WITH NOTHING CAPTURED THERE IS NO LIVE BADGE either: "Live" next to an
        empty track reads as a feed that is stuck, when the truth is that there
        has been nothing to feed. The track itself says so.
      */}
      {events.length === 0 ? null : (
        <CommGraphFollowLiveButton transport={transport} />
      )}
    </div>
  );
}

/**
 * The scrubber itself. Split out so the bar stays a layout shell and the track's
 * one real subtlety - what it means when there is nothing to scrub - lives in
 * one place.
 */
function CommGraphTransportTrack(props: {
  readonly transport: CommGraphTransport;
  readonly events: ReadonlyArray<CommGraphEvent>;
  readonly markers: ReadonlyArray<CommGraphTransportMarker>;
  readonly playhead: number;
  readonly onSeekToFraction: (fraction: number) => void;
}) {
  const { events, markers, onSeekToFraction, playhead, transport } = props;
  const trackRef = useRef<HTMLDivElement | null>(null);
  const hasEvents = events.length > 0;

  const fractionFromPointer = useCallback((clientX: number): number | null => {
    const track = trackRef.current;
    if (track === null) return null;
    const rect = track.getBoundingClientRect();
    // jsdom (and a track that has not been laid out yet) reports zero width;
    // dividing by it would seek to NaN, so a pointer seek simply does not
    // happen until there is a real track to seek along.
    if (rect.width <= 0) return null;
    return (clientX - rect.left) / rect.width;
  }, []);

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const fraction = fractionFromPointer(event.clientX);
      if (fraction === null) return;
      // Capture so a drag that leaves the track keeps scrubbing instead of
      // stopping wherever the pointer crossed the edge.
      event.currentTarget.setPointerCapture(event.pointerId);
      onSeekToFraction(fraction);
    },
    [fractionFromPointer, onSeekToFraction],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const fraction = fractionFromPointer(event.clientX);
      if (fraction === null) return;
      onSeekToFraction(fraction);
    },
    [fractionFromPointer, onSeekToFraction],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (events.length === 0) return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        transport.stepForward();
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        transport.stepBackward();
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        transport.seekToEvent(events[0]);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        transport.followLive();
      }
    },
    [events, transport],
  );

  // After the hooks, so the two renderings share one hook order.
  if (!hasEvents)
    return <CommGraphEmptyTrack following={transport.following} />;

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label="Event timeline"
      aria-valuemin={0}
      aria-valuemax={events.length - 1}
      aria-valuenow={transport.cursorIndex}
      aria-valuetext={trackValueText(transport)}
      data-testid="comm-graph-transport-track"
      data-following={transport.following ? "true" : "false"}
      data-empty="false"
      className="relative h-6 min-w-0 flex-1 cursor-pointer rounded-sm bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onKeyDown={handleKeyDown}
    >
      {/* Elapsed fill: everything the graph is currently showing. */}
      <div
        aria-hidden
        data-testid="comm-graph-transport-elapsed"
        className="absolute inset-y-0 left-0 rounded-sm bg-primary/10"
        style={{ width: `${playhead * 100}%` }}
      />
      {markers.map((marker) => (
        <TooltipWrapper
          key={marker.key}
          label={markerTitle(marker.event)}
          side="top"
          sideOffset={4}
          align="center"
        >
          <span
            aria-hidden
            data-testid={`comm-graph-transport-marker-${marker.key}`}
            data-kind={marker.event.kind}
            className={cn(
              "absolute top-1 bottom-1 w-px -translate-x-1/2",
              marker.event.kind === "a2a_notice"
                ? "bg-amber-500/70"
                : "bg-foreground/25",
            )}
            style={{ left: `${marker.fraction * 100}%` }}
          />
        </TooltipWrapper>
      ))}
      <div
        aria-hidden
        data-testid="comm-graph-transport-playhead"
        className="absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-primary"
        style={{ left: `${playhead * 100}%` }}
      />
    </div>
  );
}

/**
 * WITH NOTHING CAPTURED THERE IS NO SLIDER, not a slider that reports
 * nonsense. An empty epic has no positions to be at, so declaring
 * `min=0 max=0 valuenow=-1` would put a focusable control in the tab order
 * that announces a value outside its own range and moves nowhere when driven.
 *
 * The empty track SAYS it is empty instead. A blank bar beside a disabled play
 * button reads as a control that is broken; a word in its place reads as a log
 * that has nothing in it yet - which is the only thing that is true. Short and
 * literal: created rows are events too, so this is not "no messages".
 */
function CommGraphEmptyTrack(props: { readonly following: boolean }) {
  return (
    <div
      aria-disabled
      data-testid="comm-graph-transport-track"
      data-following={props.following ? "true" : "false"}
      data-empty="true"
      className="relative flex h-6 min-w-0 flex-1 cursor-default items-center justify-center rounded-sm bg-muted/40"
    >
      <span
        data-testid="comm-graph-transport-empty"
        className="text-ui-xs text-muted-foreground"
      >
        No events yet
      </span>
    </div>
  );
}

/**
 * The Live badge. A TOGGLE, not a one-way door: pressed while detached it
 * re-attaches and remembers where you were; pressed again while live it takes
 * you back there. With nothing to go back to it is a plain "Live".
 */
function CommGraphFollowLiveButton(props: {
  readonly transport: CommGraphTransport;
}) {
  const { transport } = props;
  const canReturn = transport.following && transport.returnCursor !== null;
  const button = (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      aria-pressed={transport.following}
      data-testid="comm-graph-transport-follow-live"
      data-following={transport.following ? "true" : "false"}
      data-can-return={canReturn ? "true" : "false"}
      onClick={canReturn ? transport.returnToReplay : transport.followLive}
      className={cn(
        "shrink-0",
        transport.following
          ? "bg-primary/5 text-primary"
          : "text-muted-foreground",
      )}
    >
      <LivePulse
        size="xs"
        tone={transport.following ? "active" : "idle"}
        ariaLabel={
          transport.following ? "Following live" : "Detached from live"
        }
        className={undefined}
      />
      {transport.following ? "Live" : "Follow live"}
    </Button>
  );
  if (!canReturn) return button;
  return (
    <TooltipWrapper
      label="Back to replay position"
      side="top"
      sideOffset={4}
      align="center"
    >
      {button}
    </TooltipWrapper>
  );
}

function trackValueText(transport: CommGraphTransport): string {
  if (transport.following) return "Live";
  return `Event ${transport.cursorIndex + 1}`;
}
