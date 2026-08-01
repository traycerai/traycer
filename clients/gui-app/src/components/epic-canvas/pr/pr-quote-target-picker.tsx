import { type ReactNode } from "react";
import { ChevronDown, MessagesSquare, Terminal } from "lucide-react";
import type { PrQuoteTarget } from "@/lib/pr/pr-quote";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useRelativeTimestamp } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

/**
 * Picks which chat or terminal agent this tile's `⌁` affordances send to.
 *
 * Deliberately the same anatomy as `OpenInEditorButton`: a surface showing the
 * current pick, a chevron opening the list, and the choice becoming the new
 * default. The PR view has many quote sources (a check, a review, a file, the
 * description) and one destination, so the destination is chosen ONCE here
 * rather than being asked for at every quote.
 *
 * Three variants for the three width states the card ladder produces. They
 * differ only in chrome - the same target, the same list, the same callback -
 * so the answer to "where does this go?" cannot drift between them.
 */
export function PrQuoteTargetPicker(props: {
  readonly target: PrQuoteTarget | null;
  readonly targets: readonly PrQuoteTarget[];
  readonly onSelectTarget: (target: PrQuoteTarget) => void;
  readonly variant: "card" | "compact";
}): ReactNode {
  const chats = props.targets.filter((entry) => entry.kind === "chat");
  const agents = props.targets.filter(
    (entry) => entry.kind === "terminal-agent",
  );

  if (props.targets.length === 0) {
    return (
      <p className="text-ui-xs text-muted-foreground/70">
        No chats in this epic yet
      </p>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="pr-quote-target-trigger"
        className={cn(
          "flex min-w-0 items-center gap-1.5 rounded-md border border-border/70 text-ui-xs",
          "transition-colors hover:bg-accent/40 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
          props.variant === "card" ? "w-full px-2 py-1.5" : "px-1.5 py-0.5",
        )}
      >
        <span className="min-w-0 flex-1 truncate text-left text-foreground">
          {props.target?.title ?? "Choose a chat"}
        </span>
        <ChevronDown
          className="size-3 shrink-0 text-muted-foreground"
          aria-hidden
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[min(90vw,17rem)]"
        data-testid="pr-quote-target-menu"
      >
        {chats.length > 0 ? (
          <DropdownMenuLabel className="text-ui-xs text-muted-foreground">
            Chats in this epic
          </DropdownMenuLabel>
        ) : null}
        {chats.map((entry) => (
          <PrQuoteTargetItem
            key={entry.id}
            entry={entry}
            selected={entry.id === props.target?.id}
            onSelect={props.onSelectTarget}
          />
        ))}
        {agents.length > 0 ? (
          <>
            {chats.length > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel className="text-ui-xs text-muted-foreground">
              Terminal agents
            </DropdownMenuLabel>
          </>
        ) : null}
        {agents.map((entry) => (
          <PrQuoteTargetItem
            key={entry.id}
            entry={entry}
            selected={entry.id === props.target?.id}
            onSelect={props.onSelectTarget}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PrQuoteTargetItem(props: {
  readonly entry: PrQuoteTarget;
  readonly selected: boolean;
  readonly onSelect: (target: PrQuoteTarget) => void;
}): ReactNode {
  const relative = useRelativeTimestamp(props.entry.updatedAt);
  const Icon = props.entry.kind === "chat" ? MessagesSquare : Terminal;
  return (
    <DropdownMenuItem
      data-testid="pr-quote-target-item"
      data-selected={props.selected ? "true" : "false"}
      onSelect={() => props.onSelect(props.entry)}
      className={cn(props.selected && "bg-accent/50")}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{props.entry.title}</span>
      <span className="shrink-0 text-ui-xs text-muted-foreground/70">
        {relative}
      </span>
    </DropdownMenuItem>
  );
}
