import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

/**
 * The host's row around a depiction, and the only React component in the
 * depiction layer.
 *
 * Its own file because the rest of that layer exports functions rather than
 * components, and a module holding both loses fast refresh - the same split
 * `providers/layout-override-provider.tsx` makes for the same reason.
 */

/**
 * Which real surface a region lives in.
 *
 * A depiction is wrapped in its host's typography, gap and height, so the same
 * markup lands at the same size wherever it is drawn - the specimen stage, an
 * example row and the canvas all read as one thing. Without it a status-bar
 * segment drawn inside a form would inherit the form's type scale and stop
 * being a picture of the strip.
 */
export type HostContextId =
  | "top-bar"
  | "status-bar"
  | "toolbar"
  | "composer-foot"
  | "dock"
  | "chip-strip"
  | "rail"
  | "chat";

/**
 * Each host's own row, copied from the surface named beside it rather than
 * approximated - these are the numbers the parity regression compares (L-53).
 *
 * What is copied is how the surface PAINTS and SPACES what it holds: its fill,
 * border, radius, gap, alignment, height and type scale. What is not is where
 * the surface sits in its own page - the margins and paddings that tuck it
 * under a neighbour - because a picture has no neighbour to tuck under.
 * `region-depiction-frame-parity.test.tsx` renders the real surface beside the
 * frame and holds the first half of that split; it is the only thing that
 * keeps these strings honest as the surfaces move (Risk 3).
 *
 * A surface that carries no type scale of its own gets none here either: since
 * C1 and C2 every composer control is a chip with its own `text-ui-xs`, so a
 * scale invented here would be drift in the one direction a subset check
 * cannot see.
 */
const HOST_CONTEXT_CLASS: Readonly<Record<HostContextId, string>> = {
  // `layout/tabs/tab-strip.tsx`: tabs stand on the strip's baseline, with no
  // gap and no scale of the strip's own - a tab carries `headerTabClassName`.
  "top-bar": "flex items-end",
  // `layout/status-bar/app-status-bar.tsx`: the strip's one row.
  "status-bar": "flex h-6 items-center gap-2 text-ui-xs tabular-nums",
  // `home/toolbar/composer-toolbar-left.tsx`, which the right cluster shares.
  toolbar: "flex items-center gap-1",
  // `home/composer/composer-workspace-mode-row.tsx`: the composer's lower row,
  // where the workspace label and the context chip sit.
  "composer-foot": "flex items-center gap-2",
  // `chat/chat-lower-dock.tsx`'s joined frame (L-97): one bordered surface
  // tucked under the composer, filled with the same `bg-foreground/3` the
  // composer itself carries. `border-b-0` travels with it, because the frame's
  // bottom edge IS the composer's top edge; what stays behind is the tuck
  // itself (`mx-3`, `-mb-px`), which needs a composer below to mean anything.
  dock: "flex w-full flex-col items-stretch rounded-t-lg border border-b-0 border-border bg-foreground/3",
  // `chat/chat-dock-compact-strip.tsx`: the pills share one row above the
  // composer. The strip wraps onto a second line and a picture never does, so
  // `flex-wrap` is deliberately not copied - see `CLIP_FADE`.
  "chip-strip": "flex items-center gap-1.5",
  // `epic-canvas/sidebar/epic-sidebar-rail.tsx`, vertical orientation.
  rail: "flex w-12 flex-col items-center gap-1 py-2",
  // The transcript edge the minimap's ticks are positioned against.
  chat: "relative flex h-16 items-stretch",
};

/**
 * One line, never wrapped, never scaled.
 *
 * A picture that outgrows the box it is in is CLIPPED with a soft right-edge
 * fade (L-45), because both alternatives lie: wrapping invents a second row
 * the real surface does not have, and scaling shows a size nothing on screen
 * is drawn at. The fade rides a data attribute rather than always being on,
 * because a row that fits - a full-width dock row, whose right edge IS the
 * frame's - would otherwise fade content nothing was hiding.
 *
 * Finish the fade before the clipping edge: the transparent final 8px keep
 * even a partial trailing glyph from meeting the hard boundary.
 */
const CLIP_FADE =
  "data-[clipped=true]:[-webkit-mask-image:linear-gradient(to_right,black_calc(100%-48px),transparent_calc(100%-8px))] data-[clipped=true]:[mask-image:linear-gradient(to_right,black_calc(100%-48px),transparent_calc(100%-8px))]";

export function HostContextFrame(props: {
  readonly host: HostContextId;
  readonly children: ReactNode;
}): ReactNode {
  const frameRef = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);

  const measure = useCallback(() => {
    const frame = frameRef.current;
    if (frame === null) return;
    setClipped(frame.scrollWidth > frame.clientWidth + 1);
  }, []);

  useEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return;
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [measure]);

  // The box is not the only thing that moves: a longer reading at the same
  // width overflows a frame that never resized, so the two numbers are re-read
  // whenever the CONTENT changes. Keyed on the children rather than run on
  // every render (G1-21): the presets block alone mounts ~30 of these, and an
  // unkeyed effect made every filter keystroke a synchronous layout read per
  // frame while none of their content had moved.
  useEffect(measure, [measure, props.children]);

  return (
    <div
      ref={frameRef}
      data-layout-depiction={props.host}
      data-clipped={clipped ? "true" : "false"}
      className={cn(
        "min-w-0 max-w-full flex-nowrap overflow-hidden",
        HOST_CONTEXT_CLASS[props.host],
        CLIP_FADE,
      )}
    >
      {props.children}
    </div>
  );
}
