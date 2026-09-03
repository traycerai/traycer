import { useStatusAnimation } from "@/lib/animation/status-animation-clock";
import { cn } from "@/lib/utils";
import { memo, useCallback, useRef, type CSSProperties } from "react";

type ShimmerElement = "div" | "p" | "span";

type ShimmerStyle = CSSProperties & {
  "--spread": string;
};

export interface TextShimmerProps {
  children: string;
  as?: ShimmerElement;
  className?: string;
  duration?: number;
  spread?: number;
}

/**
 * Text with a highlight band sweeping across it while a step is live (a
 * streaming reasoning title, an active activity group). The band is the
 * element's own background clipped to the glyphs; the sweep is an inline
 * `background-position` written from the shared status animation clock - see
 * `status-animation-clock.ts` for why this is neither a CSS animation nor a
 * motion `animate` loop (both cost a main-thread style recalc per display
 * frame for as long as the step is live).
 */
const ShimmerComponent = (props: TextShimmerProps) => {
  const { children, className } = props;
  const duration = props.duration ?? 2;
  const spread = props.spread ?? 2;
  const ref = useRef<HTMLElement | null>(null);

  const write = useCallback(
    (element: HTMLElement, elapsedMs: number) => {
      const progress = (elapsedMs / (duration * 1000)) % 1;
      element.style.backgroundPosition = `${100 - progress * 100}% center`;
    },
    [duration],
  );
  useStatusAnimation(ref, write);

  // A callback ref rather than the ref object itself: the tag is a union of
  // intrinsic elements, and a `RefObject<HTMLElement>` is not assignable to
  // any one of their `ref` props while a callback taking `HTMLElement` is.
  const attachRef = useCallback((element: HTMLElement | null) => {
    ref.current = element;
  }, []);

  const style: ShimmerStyle = {
    "--spread": `${children.length * spread}px`,
    backgroundImage:
      "var(--bg), linear-gradient(var(--shimmer-text-color, var(--color-muted-foreground)), var(--shimmer-text-color, var(--color-muted-foreground)))",
    backgroundPosition: "100% center",
  };
  const Tag = props.as ?? "p";
  return (
    <Tag
      ref={attachRef}
      className={cn(
        "relative inline-block bg-size-[250%_100%,auto] bg-clip-text text-transparent",
        "[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]",
        className,
      )}
      style={style}
    >
      {children}
    </Tag>
  );
};

export const Shimmer = memo(ShimmerComponent);
