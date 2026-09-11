import type { ReactNode } from "react";
import { BrandMark } from "@/components/auth/cinematic-backdrop";
import { cn } from "@/lib/utils";
import "@/styles/auth-arrival.css";

/**
 * `hero` is the full-screen launch splash. `boot` is a header on the host boot
 * card - a small mark over a small wordmark, so the card's own heading and
 * progress stay what the eye lands on.
 */
export function BrandEntrance(props: {
  readonly size: "hero" | "boot";
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div
      className={cn(
        "flex flex-col items-center",
        props.size === "hero" ? "gap-[clamp(1.2rem,2.8vh,2rem)]" : "gap-1",
      )}
      data-testid="brand-entrance"
      data-size={props.size}
    >
      <BrandMark
        className={cn(
          "brand-entrance-mark h-auto",
          props.size === "hero"
            ? "w-[clamp(3.75rem,8vw,5.4rem)] drop-shadow-[0_1.5rem_2.5rem_rgba(0,0,0,0.42)]"
            : "w-[clamp(1.5rem,6vw,2.25rem)]",
        )}
      />
      {props.children}
    </div>
  );
}
