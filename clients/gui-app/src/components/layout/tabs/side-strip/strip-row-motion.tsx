import { Component, type ReactNode } from "react";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import { cssEscape } from "@/lib/dom/css-escape";
import {
  SIDE_STRIP_ARRIVAL_GLOW_MS,
  SIDE_STRIP_SLIDE_EASING,
  SIDE_STRIP_SLIDE_MS,
} from "./side-strip-tokens";
import type { StripSection } from "./strip-sections";

/**
 * A neutral ring and tint over the row, which the animation lets go of: the
 * first keyframe, so the row's own style is where it ends. (A lone keyframe
 * with no offset is the last one, and would fade the glow in instead.)
 */
const ARRIVAL_GLOW: Keyframe = {
  offset: 0,
  boxShadow:
    "inset 0 0 0 1px color-mix(in srgb, var(--color-foreground) 40%, transparent)",
  backgroundColor:
    "color-mix(in srgb, var(--color-foreground) 12%, transparent)",
};

interface StripRowMotionProps {
  /** The Activity view's scroller, which holds the rows' frames. */
  readonly scroller: HTMLElement | null;
  /** Each task item's section as drawn, by the item's id. */
  readonly placements: ReadonlyMap<string, StripSection>;
  /** Whether a row may slide. The glow does not depend on it. */
  readonly slide: boolean;
  readonly children: ReactNode;
}

/** Each moved item's top edge on screen, before the commit. */
type FrameTops = ReadonlyMap<string, number>;

/** The items drawn in a different section than they were. */
function movedIdsOf(
  before: ReadonlyMap<string, StripSection>,
  after: ReadonlyMap<string, StripSection>,
): ReadonlyArray<string> {
  return [...after.keys()].filter((id) => {
    const was = before.get(id);
    return was !== undefined && was !== after.get(id);
  });
}

function frameOf(scroller: HTMLElement, itemId: string): HTMLElement | null {
  return scroller.querySelector<HTMLElement>(
    `[data-strip-item-id="${cssEscape(itemId)}"]`,
  );
}

/**
 * Marks a row that changed section: it slides from where it was to where it is
 * (200ms, a transform only, measured before and after the commit) and glows
 * once. Reduced motion and the app's switch take the slide away and leave the
 * glow, which is a fade and not a movement.
 *
 * A class because `getSnapshotBeforeUpdate` is the one place React reads the
 * DOM before a commit changes it, and a row's old place is gone after that:
 * the section change remounts the row under its new header, and the rows above
 * it may have moved in the same commit. Nothing is measured on a commit that
 * moves no row.
 */
export class StripRowMotion extends Component<
  StripRowMotionProps,
  unknown,
  FrameTops
> {
  /** What is still playing, cancelled if the list goes away mid-move. */
  private readonly playing = new Set<Animation>();

  private play(animation: Animation): void {
    this.playing.add(animation);
    animation.addEventListener("finish", () => {
      this.playing.delete(animation);
    });
  }

  override componentWillUnmount(): void {
    for (const animation of this.playing) animation.cancel();
    this.playing.clear();
  }

  override getSnapshotBeforeUpdate(prev: StripRowMotionProps): FrameTops {
    const { scroller, placements } = this.props;
    const tops = new Map<string, number>();
    if (scroller === null) return tops;
    for (const id of movedIdsOf(prev.placements, placements)) {
      const frame = frameOf(scroller, id);
      if (frame !== null) tops.set(id, frame.getBoundingClientRect().top);
    }
    return tops;
  }

  override componentDidUpdate(
    prev: StripRowMotionProps,
    _state: unknown,
    tops: FrameTops | undefined,
  ): void {
    const { scroller, placements, slide } = this.props;
    if (scroller === null) return;
    // A drag moves the frames itself; the slide would fight its transforms.
    const dragging = useEpicDndStore.getState().activeHeaderTab !== null;
    for (const id of movedIdsOf(prev.placements, placements)) {
      const frame = frameOf(scroller, id);
      if (frame === null || !("animate" in frame)) continue;
      const from = tops?.get(id);
      if (slide && !dragging && from !== undefined) {
        const distance = from - frame.getBoundingClientRect().top;
        if (distance !== 0) {
          this.play(
            frame.animate(
              { transform: [`translateY(${distance}px)`, "translateY(0)"] },
              {
                duration: SIDE_STRIP_SLIDE_MS,
                easing: SIDE_STRIP_SLIDE_EASING,
              },
            ),
          );
        }
      }
      for (const row of frame.querySelectorAll("[data-side-tab]")) {
        this.play(
          row.animate([ARRIVAL_GLOW], {
            duration: SIDE_STRIP_ARRIVAL_GLOW_MS,
            easing: "ease-out",
          }),
        );
      }
    }
  }

  override render(): ReactNode {
    return this.props.children;
  }
}
