import { useCallback, type ReactNode } from "react";
import { Lock } from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import { cn } from "@/lib/utils";
import { EPIC_NODE_ICONS } from "@/lib/artifacts/node-display";
import { rowIsLiveLineageOfLocalChat } from "@/lib/chats/unified-chat-list";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { useCompactRelativeTime } from "@/lib/relative-time";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { makePublishedChatTileRef } from "@/stores/epics/canvas/tile-schema/published-chat-tile";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { TreeChevronSpacer } from "@/components/ui/tree-chevron";
import {
  BASE_PAD_LEFT,
  INDENT_PX,
} from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";

/**
 * One agent in this task that lives on a host this device cannot reach.
 *
 * It sits in the SAME list as the local rows, in recency order, because a chat's
 * host is a property of the chat and not a place chats live. What marks it out
 * is its state, not its section: a lock glyph, and the owning host named beside
 * the title. Clicking it opens the ordinary chat surface, rendered from the last
 * copy that host published, with the composer locked.
 *
 * It is a LEAF. The cloud row carries a `parentChatId`, but the parent it names
 * is a chat on another machine that this device may not be able to see at all,
 * so a row that silently re-nested itself as a sibling loaded would be worse
 * than a flat one.
 */

/** Exactly what a local chat row draws - see the note at its use site. */
const ChatIcon = EPIC_NODE_ICONS.chat;

export interface EpicSidebarCloudChatRowProps {
  readonly chat: CloudChatSummary;
  /**
   * Publication identities of this device's own chats - the fold's own set.
   * A row opens live only if it IS one of them; see
   * `rowIsLiveLineageOfLocalChat`.
   */
  readonly publishedChatIds: ReadonlySet<string>;
  readonly epicId: string;
  readonly tabId: string;
  readonly depth: number;
}

export function EpicSidebarCloudChatRow(
  props: EpicSidebarCloudChatRowProps,
): ReactNode {
  const { chat } = props;
  const title = chat.title ?? "Untitled chat";
  // The APP-WIDE host, not `useTabHostId()`. The sidebar is not a tab - it sits
  // outside `<TabHostProvider>`, so a tab-scoped read throws here (it did) - and
  // the repo's host-scope split says exactly this: tiles read the tab's host,
  // app-wide surfaces read the active one. It is also the right host on the
  // merits: this only names which host will SERVE the cloud read, the read is a
  // byte pipe any reachable host can answer, and the tile the ref opens binds
  // its own tab's host for life regardless. The OWNING host below is metadata.
  const readingHostId = useReactiveActiveHostId() ?? UNKNOWN_HOST_PLACEHOLDER;
  const ownerReachability = useHostReachability(chat.ownerHostId);
  // The lock is the CHAT's state, not the row's category. A cloud row whose
  // owning host is reachable is an ordinary chat that simply is not on this
  // device's tree yet - it opens live, against the host that owns it, exactly
  // as a tree row would. Only an unreachable owner produces a locked row and
  // the published-copy surface behind it.
  const ownerReachable = ownerReachability.status === "reachable";
  // Reachable is NECESSARY but not SUFFICIENT. A host that answers may still
  // not hold this chat - most visibly when two dev slots share one host id, but
  // equally for a chat that host lost or a row that outlived it. The live tile
  // is record-backed, so opening one for a chat absent from this device's tree
  // produced nothing at all: the click was received and the canvas never
  // changed. Openable-live therefore means the chat is HERE and its owner
  // answers; everything else opens the published copy, which is the honest
  // surface for "this exists but not on this machine" and, unlike a no-op,
  // always renders something.
  // Live requires PROOF of same lineage, not a matching id: the same
  // host-minted id can name a collaborator's chat, and in the ticket's own fork
  // geometry both lineages share the id AND the user. The fold already computes
  // publication identity, so this asks it rather than re-deriving it.
  const opensLive =
    ownerReachable && rowIsLiveLineageOfLocalChat(chat, props.publishedChatIds);
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpenTilePreviewInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTilePreviewInTabFocusTarget,
  );
  const prepareOpenTileInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTileInTabFocusTarget,
  );

  const liveTileRef = useCallback(
    () => ({
      id: chat.identity.chatId,
      instanceId: uuidv4(),
      type: "chat" as const,
      name: title,
      // Binds the OWNING host, which is the one that can answer for this chat.
      hostId: chat.ownerHostId,
    }),
    [chat.identity.chatId, chat.ownerHostId, title],
  );

  const publishedTileRef = useCallback(
    () =>
      makePublishedChatTileRef({
        taskId: chat.identity.taskId,
        chatId: chat.identity.chatId,
        ownerUserId: chat.identity.ownerUserId,
        ownerHostId: chat.ownerHostId,
        name: title,
        hostId: readingHostId,
      }),
    [chat, title, readingHostId],
  );

  const open = useCallback(() => {
    const ref = opensLive ? liveTileRef() : publishedTileRef();
    navigateNested(props.epicId, props.tabId, () =>
      prepareOpenTilePreviewInTabFocusTarget(props.tabId, {
        ...ref,
        instanceId: uuidv4(),
      }),
    );
  }, [
    opensLive,
    liveTileRef,
    publishedTileRef,
    navigateNested,
    props.epicId,
    props.tabId,
    prepareOpenTilePreviewInTabFocusTarget,
  ]);

  const openPermanent = useCallback(() => {
    const ref = opensLive ? liveTileRef() : publishedTileRef();
    navigateNested(props.epicId, props.tabId, () =>
      prepareOpenTileInTabFocusTarget(props.tabId, {
        ...ref,
        instanceId: uuidv4(),
      }),
    );
  }, [
    opensLive,
    liveTileRef,
    publishedTileRef,
    navigateNested,
    props.epicId,
    props.tabId,
    prepareOpenTileInTabFocusTarget,
  ]);

  const ownerLabel = ownerReachability.hostLabel;
  const lockCopy = lockedRowCopy(ownerLabel, ownerReachable);
  return (
    <li role="treeitem" aria-selected={false}>
      <button
        type="button"
        aria-label={title}
        data-testid={`epic-sidebar-cloud-item-${chat.identity.chatId}`}
        data-owner-host-id={chat.ownerHostId}
        className={cn(
          "group/tree-item flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-2",
          "text-left text-ui-sm font-normal text-foreground/75 transition-colors",
          "hover:bg-accent/70 hover:text-accent-foreground",
          "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2",
        )}
        style={{
          paddingLeft: `${props.depth * INDENT_PX + BASE_PAD_LEFT}px`,
        }}
        onClick={open}
        onDoubleClick={openPermanent}
      >
        <TreeChevronSpacer />
        {/* The SAME icon a local chat row renders. A distinct glyph for
            "arrived via the cloud list" would re-encode the demolished "other
            devices" section as iconography - provenance, not state. State is
            the lock badge below; the cause stays in words (host chip, tooltip,
            composer notice). */}
        <ChatIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {/* The lock states what is true of the CHAT - its owner is out of
              reach - so it travels with the row rather than with a section, and
              it is absent when that is not true of this chat. */}
          {opensLive ? null : (
            <TooltipWrapper
              label={lockCopy.tooltip}
              side="right"
              sideOffset={undefined}
              align={undefined}
            >
              <Lock
                className="size-3 shrink-0 text-muted-foreground"
                data-testid={`epic-sidebar-cloud-lock-${chat.identity.chatId}`}
                aria-label={lockCopy.ariaLabel}
              />
            </TooltipWrapper>
          )}
          <CloudRowIdleTime
            publishedAt={chat.publishedAt ?? chat.metadataUpdatedAt}
          />
        </span>
      </button>
    </li>
  );
}

/**
 * Last-publication time on the same compact ladder the local rows use, in its
 * own leaf so the shared 60s clock tick repaints this span and not the row.
 */
function CloudRowIdleTime(props: {
  readonly publishedAt: number;
}): ReactNode {
  const relative = useCompactRelativeTime(props.publishedAt);
  return (
    <span
      className="flex-none tabular-nums text-ui-xs text-muted-foreground"
      data-testid="cloud-chat-row-idle-time"
    >
      {relative}
    </span>
  );
}

/**
 * What a locked row says about ITS state, in the two shapes a row can say it.
 *
 * Three-state like the tile's composer notice and derived from the same pair of
 * facts, because rendered copy is a consumer of that state exactly as the
 * routing is. Hardcoding "offline" here told a user a reachable host was down
 * and pointed them at a remedy - wake the machine - that would change nothing,
 * while the click beside it correctly opened the published copy.
 *
 * Shorter than the composer's wording on purpose: a tooltip states the fact, and
 * the surface the row opens explains it at length.
 */
function lockedRowCopy(
  ownerLabel: string,
  ownerIsReachable: boolean,
): { readonly tooltip: string; readonly ariaLabel: string } {
  if (ownerIsReachable) {
    return {
      tooltip: `Lives on ${ownerLabel}. Not available live from this device - opens read-only from the last published copy.`,
      ariaLabel: `On ${ownerLabel}, read-only`,
    };
  }
  return {
    tooltip: `Lives on ${ownerLabel}, which is offline. Opens read-only from the last published copy.`,
    ariaLabel: `On ${ownerLabel}, offline`,
  };
}
