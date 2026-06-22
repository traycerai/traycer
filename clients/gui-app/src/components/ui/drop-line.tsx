import { cn } from "@/lib/utils";

type DropLineOrientation = "horizontal" | "vertical";

interface DropLineProps {
  readonly orientation: DropLineOrientation;
  readonly glow: boolean;
  readonly className: string | undefined;
  readonly testId: string | undefined;
}

export function DropLine(props: DropLineProps) {
  return (
    <div
      aria-hidden
      data-testid={props.testId}
      className={cn(
        "pointer-events-none rounded-full bg-primary",
        props.orientation === "horizontal" ? "h-0.5" : "w-0.5",
        props.glow &&
          "shadow-[0_0_12px_color-mix(in_oklch,var(--primary)_55%,transparent)]",
        props.className,
      )}
    />
  );
}
