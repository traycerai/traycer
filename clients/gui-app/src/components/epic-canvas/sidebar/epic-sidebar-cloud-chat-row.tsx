import { useCallback, type ReactNode } from "react";
import { Lock } from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import { cn } from "@/lib/utils";
import { EPIC_NODE_ICONS } from "@/lib/artifacts/node-display";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { useCompactRelativeTime } from "@/lib/relative-time";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";
import {
  useEpicCanvasStore,
  useIsActiveEpicArtifact,
  useIsActiveTile,
} from "@/stores/epics/canvas/store";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import {
  makePublishedChatTileRef,
  publishedChatTileId,
} from "@/stores/epics/canvas/tile-schema/published-chat-tile";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { TreeChevronSpacer } from "@/components/ui/tree-chevron";
import {
  BASE_PAD_LEFT,
  INDENT_PX,
  useNodeIconDisplay,
} from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";

/**
 * One agent in this task that lives on a host this device cannot reach.
 *
 * It sits in the SAME list as the local rows, in recency order, because a chat's
 * host is a property of the chat and not a place chats live. What marks it out
 * is its state, not its section: a REACHABLE owner's chat opens live, bound to
 * the host that owns it, exactly as a tree row would; an unreachable owner's
 * chat gets a lock glyph and opens the ordinary chat surface rendered from the
 * last copy that host published, with the composer locked.
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
  readonly epicId: string;
  readonly tabId: string;
  readonly depth: number;
  /**
   * Whether the sidebar is in bulk-selection mode. A cloud row is not
   * selectable - the bulk actions are archive and delete, and neither belongs to
   * a chat this device does not own - so it goes INERT rather than opening a
   * tile: navigating away mid-selection is the one thing a click here must not
   * do while the user is picking rows.
   */
  readonly selectionMode: boolean;
}

export function EpicSidebarCloudChatRow(
  props: EpicSidebarCloudChatRowProps,
): ReactNode {
  const { chat } = props;
  const title = chat.title ?? "Untitled chat";
  // The Epic SESSION's host - not `useTabHostId()`, and not the app-wide one.
  // The sidebar is not a tab (it sits outside every `<TabHostProvider>`, so a
  // tab-scoped read throws here - it did), and it is not an app-wide surface
  // either: it is the third host role, the Epic session's, and this row is
  // projected by that session. This id only names which host will SERVE the
  // cloud read - a byte pipe any reachable host can answer - so the one host
  // known to be serving this sidebar is the honest choice; the app-wide
  // pointer names, for the whole of a re-point in flight, a machine that may
  // not be answering yet, and the tile this ref opens binds that id for life.
  // The OWNING host below is metadata.
  const readingHostId = useEpicSessionHostId() ?? UNKNOWN_HOST_PLACEHOLDER;
  // The SAME tint rule a local chat row's idle glyph resolves (settings-driven
  // per-type color, muted only when the user turns icon colors off). A
  // hardcoded muted class here made the icon column encode row ORIGIN - local
  // rows colored, cloud rows grey - when read-only-ness is the lock badge's
  // job and provenance is nobody's.
  const chatIconDisplay = useNodeIconDisplay("chat");
  const ownerReachability = useHostReachability(chat.ownerHostId);
  // The lock is the CHAT's state, not the row's category. A cloud row whose
  // owning host is reachable is an ordinary chat that simply is not on this
  // device's tree yet - it opens live, against the host that owns it, exactly
  // as a tree row would. Only an unreachable owner produces a locked row and
  // the published-copy surface behind it.
  const ownerReachable = ownerReachability.status === "reachable";
  // Openable-live = the owner answers. Host ids are unique (2026-08-07
  // ruling), so a reachable owner IS the machine that holds this chat, and
  // the click opens the ordinary live surface bound to it - the tile
  // subscribes against the owner host directly and no longer needs the chat
  // in this device's projection (its record gate admits cross-host opens).
  // The one residual: a fork-redirected row publishes under a clone id the
  // owner has no local chat for, so its live open surfaces the host's
  // refusal in the tile rather than a transcript - rare, visible, and
  // strictly better than routing every reachable-owner chat to a stale
  // read-only copy. An unreachable owner keeps the locked published copy.
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpenTilePreviewInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTilePreviewInTabFocusTarget,
  );
  const prepareOpenTileInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTileInTabFocusTarget,
  );

  // Whether this tab is showing THIS row's chat - in either of the two forms a
  // click below can open it. A live open is an ordinary record-backed chat
  // tile, so it matches by artifact id; the bare-chatId match shares the
  // documented bounded same-minted-chatId collision the union byId already
  // carries. A published copy is deliberately NOT record-backed, so the
  // artifact selector reads null for it and only its composite tile id can
  // match.
  const isActiveLive = useIsActiveEpicArtifact(
    props.tabId,
    chat.identity.chatId,
  );
  const isActivePublished = useIsActiveTile(
    props.tabId,
    publishedChatTileId(chat.identity),
  );
  const isActive = isActiveLive || isActivePublished;

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

  // The ordinary live chat ref, bound to the OWNER host - byte-identical to
  // what a tree row opens for its own chats, which is the point: a reachable
  // host's chat is an ordinary chat, wherever the click came from.
  const liveTileRef = useCallback(
    () => ({
      id: chat.identity.chatId,
      type: "chat" as const,
      name: title,
      hostId: chat.ownerHostId,
    }),
    [chat, title],
  );

  const openRef = useCallback(
    () => (ownerReachable ? liveTileRef() : publishedTileRef()),
    [ownerReachable, liveTileRef, publishedTileRef],
  );

  const open = useCallback(() => {
    const ref = openRef();
    navigateNested(props.epicId, props.tabId, () =>
      prepareOpenTilePreviewInTabFocusTarget(props.tabId, {
        ...ref,
        instanceId: uuidv4(),
      }),
    );
  }, [
    openRef,
    navigateNested,
    props.epicId,
    props.tabId,
    prepareOpenTilePreviewInTabFocusTarget,
  ]);

  const openPermanent = useCallback(() => {
    const ref = openRef();
    navigateNested(props.epicId, props.tabId, () =>
      prepareOpenTileInTabFocusTarget(props.tabId, {
        ...ref,
        instanceId: uuidv4(),
      }),
    );
  }, [
    openRef,
    navigateNested,
    props.epicId,
    props.tabId,
    prepareOpenTileInTabFocusTarget,
  ]);

  const ownerLabel = ownerReachability.hostLabel;
  const lockCopy = lockedRowCopy(ownerLabel);
  return (
    <li role="treeitem" aria-selected={isActive}>
      <button
        type="button"
        // The lock is state, not decoration, so it belongs in the row's
        // ACCESSIBLE NAME. An `aria-label` on the glyph inside a labelled button
        // never surfaces, and the tooltip is hover-only - which left a locked row
        // announcing exactly like a live one, though the two open different
        // surfaces.
        aria-label={ownerReachable ? title : `${title} — ${lockCopy.ariaLabel}`}
        data-testid={`epic-sidebar-cloud-item-${chat.identity.chatId}`}
        data-owner-host-id={chat.ownerHostId}
        className={cn(
          "group/tree-item flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-2",
          "text-left text-ui-sm font-normal transition-colors",
          "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2",
          // The SAME two arms a tree row's chatRowClassName resolves, verbatim.
          isActive
            ? "bg-accent text-accent-foreground"
            : "text-foreground/75 hover:bg-accent/70 hover:text-accent-foreground",
        )}
        style={{
          paddingLeft: `${props.depth * INDENT_PX + BASE_PAD_LEFT}px`,
        }}
        onClick={props.selectionMode ? undefined : open}
        onDoubleClick={props.selectionMode ? undefined : openPermanent}
      >
        <TreeChevronSpacer />
        {/* The SAME icon a local chat row renders - glyph AND tint. A distinct
            glyph or a muted tint for "arrived via the cloud list" would
            re-encode the demolished "other devices" section as iconography -
            provenance, not state. State is the lock badge below; the cause
            stays in words (host chip, tooltip, composer notice). */}
        <ChatIcon
          aria-hidden
          className={chatIconDisplay.className}
          style={chatIconDisplay.style}
        />
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {/* The lock states what is true of the CHAT - its owner is out of
              reach - so it travels with the row rather than with a section, and
              it is absent when that is not true of this chat. */}
          {ownerReachable ? null : (
            <TooltipWrapper
              label={lockCopy.tooltip}
              side="right"
              sideOffset={undefined}
              align={undefined}
            >
              <Lock
                className="size-3 shrink-0 text-muted-foreground"
                data-testid={`epic-sidebar-cloud-lock-${chat.identity.chatId}`}
                // Decorative here: the state it depicts is in the row's own
                // accessible name above, and a graphics node inside a labelled
                // button contributes nothing but noise.
                aria-hidden="true"
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
function CloudRowIdleTime(props: { readonly publishedAt: number }): ReactNode {
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
 * What a locked row says about its owner.
 *
 * A row is locked exactly when its owning host is unreachable, so there is one
 * thing to say and one wording for it. The longer explanation lives on the
 * surface the row opens; a tooltip states the fact.
 */
function lockedRowCopy(ownerLabel: string): {
  readonly tooltip: string;
  readonly ariaLabel: string;
} {
  return {
    tooltip: `Lives on ${ownerLabel}, which is offline. Opens read-only from the last published copy.`,
    ariaLabel: `On ${ownerLabel}, offline`,
  };
}
