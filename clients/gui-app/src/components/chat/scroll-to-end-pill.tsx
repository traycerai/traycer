import { ChevronDown } from "lucide-react";
import type { MouseEvent } from "react";

import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { cn } from "@/lib/utils";
import type { ScrollToEndPillState } from "@/components/chat/chat-scroll-to-end-pill-state";

function scrollToEndPillLabel(state: ScrollToEndPillState): string {
  switch (state.kind) {
    case "streaming":
      return `${state.workingVerb}…`;
    case "new-reply":
      return "New Reply";
    case "plain":
    case "hidden":
      return "Jump to Latest";
  }
}

interface ScrollToEndPillProps {
  readonly state: ScrollToEndPillState;
  readonly onClick: () => void;
  /** Pixel offset from the container's bottom edge - keeps the pill clear of
   *  the overlaid composer/queue dock (decision #13, #16: `endInset + 4`). */
  readonly bottomOffsetPx: number;
}

/**
 * Floating "scroll to end" pill. Sibling of the scroll container, absolute-
 * positioned bottom-center so its geometry is decoupled from the scroller's
 * content. It fades in/out via opacity + pointer-events so it never traps
 * focus or clicks while hidden. The accessible name stays fixed to the pill's
 * action across every state; the visible label communicates live work or a
 * completed reply.
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
      onClick={visible ? handleClick : undefined}
      tabIndex={visible ? 0 : -1}
      style={{ bottom: bottomOffsetPx }}
      className={cn(
        "pointer-events-auto absolute left-1/2 z-10 flex h-8 -translate-x-1/2 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-popover/95 ps-3 pe-2.5 font-medium text-popover-foreground text-ui-sm shadow-md ring-1 ring-foreground/10 backdrop-blur-sm",
        "outline-none transition-[opacity,scale,background-color,box-shadow,color] duration-150 ease-out hover:bg-popover hover:shadow-lg hover:ring-foreground/15 active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-ring/70",
        "motion-reduce:transition-none motion-reduce:active:scale-100",
        "[.traycer-panel-resizing_&]:pointer-events-none [.traycer-panel-resizing_&]:opacity-0",
        visible ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      {state.kind === "streaming" ? (
        <AgentSpinningDots
          className="text-current"
          testId="scroll-to-end-pill-spinner"
          variant={undefined}
        />
      ) : null}
      <span>{scrollToEndPillLabel(state)}</span>
      <ChevronDown
        className="size-4 shrink-0 opacity-70"
        strokeWidth={2}
        aria-hidden
        data-testid="scroll-to-end-pill-chevron"
      />
    </button>
  );
}
