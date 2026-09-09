import { useEffect, useState, type CSSProperties } from "react";
import { MousePointer2 } from "lucide-react";
import type {
  AgentCursorPosition,
  ScreencastFrameSize,
} from "@/lib/browser-view/sessions/screencast-input-encoding";
import { containBox } from "@/components/epic-canvas/renderers/agent-cursor-contain-box";
import { cn } from "@/lib/utils";

/** How long the cursor lingers after the agent's last pointer event. */
const AGENT_CURSOR_LINGER_MS = 2_000;

/**
 * The agent's pointer, drawn over the screencast surface.
 *
 * Plane-agnostic on purpose: the host sends coordinates normalized to the
 * geometry the viewer is looking at, and both surfaces (`<img>` and `<video>`)
 * are `object-contain` inside this same box, so one `frameSize` serves JPEG and
 * video alike. The contain-fit is CSS rather than a measurement: the inner box
 * is the painted rectangle (container-query units clamp it on whichever axis
 * runs out first, `margin: auto` centres it), so a normalized coordinate is
 * just a percentage inside it and a tile resize needs no code at all.
 *
 * Purely decorative - `pointer-events: none`, no arm/epoch involvement, and it
 * dies with whichever subscription feeds it: the tile's own for a tile, PiP's
 * own for the PiP mirror, which mounts this too.
 */
export function AgentCursorOverlay(props: {
  readonly cursor: AgentCursorPosition | null;
  readonly frameSize: ScreencastFrameSize | null;
}) {
  const { cursor, frameSize } = props;
  const [pressedId, setPressedId] = useState<number | null>(null);

  // Adjusted during render (React's documented way to derive state from a
  // changing prop) rather than in an Effect: a press must not flash one frame
  // without its ripple.
  //
  // No cursor clears the latch, because cursor ids are per-SELECTION counters
  // that restart at 1: PiP mounts this overlay once and keeps it across tab
  // switches, so a retained `pressedId` of 1 would suppress the very first
  // press of the next tab.
  if (cursor === null) {
    if (pressedId !== null) setPressedId(null);
  } else if (cursor.type === "down" && pressedId !== cursor.id) {
    setPressedId(cursor.id);
  }

  const point: CSSProperties =
    cursor === null
      ? {}
      : {
          left: `${(cursor.normalizedX * 100).toString()}%`,
          top: `${(cursor.normalizedY * 100).toString()}%`,
        };
  return (
    <div
      data-testid="browser-agent-cursor-overlay"
      className="pointer-events-none absolute inset-0 overflow-hidden [container-type:size]"
    >
      {cursor === null || frameSize === null ? null : (
        <div className="absolute inset-0 m-auto" style={containBox(frameSize)}>
          {pressedId === null ? null : (
            <span
              key={pressedId}
              data-testid="browser-agent-cursor-ripple"
              className="agent-cursor-ripple absolute size-8 rounded-full border-2 border-primary"
              style={point}
            />
          )}
          <AgentCursorMarker
            key={cursor.id}
            label={cursor.label}
            style={point}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Remounted per cursor id by its `key`, which is what restarts the linger: the
 * cursor fades only once the agent has stopped pointing for
 * {@link AGENT_CURSOR_LINGER_MS}, and every new frame is a fresh mount with a
 * fresh timer.
 */
function AgentCursorMarker(props: {
  readonly label: string;
  readonly style: CSSProperties;
}) {
  const [lingered, setLingered] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setLingered(true);
    }, AGENT_CURSOR_LINGER_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, []);
  return (
    <div
      data-testid="browser-agent-cursor"
      data-visible={!lingered}
      style={props.style}
      className={cn(
        "absolute flex items-center gap-1 transition-opacity duration-300 motion-reduce:transition-none",
        lingered ? "opacity-0" : "opacity-100",
      )}
    >
      <MousePointer2
        aria-hidden
        className="size-4 shrink-0 fill-primary text-primary drop-shadow-sm"
      />
      <span className="max-w-[24ch] truncate rounded-sm bg-primary px-1.5 py-0.5 text-ui-xs text-primary-foreground shadow-sm">
        {props.label}
      </span>
    </div>
  );
}
