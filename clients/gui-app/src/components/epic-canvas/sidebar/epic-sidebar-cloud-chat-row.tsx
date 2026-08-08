import { useCallback, type ReactNode } from "react";
import { Lock, MessagesSquare } from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import { cn } from "@/lib/utils";
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

export interface EpicSidebarCloudChatRowProps {
  readonly chat: CloudChatSummary;
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
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpenTilePreviewInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTilePreviewInTabFocusTarget,
  );
  const prepareOpenTileInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTileInTabFocusTarget,
  );

  const tileRef = useCallback(
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
    const ref = tileRef();
    navigateNested(props.epicId, props.tabId, () =>
      prepareOpenTilePreviewInTabFocusTarget(props.tabId, {
        ...ref,
        instanceId: uuidv4(),
      }),
    );
  }, [
    tileRef,
    navigateNested,
    props.epicId,
    props.tabId,
    prepareOpenTilePreviewInTabFocusTarget,
  ]);

  const openPermanent = useCallback(() => {
    const ref = tileRef();
    navigateNested(props.epicId, props.tabId, () =>
      prepareOpenTileInTabFocusTarget(props.tabId, {
        ...ref,
        instanceId: uuidv4(),
      }),
    );
  }, [
    tileRef,
    navigateNested,
    props.epicId,
    props.tabId,
    prepareOpenTileInTabFocusTarget,
  ]);

  const ownerLabel = ownerReachability.hostLabel;
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
        <MessagesSquare className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {/* The lock states what is true of the CHAT - its owner is out of
              reach - so it travels with the row rather than with a section. */}
          <TooltipWrapper
            label={`Lives on ${ownerLabel}, which is offline. Opens read-only from the last published copy.`}
            side="right"
            sideOffset={undefined}
            align={undefined}
          >
            <Lock
              className="size-3 shrink-0 text-muted-foreground"
              data-testid={`epic-sidebar-cloud-lock-${chat.identity.chatId}`}
              aria-label={`On ${ownerLabel}, offline`}
            />
          </TooltipWrapper>
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
