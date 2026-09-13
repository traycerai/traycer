import { useCallback, useRef, type ReactNode } from "react";
import { BrandMark } from "@/components/auth/cinematic-backdrop";
import {
  STATUS_ANIMATION_SMOOTH_CADENCE_MS,
  useStatusAnimation,
} from "@/lib/animation/status-animation-clock";
import { cn } from "@/lib/utils";
import "@/styles/auth-arrival.css";

/**
 * `hero` is the full-screen launch splash. `boot` is a header on the host boot
 * card - a small mark over a small wordmark, so the card's own heading and
 * progress stay what the eye lands on - and its mark carries a slow highlight
 * sweep for as long as the card is up (see {@link BootMarkShimmer}).
 *
 * The hero mark is white by construction: it only ever sits on the cinematic
 * dark backdrop. The boot mark sits on a themed card, so it takes the
 * foreground colour - a white mark on the light theme's white card is no mark
 * at all. The SVG's own `<mask>` keeps its white fill (white is "show" there),
 * which is why the rule targets the drawn paths and not every `<path>`.
 */
export function BrandEntrance(props: {
  readonly size: "hero" | "boot";
  readonly children: ReactNode;
}): ReactNode {
  const mark = (
    <BrandMark
      className={cn(
        "brand-entrance-mark h-auto",
        props.size === "hero"
          ? "w-[clamp(3.75rem,8vw,5.4rem)] drop-shadow-[0_1.5rem_2.5rem_rgba(0,0,0,0.42)]"
          : "w-[clamp(1.5rem,6vw,2.25rem)] text-foreground [&_g>path]:fill-current",
      )}
    />
  );
  return (
    <div
      className={cn(
        "flex flex-col items-center",
        props.size === "hero" ? "gap-[clamp(1.2rem,2.8vh,2rem)]" : "gap-1",
      )}
      data-testid="brand-entrance"
      data-size={props.size}
    >
      {props.size === "boot" ? <BootMarkShimmer>{mark}</BootMarkShimmer> : mark}
      {props.children}
    </div>
  );
}

/** One sweep and the pause after it; the band is in motion for the first {@link SWEEP_TRAVEL_MS}. */
const SWEEP_PERIOD_MS = 2800;
const SWEEP_TRAVEL_MS = 1300;

/**
 * A soft diagonal highlight crossing the boot card's mark, left to right,
 * every few seconds - so a card that can sit for minutes while a host installs
 * reads as waiting rather than stamped.
 *
 * GEOMETRY. The wrapper is masked (`.brand-entrance-mark-shimmer` in
 * auth-arrival.css) with a gradient three times its own width: the mark at a
 * slightly lowered alpha everywhere, rising to full alpha in a narrow band
 * around the gradient's centre. Sliding that mask's `mask-position` from 100%
 * to 0% carries the band across the box, and because a mask only ever
 * modulates the pixels already drawn, the highlight is clipped to the mark's
 * shape by construction - nothing spills onto the card. The mark is the only
 * child, so its wordmark sibling is untouched.
 *
 * THE CLOCK, not a CSS animation. This card is on screen from the first frame
 * of a launch until a host answers, which on a slow install is minutes, and an
 * always-on CSS animation is exactly the cost `status-animation-clock.ts`
 * exists to avoid. The sweep is written as one inline `mask-position` per
 * tick from the shared clock, the same mechanism as `WorkingShimmerText`'s
 * `background-position` - one style write on one element, no layout, and the
 * clock stops while the document is hidden.
 *
 * REDUCED MOTION. `useStatusAnimation` never subscribes and clears the inline
 * position, and the stylesheet's reduced-motion rule drops the mask entirely,
 * so the mark is simply the full-alpha static mark. Between sweeps, and before
 * the first write lands, the band is parked off the mark's right edge (the
 * stylesheet's own `mask-position`), so the resting mark is one flat alpha.
 */
function BootMarkShimmer(props: { readonly children: ReactNode }): ReactNode {
  const ref = useRef<HTMLSpanElement | null>(null);
  const write = useCallback((element: HTMLSpanElement, elapsedMs: number) => {
    const phase = elapsedMs % SWEEP_PERIOD_MS;
    const travel = Math.min(phase / SWEEP_TRAVEL_MS, 1);
    // Sinusoidal ease-in-out: the band enters and leaves the mark gently
    // rather than snapping in from the edge.
    const eased = 0.5 - 0.5 * Math.cos(Math.PI * travel);
    // 100% parks the band off the LEFT edge, 0% off the RIGHT; the pause is
    // spent at 0%, so the jump back to 100% at the next cycle moves nothing
    // visible.
    element.style.maskPosition = `${100 - eased * 100}% center`;
  }, []);
  const clear = useCallback((element: HTMLSpanElement) => {
    element.style.maskPosition = "";
  }, []);
  useStatusAnimation(ref, write, clear, STATUS_ANIMATION_SMOOTH_CADENCE_MS);
  return (
    <span
      ref={ref}
      data-testid="brand-entrance-mark-shimmer"
      className="brand-entrance-mark-shimmer"
    >
      {props.children}
    </span>
  );
}
