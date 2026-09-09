import type { ReactNode } from "react";
import { BrandMark } from "@/components/auth/cinematic-backdrop";
import { cn } from "@/lib/utils";
import "@/styles/auth-arrival.css";

export function BrandEntrance(props: {
  readonly size: "hero" | "compact";
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div
      className={cn(
        "flex flex-col items-center",
        props.size === "hero" ? "gap-[clamp(1.2rem,2.8vh,2rem)]" : "gap-3",
      )}
      data-testid="brand-entrance"
    >
      <BrandMark
        className={cn(
          "brand-entrance-mark h-auto",
          props.size === "hero"
            ? "w-[clamp(4.5rem,18vw,6.5rem)] drop-shadow-[0_1.5rem_2.5rem_rgba(0,0,0,0.42)]"
            : "w-[clamp(3rem,12vw,4.5rem)]",
        )}
      />
      {props.children}
    </div>
  );
}
