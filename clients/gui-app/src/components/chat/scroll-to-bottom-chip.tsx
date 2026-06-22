import { ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ScrollToBottomChipProps {
  visible: boolean;
  onClick: () => void;
}

/**
 * Floating "Jump to latest" chip. Sibling of the scroll container,
 * absolute-positioned bottom-center so its geometry is decoupled from the
 * scroller's content. Fades in/out via opacity + pointer-events so it
 * never traps focus or clicks while hidden.
 */
export function ScrollToBottomChip({
  visible,
  onClick,
}: ScrollToBottomChipProps) {
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={onClick}
      aria-label="Scroll to bottom"
      tabIndex={visible ? 0 : -1}
      className={cn(
        "pointer-events-auto absolute bottom-4 left-1/2 z-10 -translate-x-1/2 shadow-md rounded-full",
        "transition-opacity duration-150",
        "[.traycer-panel-resizing_&]:pointer-events-none [.traycer-panel-resizing_&]:opacity-0",
        visible ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      <ChevronDown className="size-3.5" aria-hidden />
      <span>Jump to latest</span>
    </Button>
  );
}
