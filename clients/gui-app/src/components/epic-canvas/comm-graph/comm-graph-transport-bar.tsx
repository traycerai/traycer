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

      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-pressed={transport.following}
        data-testid="comm-graph-transport-follow-live"
        data-following={transport.following ? "true" : "false"}
        onClick={transport.followLive}
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

  return (
    /*
      WITH NOTHING CAPTURED THERE IS NO SLIDER, not a slider that reports
      nonsense. An empty epic has no positions to be at, so declaring
      `min=0 max=0 valuenow=-1` would put a focusable control in the tab order
      that announces a value outside its own range and moves nowhere when
      driven. The empty track is inert scenery instead, matching the play
      button, which is already disabled.
    */
    <div
      ref={trackRef}
      role={hasEvents ? "slider" : undefined}
      tabIndex={hasEvents ? 0 : undefined}
      aria-label={hasEvents ? "Event timeline" : undefined}
      aria-disabled={hasEvents ? undefined : true}
      aria-valuemin={hasEvents ? 0 : undefined}
      aria-valuemax={hasEvents ? events.length - 1 : undefined}
      aria-valuenow={hasEvents ? transport.cursorIndex : undefined}
      aria-valuetext={hasEvents ? trackValueText(transport) : undefined}
      data-testid="comm-graph-transport-track"
      data-following={transport.following ? "true" : "false"}
      data-empty={hasEvents ? "false" : "true"}
      className={cn(
        "relative h-6 min-w-0 flex-1 rounded-sm bg-muted/40",
        hasEvents
          ? "cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          : "cursor-default opacity-60",
      )}
      onPointerDown={hasEvents ? handlePointerDown : undefined}
      onPointerMove={hasEvents ? handlePointerMove : undefined}
      onKeyDown={hasEvents ? handleKeyDown : undefined}
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
      {!hasEvents ? null : (
        <div
          aria-hidden
          data-testid="comm-graph-transport-playhead"
          className="absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-primary"
          style={{ left: `${playhead * 100}%` }}
        />
      )}
    </div>
  );
}

function trackValueText(transport: CommGraphTransport): string {
  if (transport.following) return "Live";
  return `Event ${transport.cursorIndex + 1}`;
}
