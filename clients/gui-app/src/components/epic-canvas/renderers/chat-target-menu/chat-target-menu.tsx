import type { ReactNode } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import type { QuoteChatTarget } from "./quote-chat-targets";

interface ChatTargetMenuProps {
  /** Chats this Task can send to, open ones first. Empty is a valid state. */
  readonly targets: ReadonlyArray<QuoteChatTarget>;
  readonly onSelectChat: (chatId: string) => void;
  readonly onSelectNewChat: () => void;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /**
   * The element the menu anchors to and opens from. The terminal pill and the
   * artifact popover's anchor both go here; the roster does not care what it
   * looks like, only that Radix has a trigger to position against.
   */
  readonly trigger: ReactNode;
}

/**
 * The "where is this selection going" roster, shared by every send-to-chat
 * surface: three bands - an empty header slot a filter would drop into, the
 * scrolling chat list, and a pinned "New chat". The column is what keeps that
 * last one reachable - the roster shrinks when the pane is short, rather than
 * pushing the action out of view.
 *
 * A complete Radix menu rather than bare rows: `DropdownMenuItem` needs the
 * menu context for its keyboard navigation and `disabled` semantics, so the
 * shared unit has to be the root + content, with the caller supplying only the
 * trigger.
 *
 * Non-modal: a modal Radix menu writes overflow/padding onto <body> for its
 * scroll lock, and a layout change that reaches a terminal pane refits the
 * terminal - which makes xterm drop the very selection the menu was opened
 * to act on. Nothing here needs the modal behaviour.
 */
export function ChatTargetMenu(props: ChatTargetMenuProps) {
  const openTargets = props.targets.filter((target) => target.isOpen);
  const otherTargets = props.targets.filter((target) => !target.isOpen);
  // The headings earn their space only when they separate something. With
  // every chat open - or none - they would label a single undivided list.
  const banded = openTargets.length > 0 && otherTargets.length > 0;

  return (
    <DropdownMenu
      modal={false}
      open={props.open}
      onOpenChange={props.onOpenChange}
    >
      <DropdownMenuTrigger asChild>{props.trigger}</DropdownMenuTrigger>
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
                  onSelect={props.onSelectChat}
                />
              ))}
              {banded ? (
                <DropdownMenuLabel>Other chats</DropdownMenuLabel>
              ) : null}
              {otherTargets.map((target) => (
                <ChatTargetItem
                  key={target.chatId}
                  target={target}
                  onSelect={props.onSelectChat}
                />
              ))}
            </div>
            <DropdownMenuSeparator className="shrink-0" />
          </>
        ) : null}
        <DropdownMenuItem className="shrink-0" onSelect={props.onSelectNewChat}>
          New chat
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
  readonly target: QuoteChatTarget;
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
function chatTargetMeta(target: QuoteChatTarget): string | null {
  if (target.isOnOtherHost) return "On a different host";
  if (target.isLastFocused) return "Last used";
  return null;
}
