import {
  useCallback,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { v4 as uuidv4 } from "uuid";
import type { LucideIcon } from "lucide-react";
import type { PrOwnerRef } from "@traycer/protocol/host/pr-schemas";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TreeGroupGuide } from "@/components/epic-canvas/sidebar/epic-sidebar-tree-guide";
import {
  BASE_PAD_LEFT,
  INDENT_PX,
} from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";
import {
  buildPrOwnerTree,
  prOwnerCollectionNouns,
  prOwnerKey,
  type PrOwnerTreeNode,
} from "@/components/epic-canvas/pr/pr-owner-tree";
import { EpicSessionGate } from "@/providers/epic-session-gate";
import { EPIC_NODE_ICONS } from "@/lib/artifacts/node-display";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import {
  useChatById,
  useEpicNodeHostId,
  useEpicTerminalAgent,
  useEpicTreeIndex,
  type EpicChatProjection,
  type EpicTuiAgentProjection,
} from "@/lib/epic-selectors";
import { usePresentPrOwners } from "@/hooks/pr/use-present-pr-owners";
import { displayTitle } from "@/lib/display-title";
import { cn } from "@/lib/utils";

const DELETED_OWNER_LABEL: Record<PrOwnerRef["ownerKind"], string> = {
  chat: "Removed chat",
  "terminal-agent": "Removed terminal agent",
};

/**
 * The resolution `PrOwnerBadge` and `PrOwnerRow` must agree on, in one place:
 * the two gated lookups, the legacy host fallback, the display label, the
 * kind's icon, and the tile-open payload. The two surfaces render differently
 * (pill vs. menu row) but have to decide "can this be opened, and as what?"
 * identically - kept as two copies they could only drift.
 */
function usePrOwnerResolution(args: {
  readonly owner: PrOwnerRef;
  readonly epicId: string;
  readonly fallbackHostId: string | null;
}): {
  readonly label: string | null;
  readonly hostId: string | null;
  readonly Icon: LucideIcon;
  readonly openOwner: () => void;
} {
  // Both lookup hooks run unconditionally (rules-of-hooks) with the id gated
  // to `null` for the kind that doesn't apply, so only one ever resolves.
  const chat = useChatById(
    args.owner.ownerKind === "chat" ? args.owner.ownerId : null,
  );
  const tuiAgent = useEpicTerminalAgent(
    args.owner.ownerKind === "terminal-agent" ? args.owner.ownerId : null,
  );
  // A chat predating the per-node `hostId` field falls back to the host the
  // CALLER nominated, exactly as the sidebar's own node opener does - a tile
  // ref has no null host, and refusing to open would be worse than the fallback
  // the rest of the app already relies on.
  const nodeHostId = useEpicNodeHostId(args.owner.ownerId);
  const hostId = nodeHostId ?? args.fallbackHostId;
  const tileNavigation = useEpicTileNavigation();
  const label = resolvePrOwnerLabel({ owner: args.owner, chat, tuiAgent });
  const { epicId } = args;
  const { ownerId, ownerKind } = args.owner;
  const openOwner = useCallback((): void => {
    if (label === null || hostId === null) return;
    tileNavigation.openTileInEpic(epicId, {
      id: ownerId,
      instanceId: uuidv4(),
      type: ownerKind,
      name: label,
      hostId,
    });
  }, [epicId, hostId, label, ownerId, ownerKind, tileNavigation]);

  return { label, hostId, Icon: EPIC_NODE_ICONS[ownerKind], openOwner };
}

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
  // EVERY hook below this line reads the epic projection, and every one of them
  // throws when the session handle is not there yet. `EpicSessionProvider`
  // renders its children before it has one (desktop ownership claim, then
  // acquire) and says so: "session-bound slots see a null context and show
  // their own loading content". This row is one of those slots and did not know
  // it - the PR list arrives on its OWN host stream, which waits for no epic
  // session, so rows paint inside that window and took the route's error
  // boundary down with them. Nothing is the right loading content for a chip
  // row: the chips appear on the render after the session lands.
  //
  // "Session lands" is the gate, NOT "the doc syncs". Since chats-off-YJS the
  // titles these chips resolve come from `OpenEpicState.chats`, which is the
  // host's store-backed record plane (`epic.listChatRecords` /
  // `host.chatRecords.subscribe`) unioned with `docChats` - and that doc half
  // is not-yet-swept residue serving hosts that predate the record methods,
  // not the live plane. So the handle existing is necessary but not
  // sufficient: chips can stay absent against a live session until the records
  // are served.
  return (
    <EpicSessionGate fallback={null}>
      <ResolvedPrOwnerBadges {...props} />
    </EpicSessionGate>
  );
}

function ResolvedPrOwnerBadges(props: {
  readonly owners: readonly PrOwnerRef[];
  readonly epicId: string;
  readonly fallbackHostId: string | null;
  readonly className: string | undefined;
}): ReactNode {
  const owners = usePresentPrOwners(props.owners);
  if (owners.length === 0) return null;
  // Only collapse when collapsing actually saves a chip. At exactly one over
  // the limit a "+1" would cost the same width as the chip it hides.
  const collapses = owners.length > VISIBLE_PR_OWNER_COUNT + 1;
  const visible = collapses ? owners.slice(0, VISIBLE_PR_OWNER_COUNT) : owners;
  const hidden = owners.length - visible.length;
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
          key={prOwnerKey(owner)}
          owner={owner}
          epicId={props.epicId}
          fallbackHostId={props.fallbackHostId}
        />
      ))}
      {hidden > 0 ? (
        <PrOwnerOverflow
          owners={owners}
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
  const nouns = prOwnerCollectionNouns(props.owners);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Badge
          asChild
          variant="outline"
          className="cursor-pointer font-normal text-muted-foreground hover:bg-foreground/8 hover:text-foreground"
        >
          <button
            type="button"
            // The row itself opens the PR tile; this chip means "show the rest".
            onClick={(event) => event.stopPropagation()}
            aria-label={`Show all ${props.owners.length} ${nouns.plural}`}
            data-testid="pr-owner-overflow"
          >
            {`+${props.hidden}`}
          </button>
        </Badge>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        collisionPadding={8}
        // Keydown too: without it, Enter/Space on a row bubbles to the PR row's
        // own handler and opens the PR tile as well as the chat.
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        // Both axes are CAPPED, never SIZED: the same popover serves the narrow
        // sidebar row and the wider detail card, and a PR on a large epic can
        // list dozens of owners at several levels of nesting.
        //
        // Height: the space Radix measured between the trigger and the viewport
        // edge, floored against `60vh` - not a rem, which would hold a long list
        // to the same few rows on a display with room for twice as many.
        //
        // Width: `w-max` so the box tracks its widest row instead of painting a
        // fixed column. A short list of short titles stops being a mostly-empty
        // 20rem panel, and a deep lineage - whose indent eats the title column
        // that IS the reason to open this list - gets the room a wide display
        // already has. The rem survives only as the last term of a `max-w`,
        // which is the fluid pattern (clients/gui-app/AGENTS.md), not a width.
        // Each var carries a fallback: an unmeasured var invalidates the whole
        // `min()`, and a dropped `max-w` would let a long title size the popover
        // off-screen.
        //
        // `overflow-hidden` is what makes the height cap bite - without it the
        // list paints straight past the popover's box.
        className="max-h-[min(var(--radix-popover-content-available-height,100vh),60vh)] w-max max-w-[min(80vw,var(--radix-popover-content-available-width,100vw),28rem)] gap-0 overflow-hidden p-0"
      >
        <p className="shrink-0 border-b px-3 py-2 text-ui-xs text-muted-foreground">
          {`${nouns.capitalized} this PR came from`}
        </p>
        {/* Rendered as its own component so the agent-tree read below happens
            only while the popover is OPEN. Radix mounts content on open and
            unmounts it on close, so a hook placed here costs nothing until a
            reader asks for the list - whereas the same hook in the parent
            subscribes every collapsed `+N` chip on the surface to the tree and
            rebuilds its forest on every rename, reparent and agent
            create/delete, for a list nobody is looking at. */}
        <PrOwnerTreeList
          owners={props.owners}
          label={`${nouns.capitalized} this PR came from`}
          epicId={props.epicId}
          fallbackHostId={props.fallbackHostId}
          onOpened={close}
          testId="pr-owner-overflow-list"
          className={undefined}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The owner forest itself. Split from its containers purely so its tree
 * subscription is scoped to the OPEN surface - mount it only inside content a
 * Radix primitive unmounts on close (`PrOwnerOverflow`'s popover, the row hover
 * card's content), never in a collapsed trigger. See the popover call site for
 * what that costs when it leaks.
 *
 * `testId` and `className` are parameterised because the two containers differ
 * exactly there and nowhere else: a popover sized by its own `max-h` cap versus
 * a hover card that caps this list directly, and two surfaces that must stay
 * separately addressable in tests.
 */
export function PrOwnerTreeList(props: {
  readonly owners: readonly PrOwnerRef[];
  readonly label: string;
  readonly epicId: string;
  readonly fallbackHostId: string | null;
  readonly onOpened: () => void;
  readonly testId: string;
  readonly className: string | undefined;
}): ReactNode {
  // The same `parentId` links the sidebar's agent tree nests by, so a chat and
  // the sub-agents it spawned read as one lineage here too instead of as the
  // same title repeated once per child.
  const tree = useEpicTreeIndex();
  const { owners } = props;
  const forest = useMemo(() => buildPrOwnerTree(owners, tree), [owners, tree]);
  return (
    // `min-h-0` so this flex child may shrink below its content height - the
    // default `min-height: auto` would push the list back out to full height
    // and defeat the popover's cap.
    //
    // A plain nested list, NOT `role="tree"`. That role advertises a composite
    // widget - roving focus, arrow-key navigation, selection - and this list
    // has none of it: every row is a plain button, the forest is permanently
    // expanded, and nothing is ever selected. The nesting is the whole
    // message, and `<ul>`/`<li>` already carry it.
    <ul
      aria-label={props.label}
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-1",
        props.className,
      )}
      data-testid={props.testId}
    >
      {forest.map((node) => (
        <PrOwnerTreeItem
          key={prOwnerKey(node.owner)}
          node={node}
          depth={0}
          epicId={props.epicId}
          fallbackHostId={props.fallbackHostId}
          onOpened={props.onOpened}
        />
      ))}
    </ul>
  );
}

function PrOwnerBadge(props: {
  readonly owner: PrOwnerRef;
  readonly epicId: string;
  readonly fallbackHostId: string | null;
}): ReactNode {
  const { label, hostId, openOwner } = usePrOwnerResolution({
    owner: props.owner,
    epicId: props.epicId,
    fallbackHostId: props.fallbackHostId,
  });
  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      // The row itself opens the PR tile; a badge click means the OWNER.
      event.stopPropagation();
      openOwner();
    },
    [openOwner],
  );

  // A deleted owner renders NOTHING. `usePresentPrOwners` already dropped it
  // upstream, so this is the belt to that braces - reachable only if the
  // projection changes between the filter and this resolve. Rendering the old
  // "Removed chat" text here would put an untitled, unclickable entry back in a
  // row of pills, which is what it was removed for.
  if (label === null) return null;

  // Different cause, still a non-pill: `fallbackHostId` is nullable, so a legacy owner
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
      className="max-w-[min(60vw,16rem)] cursor-pointer font-normal text-muted-foreground hover:bg-foreground/8 hover:text-foreground"
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
          onClick={handleClick}
          data-testid="pr-owner-badge"
        >
          <span className="truncate">{label}</span>
        </button>
      </TooltipWrapper>
    </Badge>
  );
}

/**
 * How deep the popover keeps indenting before levels start sharing a column.
 *
 * The popover's width is capped, so an unbounded indent would eventually leave
 * a lineage's deepest rows with no room for their own title - the thing the
 * reader opened this list to read. Sizing to content buys those rows width up
 * to the cap but cannot buy them more than the cap. A spawn chain this deep is
 * already past what indentation alone can disambiguate; the guide rails still
 * stack.
 */
const MAX_OWNER_TREE_INDENT_DEPTH = 5;

/**
 * One owner and its owner-descendants, nested with the sidebar agent tree's
 * rail and indent arithmetic so the two surfaces render one hierarchy rather
 * than two dialects of it. The sidebar's `role="tree"` is deliberately NOT
 * carried over - see the list element for why.
 */
function PrOwnerTreeItem(props: {
  readonly node: PrOwnerTreeNode;
  readonly depth: number;
  readonly epicId: string;
  readonly fallbackHostId: string | null;
  readonly onOpened: () => void;
}): ReactNode {
  const indentDepth = Math.min(props.depth, MAX_OWNER_TREE_INDENT_DEPTH);
  const hasChildren = props.node.children.length > 0;
  return (
    <li>
      <PrOwnerRow
        owner={props.node.owner}
        depth={indentDepth}
        epicId={props.epicId}
        fallbackHostId={props.fallbackHostId}
        onOpened={props.onOpened}
      />
      {hasChildren ? (
        // `relative` is what `TreeGroupGuide` positions its rail against.
        <ul className="relative" data-testid="pr-owner-child-group">
          <TreeGroupGuide parentDepth={indentDepth} />
          {props.node.children.map((child) => (
            <PrOwnerTreeItem
              key={prOwnerKey(child.owner)}
              node={child}
              depth={props.depth + 1}
              epicId={props.epicId}
              fallbackHostId={props.fallbackHostId}
              onOpened={props.onOpened}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * One owner inside the overflow popover, shaped like a chats-menu row (kind
 * icon + title on one line) rather than a pill, because a vertical list of
 * pills reads as tags while this list is being scanned for a specific chat.
 *
 * Shares `PrOwnerBadge`'s resolution rules exactly: a deleted owner is not
 * rendered at all, and an owner with no resolvable host has a name but nothing
 * to open it on, so it demotes to muted, non-interactive text.
 */
function PrOwnerRow(props: {
  readonly owner: PrOwnerRef;
  readonly depth: number;
  readonly epicId: string;
  readonly fallbackHostId: string | null;
  readonly onOpened: () => void;
}): ReactNode {
  const { label, hostId, Icon, openOwner } = usePrOwnerResolution({
    owner: props.owner,
    epicId: props.epicId,
    fallbackHostId: props.fallbackHostId,
  });
  const { onOpened } = props;
  // Only reachable from the button below, which renders only when the owner
  // IS openable - so `openOwner`'s own guard cannot fire here.
  const openAndClose = useCallback((): void => {
    openOwner();
    onOpened();
  }, [onOpened, openOwner]);

  // Indent by the SAME arithmetic the sidebar tree rows use, so the icon column
  // a rail is drawn under (`TREE_GUIDE_OFFSET_PX`) lands on this row's icon too.
  const indent = {
    paddingLeft: `${props.depth * INDENT_PX + BASE_PAD_LEFT}px`,
  };

  // See `PrOwnerBadge`: upstream already dropped deleted owners, and a row with
  // no title is worth less than no row.
  if (label === null) return null;

  if (hostId === null) {
    return (
      <span
        style={indent}
        className="flex min-w-0 items-center gap-2 rounded py-1.5 pr-2 text-ui-xs text-muted-foreground/70"
        data-testid="pr-owner-row-unopenable"
      >
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{label}</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={openAndClose}
      aria-label={`Open ${label}`}
      data-testid="pr-owner-row"
      style={indent}
      className="flex w-full min-w-0 items-center gap-2 rounded py-1.5 pr-2 text-left text-ui-xs text-muted-foreground hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}
