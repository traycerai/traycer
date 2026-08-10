import { ArrowDown } from "lucide-react";
import type { MouseEvent } from "react";

import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { cn } from "@/lib/utils";
import type { ScrollToEndPillState } from "@/components/chat/chat-scroll-to-end-pill-state";

interface ScrollToEndPillProps {
  readonly state: ScrollToEndPillState;
  readonly onClick: () => void;
  /** Pixel offset from the container's bottom edge - keeps the pill clear of
   *  the overlaid composer/queue dock (decision #13, #16: `endInset + 4`). */
  readonly bottomOffsetPx: number;
}

/**
 * Floating "scroll to end" control. Sibling of the scroll container, absolute-
 * positioned bottom-center so its geometry is decoupled from the scroller's
 * content. It scales and fades in/out so it never traps focus or clicks while
 * hidden. The accessible name stays fixed to the control's action across every
 * state; streaming is communicated visually by the same three-dot wave used by
 * the in-progress chat indicator.
 */
export function ScrollToEndPill({
  state,
  onClick,
  bottomOffsetPx,
}: ScrollToEndPillProps) {
  const visible = state.kind !== "hidden";
  const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    event.currentTarget.blur();
    onClick();
  };
  return (
    <button
      type="button"
      aria-hidden={visible ? undefined : true}
      aria-label="Scroll to end"
      data-state={state.kind}
      onClick={visible ? handleClick : undefined}
      tabIndex={visible ? 0 : -1}
      style={{ bottom: bottomOffsetPx }}
      className={cn(
        "pointer-events-auto absolute left-1/2 z-10 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-md ring-1 ring-foreground/10",
        "outline-none transition-[opacity,transform,color,background-color,border-color,box-shadow] duration-200 ease-out hover:bg-secondary hover:shadow-lg active:scale-95 focus-visible:border-ring/70 focus-visible:ring-2 focus-visible:ring-ring/70",
        "motion-reduce:transition-none",
        "[.traycer-panel-resizing_&]:pointer-events-none [.traycer-panel-resizing_&]:opacity-0",
        visible
          ? "translate-y-0 scale-100 opacity-100"
          : "pointer-events-none translate-y-1 scale-75 opacity-0",
      )}
    >
      {state.kind === "streaming" ? (
        <AgentSpinningDots
          className="text-current"
          testId="scroll-to-end-pill-streaming-dots"
          variant="typing"
        />
      ) : (
        <ArrowDown className="size-4" strokeWidth={1.75} aria-hidden />
      )}
    </button>
  );
}
