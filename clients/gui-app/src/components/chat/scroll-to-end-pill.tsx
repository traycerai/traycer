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
      return "New reply";
    case "plain":
    case "hidden":
      return "Scroll to end";
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
 * focus or clicks while hidden. A restrained border separates it from the
 * chat without adding a heavy shadow; the persistent chevron keeps the action
 * clear even when the visible label describes live work. The
 * accessible name stays fixed to the pill's ACTION ("Scroll to end") across
 * every state - only the decorative visible label changes.
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
        "pointer-events-auto absolute left-1/2 z-10 flex h-8 -translate-x-1/2 select-none items-center gap-2 whitespace-nowrap rounded-full border border-foreground/20 bg-[color-mix(in_oklch,var(--foreground)_9%,var(--background))] px-3.5 font-medium text-foreground/85 text-ui-xs",
        "outline-none transition-[opacity,background-color,border-color,box-shadow,color] duration-150 hover:border-foreground/30 hover:bg-[color-mix(in_oklch,var(--foreground)_12%,var(--background))] hover:text-foreground focus-visible:border-ring/70 focus-visible:ring-2 focus-visible:ring-ring/70",
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
        aria-hidden
        data-testid="scroll-to-end-pill-chevron"
      />
    </button>
  );
}
