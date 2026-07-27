import { useCallback, type MouseEvent, type ReactNode } from "react";
import { v4 as uuidv4 } from "uuid";
import type { PrOwnerRef } from "@traycer/protocol/host/pr-schemas";
import { Badge } from "@/components/ui/badge";
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
 * The chats/terminal agents a PR was derived from, as badges that open their
 * own tile - the same affordance the Worktrees panel gives a worktree's owning
 * Task, so "which conversation produced this?" is one click away rather than a
 * name you have to go find.
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
  return (
    <span
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-1",
        props.className,
      )}
      data-testid="pr-owner-badges"
    >
      {props.owners.map((owner) => (
        <PrOwnerBadge
          key={`${owner.ownerKind}:${owner.ownerId}`}
          owner={owner}
          epicId={props.epicId}
          fallbackHostId={props.fallbackHostId}
        />
      ))}
    </span>
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
