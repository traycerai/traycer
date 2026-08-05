import { ChevronDown, TextQuote } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import type { TerminalQuoteChatTarget } from "./terminal-quote-targets";
import {
  QUOTE_CONTROL_SLOT,
  type TerminalSelectionAnchor,
} from "./terminal-selection-anchor";

interface TerminalQuoteControlProps {
  readonly anchor: TerminalSelectionAnchor;
  /** Chats this Task can send to, best target first. Empty is a valid state. */
  readonly targets: ReadonlyArray<TerminalQuoteChatTarget>;
  readonly onQuoteToChat: (chatId: string) => void;
  readonly onQuoteToNewChat: () => void;
  readonly menuOpen: boolean;
  readonly onMenuOpenChange: (open: boolean) => void;
}

/**
 * The floating action over a terminal selection: quote into the chat the user
 * was last working in, or pick a different one.
 *
 * Reads as a sibling of the transcript's quote popover - same popover surface,
 * same quiet chrome, no entrance animation - because it is the same action in a
 * different place. The one thing added is the split: the target chat is named
 * on the button itself rather than hidden behind a hover, since "where is this
 * going" is the question a floating Quote button otherwise leaves open.
 */
export function TerminalQuoteControl(props: TerminalQuoteControlProps) {
  const primaryTarget = props.targets.length === 0 ? null : props.targets[0];

  return (
    <div
      data-slot={QUOTE_CONTROL_SLOT}
      className={cn(
        "absolute left-2 z-20 max-w-[calc(100%-1rem)]",
        props.anchor.placement === "above" && "-translate-y-full",
      )}
      style={{ top: props.anchor.top }}
    >
      <div className="flex items-stretch overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg">
        {primaryTarget === null ? (
          <ControlButton
            label="New chat"
            secondaryLabel={null}
            ariaLabel="Quote into a new chat"
            onClick={props.onQuoteToNewChat}
          />
        ) : (
          <ControlButton
            label="Quote"
            secondaryLabel={primaryTarget.title}
            ariaLabel={`Quote into ${primaryTarget.title}`}
            onClick={() => props.onQuoteToChat(primaryTarget.chatId)}
          />
        )}
        <span aria-hidden className="w-px shrink-0 bg-border" />
        {/*
          Non-modal: a modal Radix menu writes overflow/padding onto <body>
          for its scroll lock, and a layout change that reaches this pane
          refits the terminal - which makes xterm drop the very selection the
          menu was opened to act on. Nothing here needs the modal behaviour.
        */}
        <DropdownMenu
          modal={false}
          open={props.menuOpen}
          onOpenChange={props.onMenuOpenChange}
        >
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Choose where to quote"
              className={cn(
                "inline-flex shrink-0 items-center px-1.5 transition-colors",
                "hover:bg-accent hover:text-accent-foreground",
                "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
                "data-[state=open]:bg-accent data-[state=open]:text-accent-foreground",
              )}
            >
              <ChevronDown className="size-3.5" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="max-w-[min(90vw,20rem)]"
          >
            {props.targets.map((target) => (
              <DropdownMenuItem
                key={target.chatId}
                onSelect={() => props.onQuoteToChat(target.chatId)}
              >
                <span className="min-w-0 flex-1 truncate">{target.title}</span>
                {target.isLastFocused ? (
                  <span className="shrink-0 text-ui-xs text-muted-foreground">
                    Last used
                  </span>
                ) : null}
              </DropdownMenuItem>
            ))}
            {props.targets.length > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem onSelect={props.onQuoteToNewChat}>
              New chat
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function ControlButton(props: {
  readonly label: string;
  readonly secondaryLabel: string | null;
  readonly ariaLabel: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={props.ariaLabel}
      // Keeps focus off the button so pressing it cannot collapse or clear the
      // terminal selection before the click lands.
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onClick}
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 px-2 py-1 text-left transition-colors",
        "text-ui-xs font-medium text-popover-foreground",
        "hover:bg-accent hover:text-accent-foreground",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
      )}
    >
      <TextQuote className="size-3.5 shrink-0" aria-hidden />
      <span className="shrink-0">{props.label}</span>
      {props.secondaryLabel === null ? null : (
        <span className="min-w-0 truncate font-normal text-muted-foreground">
          {props.secondaryLabel}
        </span>
      )}
    </button>
  );
}
