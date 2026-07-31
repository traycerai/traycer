import { useCallback, useState, type MouseEvent, type ReactNode } from "react";
import { v4 as uuidv4 } from "uuid";
import type { PrOwnerRef } from "@traycer/protocol/host/pr-schemas";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EPIC_NODE_ICONS } from "@/lib/artifacts/node-display";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import {
  useChatById,
  useEpicNodeHostId,
  useEpicTerminalAgent,
  type EpicChatProjection,
  type EpicTuiAgentProjection,
} from "@/lib/epic-selectors";
import { displayTitle } from "@/lib/display-title";
import { cn } from "@/lib/utils";

const DELETED_OWNER_LABEL: Record<PrOwnerRef["ownerKind"], string> = {
  chat: "Removed chat",
  "terminal-agent": "Removed terminal agent",
};

function resolvePrOwnerLabel(args: {
  readonly owner: PrOwnerRef;
  readonly chat: EpicChatProjection | null;
  readonly tuiAgent: EpicTuiAgentProjection | null;
}): string | null {
  if (args.owner.ownerKind === "chat") {
    if (args.chat === null) return null;
    return displayTitle(args.chat.title, "chat");
  }
  if (args.tuiAgent === null) return null;
  // Harness identity is interface metadata, never the title fallback (see
  // `display-title.ts`), so an untitled owner reads "Untitled terminal agent".
  return displayTitle(args.tuiAgent.title, "terminal-agent");
}

/**
 * The owning chat/terminal-agent title as plain text - the PR detail view's
 * sidebar, where the surrounding list is read-only prose and a row of buttons
 * would be noise. The panel row uses {@link PrOwnerBadges} instead.
 */
export function PrOwnerLabel(props: {
  readonly owner: PrOwnerRef | null;
  readonly className: string | undefined;
}): ReactNode {
  const chat = useChatById(
    props.owner?.ownerKind === "chat" ? props.owner.ownerId : null,
  );
  const tuiAgent = useEpicTerminalAgent(
    props.owner?.ownerKind === "terminal-agent" ? props.owner.ownerId : null,
  );
  if (props.owner === null) return null;
  const label =
    resolvePrOwnerLabel({ owner: props.owner, chat, tuiAgent }) ??
    DELETED_OWNER_LABEL[props.owner.ownerKind];
  return (
    <span
      className={cn(
        "truncate text-ui-xs text-muted-foreground",
        props.className,
      )}
    >
      {label}
    </span>
  );
}

/**
 * How many owner chips a card shows inline before the rest collapse behind
 * `+N`.
 *
 * A PR on a large epic can be derived from dozens of chats. Rendering them all
 * turned this wrapping row into tens of lines and broke the panel row's
 * fixed-height four-band block (see `PrRow`), so the row no longer scanned as a
 * list. Three is what fits one line at the sidebar's narrowest useful width
 * while still showing enough to recognise the PR's origin without opening
 * anything.
 */
const VISIBLE_PR_OWNER_COUNT = 3;

/**
 * The chats/terminal agents a PR was derived from, as badges that open their
 * own tile - the same affordance the Worktrees panel gives a worktree's owning
 * Task, so "which conversation produced this?" is one click away rather than a
 * name you have to go find. Past {@link VISIBLE_PR_OWNER_COUNT} the tail
 * collapses behind a `+N` chip so a large epic cannot turn one card into tens
 * of wrapped rows.
 */
export function PrOwnerBadges(props: {
  readonly owners: readonly PrOwnerRef[];
  readonly epicId: string;
  /**
   * Host to open a legacy owner on when its own `hostId` predates the field.
   *
   * Passed in rather than read here, because the right answer depends on WHERE
   * this renders. An app-wide surface (the panel) wants the reactive active
   * host; a canvas tile must use its own bound `useTabHostId()` - per CLAUDE.md
   * a tab is bound to a host for life and may never consult the reactive
   * global, or a host swap would silently re-point the tile's links.
   */
  readonly fallbackHostId: string | null;
  readonly className: string | undefined;
}): ReactNode {
  if (props.owners.length === 0) return null;
  // Only collapse when collapsing actually saves a chip. At exactly one over
  // the limit a "+1" would cost the same width as the chip it hides.
  const collapses = props.owners.length > VISIBLE_PR_OWNER_COUNT + 1;
  const visible = collapses
    ? props.owners.slice(0, VISIBLE_PR_OWNER_COUNT)
    : props.owners;
  const hidden = props.owners.length - visible.length;
  return (
    <span
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-1",
        props.className,
      )}
      data-testid="pr-owner-badges"
    >
      {visible.map((owner) => (
        <PrOwnerBadge
          key={`${owner.ownerKind}:${owner.ownerId}`}
          owner={owner}
          epicId={props.epicId}
          fallbackHostId={props.fallbackHostId}
        />
      ))}
      {hidden > 0 ? (
        <PrOwnerOverflow
          owners={props.owners}
          hidden={hidden}
          epicId={props.epicId}
          fallbackHostId={props.fallbackHostId}
        />
      ) : null}
    </span>
  );
}

/**
 * The `+N` chip and the popover behind it, listing EVERY owner - not just the
 * hidden ones. Once a reader has opened the overflow they are looking for one
 * specific chat, and splitting the set across "shown above" and "in here"
 * would make them look in two places for it.
 */
function PrOwnerOverflow(props: {
  readonly owners: readonly PrOwnerRef[];
  readonly hidden: number;
  readonly epicId: string;
  readonly fallbackHostId: string | null;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const close = useCallback((): void => setOpen(false), []);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Badge
          asChild
          variant="outline"
          className="cursor-pointer font-normal text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <button
            type="button"
            // The row itself opens the PR tile; this chip means "show the rest".
            onClick={(event) => event.stopPropagation()}
            aria-label={`Show all ${props.owners.length} chats`}
            data-testid="pr-owner-overflow"
          >
            {`+${props.hidden}`}
          </button>
        </Badge>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        // Keydown too: without it, Enter/Space on a row bubbles to the PR row's
        // own handler and opens the PR tile as well as the chat.
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        className="w-[min(80vw,20rem)] p-0"
      >
        <p className="border-b px-3 py-2 text-ui-xs text-muted-foreground">
          Chats this PR came from
        </p>
        {/* Capped by viewport rather than a row count: the same popover serves
            the narrow sidebar row and the wider detail card. */}
        <ScrollArea className="max-h-[min(50vh,18rem)]">
          <div
            className="flex flex-col p-1"
            data-testid="pr-owner-overflow-list"
          >
            {props.owners.map((owner) => (
              <PrOwnerRow
                key={`${owner.ownerKind}:${owner.ownerId}`}
                owner={owner}
                epicId={props.epicId}
                fallbackHostId={props.fallbackHostId}
                onOpened={close}
              />
            ))}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

function PrOwnerBadge(props: {
  readonly owner: PrOwnerRef;
  readonly epicId: string;
  readonly fallbackHostId: string | null;
}): ReactNode {
  // Both lookup hooks run unconditionally (rules-of-hooks) with the id gated
  // to `null` for the kind that doesn't apply, so only one ever resolves.
  const chat = useChatById(
    props.owner.ownerKind === "chat" ? props.owner.ownerId : null,
  );
  const tuiAgent = useEpicTerminalAgent(
    props.owner.ownerKind === "terminal-agent" ? props.owner.ownerId : null,
  );
  // A chat predating the per-node `hostId` field falls back to the host the
  // CALLER nominated, exactly as the sidebar's own node opener does - a tile
  // ref has no null host, and refusing to open would be worse than the fallback
  // the rest of the app already relies on.
  const nodeHostId = useEpicNodeHostId(props.owner.ownerId);
  const hostId = nodeHostId ?? props.fallbackHostId;
  const tileNavigation = useEpicTileNavigation();
  const label = resolvePrOwnerLabel({ owner: props.owner, chat, tuiAgent });
  const { epicId } = props;
  const { ownerId, ownerKind } = props.owner;
  const openOwner = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      // The row itself opens the PR tile; a badge click means the CHAT.
      event.stopPropagation();
      if (label === null || hostId === null) return;
      tileNavigation.openTileInEpic(epicId, {
        id: ownerId,
        instanceId: uuidv4(),
        type: ownerKind,
        name: label,
        hostId,
      });
    },
    [epicId, hostId, label, ownerId, ownerKind, tileNavigation],
  );

  // A deleted owner (orphaned worktree binding - no cascade) has no tile to
  // open, so it demotes to muted text rather than a button that does nothing.
  if (label === null) {
    return (
      <span
        className="truncate text-ui-xs text-muted-foreground/70"
        data-testid="pr-owner-removed"
      >
        {DELETED_OWNER_LABEL[props.owner.ownerKind]}
      </span>
    );
  }

  // Same rule, other cause: `fallbackHostId` is nullable, so a legacy owner
  // on a surface with no host bound still HAS a name worth showing but
  // nothing to open it on. `openOwner` would return early, leaving a badge
  // that looks clickable and silently isn't.
  if (hostId === null) {
    return (
      <span
        className="truncate text-ui-xs text-muted-foreground/70"
        data-testid="pr-owner-unopenable"
      >
        {label}
      </span>
    );
  }

  return (
    <Badge
      asChild
      variant="outline"
      className="max-w-[min(60vw,16rem)] cursor-pointer font-normal text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <TooltipWrapper
        label={label}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <button
          type="button"
          aria-label={`Open ${label}`}
          onClick={openOwner}
          data-testid="pr-owner-badge"
        >
          <span className="truncate">{label}</span>
        </button>
      </TooltipWrapper>
    </Badge>
  );
}

/**
 * One owner inside the overflow popover, shaped like a chats-menu row (kind
 * icon + title on one line) rather than a pill, because a vertical list of
 * pills reads as tags while this list is being scanned for a specific chat.
 *
 * Shares `PrOwnerBadge`'s resolution rules exactly: a deleted owner has no
 * tile to open and an owner with no resolvable host has a name but nothing to
 * open it on, so both demote to muted, non-interactive text.
 */
function PrOwnerRow(props: {
  readonly owner: PrOwnerRef;
  readonly epicId: string;
  readonly fallbackHostId: string | null;
  readonly onOpened: () => void;
}): ReactNode {
  const chat = useChatById(
    props.owner.ownerKind === "chat" ? props.owner.ownerId : null,
  );
  const tuiAgent = useEpicTerminalAgent(
    props.owner.ownerKind === "terminal-agent" ? props.owner.ownerId : null,
  );
  const nodeHostId = useEpicNodeHostId(props.owner.ownerId);
  const hostId = nodeHostId ?? props.fallbackHostId;
  const tileNavigation = useEpicTileNavigation();
  const label = resolvePrOwnerLabel({ owner: props.owner, chat, tuiAgent });
  const { epicId, onOpened } = props;
  const { ownerId, ownerKind } = props.owner;
  const Icon = EPIC_NODE_ICONS[ownerKind];
  const openOwner = useCallback((): void => {
    if (label === null || hostId === null) return;
    tileNavigation.openTileInEpic(epicId, {
      id: ownerId,
      instanceId: uuidv4(),
      type: ownerKind,
      name: label,
      hostId,
    });
    onOpened();
  }, [epicId, hostId, label, onOpened, ownerId, ownerKind, tileNavigation]);

  if (label === null || hostId === null) {
    return (
      <span
        className="flex min-w-0 items-center gap-2 rounded px-2 py-1.5 text-ui-xs text-muted-foreground/70"
        data-testid="pr-owner-row-unopenable"
      >
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">
          {label ?? DELETED_OWNER_LABEL[ownerKind]}
        </span>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={openOwner}
      aria-label={`Open ${label}`}
      data-testid="pr-owner-row"
      className="flex min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-ui-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}
