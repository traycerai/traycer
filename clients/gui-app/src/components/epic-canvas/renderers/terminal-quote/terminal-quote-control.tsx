import { ChevronDown, MessageSquareShare } from "lucide-react";

import { ChatTargetMenu } from "@/components/epic-canvas/renderers/chat-target-menu/chat-target-menu";
import { cn } from "@/lib/utils";

import type { TerminalQuoteChatTarget } from "./terminal-quote-targets";
import {
  QUOTE_CONTROL_SLOT,
  type TerminalSelectionAnchor,
} from "./terminal-selection-anchor";

interface TerminalQuoteControlProps {
  readonly anchor: TerminalSelectionAnchor;
  /** Chats this Task can send to, open ones first. Empty is a valid state. */
  readonly targets: ReadonlyArray<TerminalQuoteChatTarget>;
  readonly onSendToChat: (chatId: string) => void;
  readonly onSendToNewChat: () => void;
  readonly menuOpen: boolean;
  readonly onMenuOpenChange: (open: boolean) => void;
}

/**
 * The floating action over a terminal selection: one button that asks where
 * the selection is going, and a panel that answers it.
 *
 * Reads as a sibling of the transcript's quote popover and the composer's
 * `@`-picker - same popover surface, same quiet chrome, same micro-type
 * section headings - because it is the same kind of action in a different
 * place. Deliberately not a split button: a primary target guessed from focus
 * history is right often enough to be tempting and wrong often enough to send
 * a selection somewhere the user was not looking, and the recovery for that is
 * worse than one extra click.
 *
 * The roster itself is `ChatTargetMenu`, shared with the artifact editor's
 * send-to-chat; only the pill and where it sits are terminal-specific.
 */
export function TerminalQuoteControl(props: TerminalQuoteControlProps) {
  return (
    <div
      data-slot={QUOTE_CONTROL_SLOT}
      className={cn(
        "absolute z-20",
        props.anchor.placement === "above" && "-translate-y-full",
      )}
      // Both offsets and the width cap come from the anchor: it is the one
      // place that knows where the selection starts and how much pane is left
      // beside it (see `terminalSelectionAnchor`).
      style={{
        top: props.anchor.top,
        left: props.anchor.left,
        maxWidth: props.anchor.maxWidth,
      }}
    >
      <ChatTargetMenu
        targets={props.targets}
        onSelectChat={props.onSendToChat}
        onSelectNewChat={props.onSendToNewChat}
        open={props.menuOpen}
        onOpenChange={props.onMenuOpenChange}
        trigger={
          <button
            type="button"
            className={cn(
              "inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border px-2 py-1",
              "bg-popover text-ui-xs font-medium text-popover-foreground shadow-lg transition-colors",
              "hover:bg-accent hover:text-accent-foreground",
              "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
              "data-[state=open]:bg-accent data-[state=open]:text-accent-foreground",
            )}
          >
            <MessageSquareShare className="size-3.5 shrink-0" aria-hidden />
            <span className="shrink-0">Send to chat</span>
            <ChevronDown
              className="size-3 shrink-0 text-muted-foreground"
              aria-hidden
            />
          </button>
        }
      />
    </div>
  );
}
