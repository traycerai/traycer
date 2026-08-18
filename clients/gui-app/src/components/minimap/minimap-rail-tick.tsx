import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

export type MinimapRailTickProps = Omit<
  ComponentPropsWithoutRef<"span">,
  "aria-hidden" | "children" | "className" | "style"
> & {
  readonly active: boolean;
  readonly availableWidth: number;
  readonly hierarchical: boolean;
  readonly level: 1 | 2;
  readonly open: boolean;
  readonly side: "left" | "right";
  readonly top: string;
};

/** The shared visual language for chat-turn and artifact-heading rails. */
export function MinimapRailTick({
  active,
  availableWidth,
  hierarchical,
  level,
  open,
  side,
  top,
  ...nativeProps
}: MinimapRailTickProps) {
  const safeWidth = Number.isFinite(availableWidth)
    ? Math.max(0, availableWidth)
    : 0;
  const emphasized = hierarchical && level === 1;

  return (
    <span
      {...nativeProps}
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute -translate-y-1/2 rounded-full transition-[background-color,height,opacity] duration-150",
        side === "left" ? "left-0" : "right-0",
        active ? "h-[3px] bg-foreground/90" : "h-0.5 bg-muted-foreground/35",
        emphasized ? "w-5" : "w-4",
        open ? "opacity-0" : "opacity-100",
      )}
      data-active={active ? "true" : "false"}
      data-level={level}
      data-minimap-rail-tick=""
      style={{
        maxWidth: safeWidth,
        top,
      }}
    />
  );
}
