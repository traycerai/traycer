import { cn } from "@/lib/utils";
import * as m from "motion/react-m";
import type { CSSProperties } from "react";
import { memo } from "react";

type ShimmerElement = "div" | "p" | "span";

type ShimmerStyle = CSSProperties & {
  "--spread": string;
};

const MOTION_COMPONENT_BY_ELEMENT = {
  div: m.div,
  p: m.p,
  span: m.span,
};

export interface TextShimmerProps {
  children: string;
  as?: ShimmerElement;
  className?: string;
  duration?: number;
  spread?: number;
}

const ShimmerComponent = (props: TextShimmerProps) => {
  const { children, className } = props;
  const duration = props.duration ?? 2;
  const spread = props.spread ?? 2;
  const MotionComponent = MOTION_COMPONENT_BY_ELEMENT[props.as ?? "p"];

  const style: ShimmerStyle = {
    "--spread": `${children.length * spread}px`,
    backgroundImage:
      "var(--bg), linear-gradient(var(--shimmer-text-color, var(--color-muted-foreground)), var(--shimmer-text-color, var(--color-muted-foreground)))",
  };

  return (
    <MotionComponent
      animate={{ backgroundPosition: "0% center" }}
      className={cn(
        "relative inline-block bg-size-[250%_100%,auto] bg-clip-text text-transparent",
        "[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]",
        className,
      )}
      initial={{ backgroundPosition: "100% center" }}
      style={style}
      transition={{
        duration,
        ease: "linear",
        repeat: Number.POSITIVE_INFINITY,
      }}
    >
      {children}
    </MotionComponent>
  );
};

export const Shimmer = memo(ShimmerComponent);
