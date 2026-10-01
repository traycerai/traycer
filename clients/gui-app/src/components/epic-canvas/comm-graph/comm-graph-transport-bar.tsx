/**
 * The media-player transport docked under the graph: play/pause, speed, and a
 * scrubber whose track carries one marker per captured event.
 *
 * IT OWNS THE CURSOR, and it is the only thing that does. The sidebar panel that
 * used to own playback is gone; the per-epic cursor store survived it, so the
 * graph still remembers where it was left when the tile is closed and reopened.
 *
 * THE TRACK IS THE LOG. Markers are the events themselves, one per row - not
 * buckets, not a sample. Crowding IS the information: a burst of traffic should
 * look like a burst, which is also why the axis they sit on measures REPLAY
 * time rather than wall time (see `comm-graph-transport.ts`): an idle hour that
 * playback crosses in one step no longer takes half the bar away from the
 * exchanges either side of it.
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
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
  commGraphMarkerIndexNearFraction,
  commGraphPlayheadFraction,
  commGraphTransportMarkers,
  commGraphTransportTrack,
  type CommGraphTransportMarker,
} from "@/lib/comm-graph/comm-graph-transport";
import {
  useCommGraphTransport,
  type CommGraphTransport,
} from "@/components/epic-canvas/comm-graph/use-comm-graph-transport";

const MARKER_PREVIEW_MAX_CHARS = 120;

/**
 * How far from a tick the pointer may be and still be on it, in pixels. A tick
 * is one pixel wide, which nobody can hold a pointer on; this is the reach the
 * per-tick tooltips never had, and it is small enough that the gap between two
 * separate ticks still reads as a gap.
 */
const MARKER_HOVER_REACH_PX = 4;

/**
 * How long the pointer rests on the track before the first label appears. The
 * app's own tooltip delay (`TooltipProvider`'s default), spelled again here
 * because the label below is opened by the track and not by Radix's hover, so
 * nothing else would apply it. Paid once per visit to the track: after it, the
 * label follows the pointer from tick to tick with no further wait, which is
 * what Radix's skip-delay gave the per-tick tooltips.
 */
const MARKER_HOVER_DELAY_MS = 500;

/**
 * Marker titles, by the row they describe.
 *
 * A title is a markdown parse and a single-line format. It is built when a
 * tick is first HOVERED and never before: the track draws one tick per row, so
 * building titles at render parsed every message in the epic to label ticks
 * nobody had pointed at. The text is a pure function of a row and a row never
 * changes, so it is kept for as long as the row is reachable, and a tick
 * hovered twice is parsed once. A `WeakMap` rather than a bounded cache because
 * the key IS the lifetime: rows the log has dropped take their titles with
 * them.
 */
const markerTitles = new WeakMap<CommGraphEvent, string>();

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
  const cached = markerTitles.get(event);
  if (cached !== undefined) return cached;
  const title = buildMarkerTitle(event);
  markerTitles.set(event, title);
  return title;
}

function buildMarkerTitle(event: CommGraphEvent): string {
  const when = cursorTimeText(event.timestamp);
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

  // ONE MEMO FOR BOTH, from the same array: the markers index into the track's
  // own offsets, so a track built from a different log than the markers were
  // would place them by somebody else's arithmetic.
  const track = useMemo(() => commGraphTransportTrack(events), [events]);
  const markers = useMemo(
    () => (track === null ? [] : commGraphTransportMarkers(events, track)),
    [events, track],
  );
  const playhead = commGraphPlayheadFraction(events, transport.cursor, track);

  const seekToFraction = useCallback(
    (fraction: number) => {
      if (track === null) return;
      const event = commGraphEventAtFraction(events, track, fraction);
      if (event === null) return;
      transport.seekToEvent(event);
    },
    [events, track, transport],
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

      <CommGraphCursorTime transport={transport} events={events} />

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

interface CommGraphTransportTrackProps {
  readonly transport: CommGraphTransport;
  readonly events: ReadonlyArray<CommGraphEvent>;
  readonly markers: ReadonlyArray<CommGraphTransportMarker>;
  readonly playhead: number;
  readonly onSeekToFraction: (fraction: number) => void;
}

/**
 * The scrubber itself. Split out so the bar stays a layout shell and the track's
 * one real subtlety - what it means when there is nothing to scrub - lives in
 * one place.
 *
 * THE TWO TRACKS ARE TWO COMPONENTS, so that everything the scrubbing track
 * holds - the pointer it is hovering, the delay it has paid, the timer paying
 * it - is dropped with it. The log can empty while a label is armed (a
 * frontier can prune every row), and the empty track has no pointer handlers
 * to notice the pointer leaving. Held above the split, that state would
 * survive the empty interval and open a label the moment a row came back,
 * wherever the pointer had gone meanwhile.
 */
function CommGraphTransportTrack(props: CommGraphTransportTrackProps) {
  if (props.events.length === 0)
    return <CommGraphEmptyTrack following={props.transport.following} />;
  return <CommGraphScrubTrack {...props} />;
}

function CommGraphScrubTrack(props: CommGraphTransportTrackProps) {
  const { events, markers, onSeekToFraction, playhead, transport } = props;
  const trackRef = useRef<HTMLDivElement | null>(null);

  // THE HOVER IS WHERE THE POINTER IS, not which tick it was on. Rows landing
  // while history arrives rescale every tick, so a tick chosen at the last
  // pointer move can drift away from a pointer that has not moved, and a row
  // can be pruned outright. The tick under the pointer is therefore resolved
  // against the CURRENT markers on every render, from the pointer's last
  // position, and a tick that has drifted out of reach shows nothing.
  const [hoverPointer, setHoverPointer] = useState<PointerOnTrack | null>(null);
  const [hoverArmed, setHoverArmed] = useState(false);
  const hoverDelayRef = useRef<number | null>(null);

  const cancelHoverDelay = useCallback(() => {
    if (hoverDelayRef.current === null) return;
    window.clearTimeout(hoverDelayRef.current);
    hoverDelayRef.current = null;
  }, []);

  useEffect(() => cancelHoverDelay, [cancelHoverDelay]);

  const pointerOnTrack = useCallback(
    (clientX: number): PointerOnTrack | null => {
      const track = trackRef.current;
      if (track === null) return null;
      return measurePointerOnTrack(track, clientX);
    },
    [],
  );

  // A RESIZE MOVES THE TICKS UNDER A STILL POINTER. The fraction a hover was
  // stored at was measured against the track as it was at the last pointer
  // event; a window, sidebar or split resize changes the track's width, and
  // the same screen position is then a different place along it. So the
  // stored screen position is re-measured against the new rect whenever the
  // track resizes. The epic canvas is tiled and does not pan, so resizing is
  // the only way the track moves while the pointer rests on it; a move that
  // takes the track out from under the pointer altogether reaches the track
  // as `pointerleave`.
  useEffect(() => {
    const track = trackRef.current;
    if (track === null) return;
    const observer = new ResizeObserver(() => {
      setHoverPointer((current) =>
        current === null ? null : measurePointerOnTrack(track, current.clientX),
      );
    });
    observer.observe(track);
    return () => observer.disconnect();
  }, []);

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const pointer = pointerOnTrack(event.clientX);
      if (pointer === null) return;
      // Capture so a drag that leaves the track keeps scrubbing instead of
      // stopping wherever the pointer crossed the edge.
      event.currentTarget.setPointerCapture(event.pointerId);
      // A drag carries no label. It never did: with the pointer captured the
      // ticks stopped receiving it, so none of their tooltips could open.
      setHoverPointer(null);
      onSeekToFraction(pointer.fraction);
    },
    [onSeekToFraction, pointerOnTrack],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const pointer = pointerOnTrack(event.clientX);
      if (pointer === null) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        onSeekToFraction(pointer.fraction);
        return;
      }
      // Armed from a move as well as from entering, because a track that
      // mounts under a resting pointer is never entered.
      if (!hoverArmed && hoverDelayRef.current === null) {
        hoverDelayRef.current = window.setTimeout(() => {
          hoverDelayRef.current = null;
          setHoverArmed(true);
        }, MARKER_HOVER_DELAY_MS);
      }
      // A render per move while the pointer is over the track, and a cheap
      // one: the tick layer below is memoized on `markers`, which a move does
      // not change, and the label is keyed so the same tick is not remounted.
      setHoverPointer(pointer);
    },
    [hoverArmed, onSeekToFraction, pointerOnTrack],
  );

  // `pointerleave` alone is not enough: it is not delivered while the track
  // holds the pointer, so a drag that ends outside the track would leave the
  // hover set. Releasing clears the tick and keeps the delay paid - the
  // pointer has not left.
  const clearHoveredMarker = useCallback(() => {
    setHoverPointer(null);
  }, []);

  const handlePointerLeave = useCallback(() => {
    cancelHoverDelay();
    setHoverArmed(false);
    setHoverPointer(null);
  }, [cancelHoverDelay]);

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

  const hoveredMarker = hoverArmed
    ? markerUnderPointer(markers, hoverPointer)
    : null;

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
      onPointerUp={clearHoveredMarker}
      onLostPointerCapture={clearHoveredMarker}
      onPointerLeave={handlePointerLeave}
      onKeyDown={handleKeyDown}
    >
      {/* Elapsed fill: everything the graph is currently showing. */}
      <div
        aria-hidden
        data-testid="comm-graph-transport-elapsed"
        className="absolute inset-y-0 left-0 rounded-sm bg-primary/10"
        style={{ width: `${playhead * 100}%` }}
      />
      <CommGraphTransportMarkerLayer markers={markers} />
      <div
        aria-hidden
        data-testid="comm-graph-transport-playhead"
        className="absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-primary"
        style={{ left: `${playhead * 100}%` }}
      />
      {/*
        KEYED BY THE ROW AND WHERE IT IS DRAWN, so that anything which moves
        the label's anchor is a remount and not a move. Radix places a label
        against its anchor when it mounts and then watches the anchor for
        movement - and that watcher gives up on an anchor with no size, which
        this one is. One persistent anchor sliding along the track would leave
        its label over the first tick hovered; one keyed by the row alone
        would leave it behind when rows land and the hovered tick rescales.
      */}
      {hoveredMarker === null ? null : (
        <CommGraphMarkerHover
          key={`${hoveredMarker.key}@${hoveredMarker.fraction}`}
          marker={hoveredMarker}
        />
      )}
    </div>
  );
}

interface PointerOnTrack {
  /** The pointer's viewport x, kept so a resized track can re-measure it. */
  readonly clientX: number;
  /** Where along the track the pointer is; outside 0..1 when it is past an end. */
  readonly fraction: number;
  /** The track's laid-out width in pixels, to turn a reach in pixels into a fraction. */
  readonly width: number;
}

/**
 * Where a viewport x falls along the track as it is laid out now.
 *
 * `null` for a track with no width: jsdom (and a track that has not been laid
 * out yet) reports zero, and dividing by it would seek to NaN, so a pointer
 * seek simply does not happen until there is a real track to seek along.
 */
function measurePointerOnTrack(
  track: HTMLElement,
  clientX: number,
): PointerOnTrack | null {
  const rect = track.getBoundingClientRect();
  if (rect.width <= 0) return null;
  return {
    clientX,
    fraction: (clientX - rect.left) / rect.width,
    width: rect.width,
  };
}

/** The tick within reach of the pointer, among the ticks drawn now. */
function markerUnderPointer(
  markers: ReadonlyArray<CommGraphTransportMarker>,
  pointer: PointerOnTrack | null,
): CommGraphTransportMarker | null {
  if (pointer === null) return null;
  const index = commGraphMarkerIndexNearFraction(
    markers,
    pointer.fraction,
    MARKER_HOVER_REACH_PX / pointer.width,
  );
  return index === null ? null : markers[index];
}

/**
 * THE ONE LABEL THE TRACK HAS.
 *
 * Every tick used to carry its own Radix tooltip. This is the only one now,
 * and it exists only while a tick is hovered: an invisible anchor on the
 * hovered tick's spot, with a label that is simply open. The track decides
 * when (see `MARKER_HOVER_DELAY_MS`) and which tick; Radix only places it.
 *
 * NO ENTRY ANIMATION, on purpose. A label opened this way mounts as
 * `instant-open`, which the tooltip's entry classes do not match. For a label
 * that follows the pointer from tick to tick that is the right reading: it
 * moves, it does not keep arriving.
 *
 * This is also the only place a title is built - see `markerTitles`.
 */
function CommGraphMarkerHover(props: {
  readonly marker: CommGraphTransportMarker;
}) {
  const { marker } = props;
  return (
    <TooltipWrapper
      open
      label={markerTitle(marker.event)}
      side="top"
      sideOffset={4}
      align="center"
    >
      <span
        aria-hidden
        data-testid="comm-graph-transport-marker-hover"
        data-marker-key={marker.key}
        className="pointer-events-none absolute inset-y-0 w-0"
        style={{ left: `${marker.fraction * 100}%` }}
      />
    </TooltipWrapper>
  );
}

/**
 * THE TICKS, AND NOTHING ELSE.
 *
 * ONE BARE ELEMENT PER ROW. Each tick used to be wrapped in its own Radix
 * tooltip, which is about ten components and a click handler per tick - and a
 * row landing moves every tick, because the track it is a fraction of just
 * grew. So while an epic's history was still arriving, every row that landed
 * reconciled a tooltip for every row already there: a few thousand rows became
 * a few hundred thousand component instances, the main thread stopped
 * answering, and the heap grew by gigabytes faster than it could be collected.
 * A tick is now the one element that is actually drawn, and the label is the
 * track's business - see `CommGraphMarkerHover`.
 *
 * `pointer-events-none` so that a tick is never what the pointer is over: the
 * track resolves the hovered tick from the pointer's position, and nothing
 * drawn inside it should take part in hit-testing.
 *
 * Split out and memoized because the track around it re-renders on every step
 * of playback - the playhead and the elapsed fill are what a step MOVES - and
 * on every change of hover, and the ticks are not among the things that moved.
 * `markers` comes from one memo over `events`, so this re-renders exactly when
 * rows land - which is also the only time a fraction can change.
 */
const CommGraphTransportMarkerLayer = memo(
  function CommGraphTransportMarkerLayer(props: {
    readonly markers: ReadonlyArray<CommGraphTransportMarker>;
  }) {
    return (
      <>
        {props.markers.map((marker) => (
          <span
            key={marker.key}
            aria-hidden
            data-testid={`comm-graph-transport-marker-${marker.key}`}
            data-kind={marker.event.kind}
            className={cn(
              "pointer-events-none absolute top-1 bottom-1 w-px -translate-x-1/2",
              marker.event.kind === "a2a_notice"
                ? "bg-warning/70"
                : "bg-foreground/25",
            )}
            style={{ left: `${marker.fraction * 100}%` }}
          />
        ))}
      </>
    );
  },
);

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
 * WHICH MOMENT A DETACHED GRAPH IS SHOWING.
 *
 * It used to be a chip over the office floor - `Paused at 14:32:07` in the
 * top-left corner, the last read-only sentence drawn over the drawing, and
 * removed with the rest of them in feedback round 2 ("no more hidden labels or
 * anything left now, right?").
 *
 * The reading itself is worth keeping, because nothing else says it: a floor
 * scrubbed back to an hour ago is pixel-identical to a live one, and the
 * playhead gives a position without a time. So it moved to the scrubber, where
 * a media player puts it and where it costs a canvas nothing - the same value
 * the chip read (`cursor.timestamp`), in the bar that owns the cursor.
 *
 * NO "PAUSED AT" / "REPLAYING" PREFIX any more. The chip carried one because it
 * stood alone over a floor; here it sits a few pixels from the play/pause
 * button, which is already showing which of the two this is.
 *
 * NOTHING WHILE LIVE - not the current time, which would be a clock, and not a
 * dash holding the space. Live has no cursor to report, and the Live badge
 * beside it says so.
 *
 * BUT IT HOLDS ITS FOOTPRINT WHILE LIVE, which is a different question and one
 * the chip never had to answer. This sits in the bar's flex row beside a track
 * that is `flex-1 min-w-0`, so a readout that mounts on the first seek TAKES
 * ITS WIDTH OUT OF THE TRACK - and the first seek is a pointer-down ON that
 * track. The playhead would land some seventy pixels left of the finger that
 * placed it, every marker would slide with it, and the next `pointermove`
 * would measure a narrower rect and resolve the same screen position to a
 * different row. So the width is reserved by an invisible time and the reading
 * is laid over it: the footprint is a CONSTANT, and nothing moves when a
 * cursor appears.
 *
 * AND THE RESERVATION IS EXACT, because the clock it reserves for cannot vary
 * in width. Two earlier attempts reserved a MEASURED width - the newest row's
 * time, then the longest of twenty-four hourly probes - and both were
 * approximations dressed as guarantees: a locale's `9:05:09 AM` is a character
 * shorter than its `12:05:09 PM`, and once that was handled by character
 * count, `AM` and `PM` are still two different widths in a proportional face
 * at the same length. A reservation you have to measure is one that is wrong
 * somewhere you did not probe. {@link TRANSPORT_TIME_FORMAT} removes the
 * variance instead of chasing it - see there.
 */
function CommGraphCursorTime(props: {
  readonly transport: CommGraphTransport;
  readonly events: ReadonlyArray<CommGraphEvent>;
}) {
  const { events, transport } = props;
  // Nothing captured: no reading to hold room for, and the Live badge beside
  // this is hidden for the same reason.
  if (events.length === 0) return null;
  const cursor = transport.cursor;
  return (
    <span
      // `shrink-0` against a track that is `flex-1 min-w-0`: the readout is a
      // fixed handful of digits and the track is what should give up width.
      className="relative shrink-0 text-ui-xs text-muted-foreground tabular-nums"
    >
      <span
        aria-hidden
        data-testid="comm-graph-transport-cursor-time-reserve"
        className="invisible"
      >
        {RESERVED_TIME_TEXT}
      </span>
      {cursor === null ? null : (
        <span
          data-testid="comm-graph-transport-cursor-time"
          className="absolute inset-0 whitespace-nowrap"
        >
          {cursorTimeText(cursor.timestamp)}
        </span>
      )}
    </span>
  );
}

/**
 * THE BAR'S CLOCK, in a shape whose rendered width is the same at every
 * instant - which is what lets the readout above reserve its room exactly
 * rather than approximately.
 *
 * Every field is two digits and the hour cycle is `h23`, so the output is
 * digits and separators and NOTHING ELSE: no day period, so no `AM` against
 * `PM`; no one-digit hour against a two-digit one. `tabular-nums` on the
 * element gives every digit the same advance, and a locale's separators do not
 * change with the time, so the string is the same width whenever it is read.
 * `comm-graph-transport-bar-cost.test.ts` pins both halves of that - one
 * length across the whole day, and not a letter in it.
 *
 * The locale still chooses the separators and the field order; what is fixed
 * is the SHAPE. A 12-hour locale reads 14:32:07 here rather than 2:32:07 PM,
 * which is the price of the guarantee and a fair one under a scrubber, where
 * the neighbouring speed is `tabular-nums` for the same reason.
 *
 * ONE formatter for the readout and the marker labels alike - two clocks in
 * one bar disagreeing about how to write an instant is its own defect, and
 * constructing an `Intl.DateTimeFormat` is expensive enough to hoist out of a
 * function the readout calls on every step.
 */
const TRANSPORT_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** One spelling of an instant, so the reading and its reserved box agree. */
function cursorTimeText(timestamp: number): string {
  return TRANSPORT_TIME_FORMAT.format(timestamp);
}

/**
 * Any instant at all, because they are all the same width - see
 * {@link TRANSPORT_TIME_FORMAT}. Held as a constant rather than formatted per
 * render: this is read on every tick of playback.
 */
const RESERVED_TIME_TEXT = cursorTimeText(0);

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
      variant="muted"
      aria-pressed={transport.following}
      data-testid="comm-graph-transport-follow-live"
      data-following={transport.following ? "true" : "false"}
      data-can-return={canReturn ? "true" : "false"}
      onClick={canReturn ? transport.returnToReplay : transport.followLive}
      className="shrink-0"
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
