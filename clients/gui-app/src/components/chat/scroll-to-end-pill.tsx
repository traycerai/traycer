import { ChevronDown } from "lucide-react";

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
 * content. T3 visual shape (ChatView.tsx); fades in/out via opacity +
 * pointer-events so it never traps focus or clicks while hidden. The
 * accessible name stays fixed to the pill's ACTION ("Scroll to end") across
 * every state - only the decorative visible label changes.
 */
export function ScrollToEndPill({
  state,
  onClick,
  bottomOffsetPx,
}: ScrollToEndPillProps) {
  const visible = state.kind !== "hidden";
  return (
    <button
      type="button"
      aria-label="Scroll to end"
      onClick={onClick}
      tabIndex={visible ? 0 : -1}
      style={{ bottom: bottomOffsetPx }}
      className={cn(
        "pointer-events-auto absolute left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border/60 bg-card px-3 py-1 text-muted-foreground text-xs shadow-sm",
        "transition-opacity duration-150 hover:border-border hover:text-foreground",
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
      ) : (
        <ChevronDown className="size-3.5" aria-hidden />
      )}
      <span>{scrollToEndPillLabel(state)}</span>
    </button>
  );
}
