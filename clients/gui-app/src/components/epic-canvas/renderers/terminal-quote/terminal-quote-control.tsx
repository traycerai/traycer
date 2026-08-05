import { ChevronDown, MessageSquareShare } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
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
 */
export function TerminalQuoteControl(props: TerminalQuoteControlProps) {
  const openTargets = props.targets.filter((target) => target.isOpen);
  const otherTargets = props.targets.filter((target) => !target.isOpen);
  // The headings earn their space only when they separate something. With
  // every chat open - or none - they would label a single undivided list.
  const banded = openTargets.length > 0 && otherTargets.length > 0;

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
        </DropdownMenuTrigger>
        {/*
          Three bands: an empty header slot a filter would drop into, the
          scrolling roster, and a pinned "New chat". The column is what keeps
          that last one reachable - the roster shrinks when the pane is short,
          rather than pushing the action out of view.
        */}
        <DropdownMenuContent
          align="start"
          className="flex w-max min-w-[min(90vw,14rem)] max-w-[min(90vw,20rem)] flex-col overflow-y-hidden"
        >
          {props.targets.length > 0 ? (
            <>
              <div className="max-h-[40vh] min-h-0 flex-1 overflow-y-auto">
                {banded ? <DropdownMenuLabel>Open</DropdownMenuLabel> : null}
                {openTargets.map((target) => (
                  <ChatTargetItem
                    key={target.chatId}
                    target={target}
                    onSelect={props.onSendToChat}
                  />
                ))}
                {banded ? (
                  <DropdownMenuLabel>Other chats</DropdownMenuLabel>
                ) : null}
                {otherTargets.map((target) => (
                  <ChatTargetItem
                    key={target.chatId}
                    target={target}
                    onSelect={props.onSendToChat}
                  />
                ))}
              </div>
              <DropdownMenuSeparator className="shrink-0" />
            </>
          ) : null}
          <DropdownMenuItem
            className="shrink-0"
            onSelect={props.onSendToNewChat}
          >
            New chat
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * One chat in the roster, with the one thing that can disqualify it.
 *
 * A chat on another host is shown disabled rather than hidden, because the
 * user can see it in the sidebar and would otherwise be left wondering where
 * it went. Radix's own `disabled` does the dimming, the pointer block AND the
 * keyboard skip, so the row is unreachable by every route at once. The reason
 * replaces "Last used" on such a row: why it cannot be picked is the only
 * thing worth the space.
 */
function ChatTargetItem(props: {
  readonly target: TerminalQuoteChatTarget;
  readonly onSelect: (chatId: string) => void;
}) {
  const meta = chatTargetMeta(props.target);
  return (
    <DropdownMenuItem
      disabled={props.target.isOnOtherHost}
      onSelect={() => props.onSelect(props.target.chatId)}
    >
      <span className="min-w-0 flex-1 truncate">{props.target.title}</span>
      {meta === null ? null : (
        <span className="shrink-0 text-ui-xs text-muted-foreground">
          {meta}
        </span>
      )}
    </DropdownMenuItem>
  );
}

/**
 * The one line of trailing meta a row gets. Being unreachable outranks being
 * recent: on a row the user cannot pick, why is the only useful thing to say.
 */
function chatTargetMeta(target: TerminalQuoteChatTarget): string | null {
  if (target.isOnOtherHost) return "On a different host";
  if (target.isLastFocused) return "Last used";
  return null;
}
