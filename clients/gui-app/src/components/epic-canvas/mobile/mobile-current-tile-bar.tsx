import { useCallback } from "react";
import { TabIcon } from "@/components/epic-canvas/canvas/tab-strip";
import {
  useBrowserTabPresentation,
  type BrowserTabPresentation,
} from "@/components/epic-canvas/canvas/browser-tab-presentation";
import { InlineTitleField } from "@/components/epic-canvas/mobile/inline-title-field";
import { ContentMinimapButton } from "@/components/minimap/content-minimap-button";
import { StreamSyncingBar } from "@/components/sync/stream-syncing-bar";
import { useChatStreamSyncState } from "@/hooks/chats/use-chat-stream-sync-state";
import { useStreamSyncingSpell } from "@/hooks/sync/use-stream-syncing-spell";
import {
  tileRenameKind,
  useSwitcherRename,
} from "@/components/epic-canvas/mobile/use-switcher-rename";
import "@/components/layout/shell/mobile-shell-touch-targets.css";
import {
  useEpicPermissionRole,
  useEpicTabDisplayTitle,
  useEpicLiveArtifactTitleGenerating,
} from "@/lib/epic-selectors";
import { isEditableRole } from "@/lib/epic-permissions";
import { useChatWriteRoute } from "@/hooks/epic/use-chat-write-route";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import type {
  BrowserSessionTileRef,
  EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";

interface MobileCurrentTileBarProps {
  readonly epicId: string;
  readonly tile: EpicCanvasTileRef;
  /**
   * Whether the Epic's own strip is currently showing - the DECIDED answer,
   * passed down rather than re-derived here. Re-deriving it from the legs
   * behind it would be a second decider that can disagree with the first for a
   * frame, and that frame is the one in which both strips paint.
   */
  readonly epicStripShowing: boolean;
}

/**
 * Slim bar under the mobile header naming the tile on screen: live icon, the
 * display title, and - for a tile whose content has an outline - the minimap
 * button at the trailing edge. Switching tabs is the header's switcher
 * trigger, so this bar carries no BETWEEN-tile navigation; the minimap moves
 * within the tile already on screen.
 *
 * The title renames in place for every kind that has a name of its own
 * (agents, artifacts, raw terminals) and an editor's permission; anything else
 * reads as plain text, matching what the switcher rows offer for the same item.
 *
 * Icon + title reuse the exact desktop tab-strip resolution (`TabIcon`,
 * `useEpicTabDisplayTitle`), including the terminal bound-host client so a
 * terminal tab shows its live host title rather than the stored name.
 */
export function MobileCurrentTileBar(props: MobileCurrentTileBarProps) {
  if (props.tile.type === "browser-session") {
    return <MobileBrowserCurrentTileBar {...props} tile={props.tile} />;
  }
  return <MobileCurrentTileBarBody {...props} browserPresentation={null} />;
}

function MobileBrowserCurrentTileBar(
  props: Omit<MobileCurrentTileBarProps, "tile"> & {
    readonly tile: BrowserSessionTileRef;
  },
) {
  const browserPresentation = useBrowserTabPresentation(
    props.tile,
    props.epicId,
  );
  return (
    <MobileCurrentTileBarBody
      {...props}
      browserPresentation={browserPresentation}
    />
  );
}

function MobileCurrentTileBarBody(
  props: MobileCurrentTileBarProps & {
    readonly browserPresentation: BrowserTabPresentation | null;
  },
) {
  const { epicId, tile, browserPresentation } = props;
  const isTerminal = tile.type === "terminal";
  // Terminal titles resolve against the tab's bound host; `null` for every
  // other kind (mirrors the tab strip). `useHostClientForHostId(null)` returns
  // the DEFAULT client, so the non-terminal branch must pass null explicitly.
  const resolvedHostClient = useHostClientForHostId(
    isTerminal ? tile.hostId : null,
  );
  const terminalHostClient = isTerminal ? resolvedHostClient : null;
  const fallbackDisplayTitle = useEpicTabDisplayTitle(
    {
      id: tile.id,
      name: tile.name,
      type: tile.type,
      hostId: "hostId" in tile ? tile.hostId : null,
    },
    epicId,
    terminalHostClient,
  );
  const titleGenerationPending = useEpicLiveArtifactTitleGenerating(
    tile.type === "chat" ? tile.id : null,
  );
  const displayTitle = browserPresentation?.title ?? fallbackDisplayTitle;

  const renameKind = tileRenameKind(tile);
  const canMutate = isEditableRole(useEpicPermissionRole());
  // An unadopted chat's title must not become EDITABLE. Refusing at commit
  // would silently discard what the user typed; refusing to enter edit mode
  // tells them before they type, which is the same rule the sidebar's
  // disabled Rename entry follows.
  const chatWriteRoute = useChatWriteRoute(tile.type === "chat", tile.id);
  const editable =
    renameKind !== null && canMutate && chatWriteRoute !== "unavailable";
  const rename = useSwitcherRename(epicId);
  const handleCommit = useCallback(
    (next: string) => {
      if (renameKind === null) return;
      rename(renameKind, tile.id, next);
    },
    [rename, renameKind, tile.id],
  );
  // A chat is the one tile kind whose own stream can be away while its content
  // stays on screen with nothing said about it. Terminals already overlay
  // theirs, a shell window already banners its own, and every artifact kind is
  // served by the Epic stream the outer strip covers. `null` for the rest, so
  // the hook is unconditional and simply resolves no session.
  const isChat = tile.type === "chat";
  const chatSync = useChatStreamSyncState(
    epicId,
    tile.id,
    isChat && "hostId" in tile ? tile.hostId : null,
  );
  // Run the clock on THIS chat's outage whether or not the strip is drawn. The
  // suppression below hides the strip while the Epic's is speaking, and the
  // Epic's stream typically returns first: a clock that lived inside the hidden
  // strip would start over at that hand-off, so one continuous chat outage
  // would read as a fresh "Syncing…" a minute in, and would set its animation
  // running again past the bound the escalation exists to impose. Keyed on the
  // tile's id, so swiping to a different chat starts a new spell instead of
  // inheriting this one's verdict.
  const chatSpell = useStreamSyncingSpell({
    status: chatSync.status,
    hasContent: chatSync.hasContent,
    identity: tile.id,
  });
  // ONE strip on screen at a time. On an app switch every stream is pushed to
  // `reconnecting` in the same tick, so without this the Epic's strip and the
  // chat's would appear together saying the same thing twice. The outer surface
  // wins while it is speaking; when the Epic's stream returns first, this takes
  // over - carrying however far its own spell had already run - and keeps
  // saying it until the transcript itself is current. The user therefore sees
  // exactly one strip, from the first drop until everything on screen is fresh.
  //
  // The kind is re-checked here rather than left to the `null` host above. A
  // resolver returning nothing for a non-chat tile is the mechanism, not the
  // rule, and the rule belongs where the strip is decided: a future resolver
  // that answered a spec id from some other table would otherwise put a chat's
  // reconnect banner on an artifact with nothing to say.
  const showChatStrip = isChat && !props.epicStripShowing && chatSpell.syncing;

  return (
    <div
      data-mobile-shell-touch-scope=""
      className="shrink-0 border-b border-canvas-border/70 bg-canvas"
    >
      <div
        data-testid="mobile-current-tile-bar"
        className="flex min-h-11 w-full items-center gap-2 px-3"
      >
        <TabIcon
          epicId={epicId}
          tab={tile}
          titleGenerationPending={titleGenerationPending}
          browserPresentation={browserPresentation}
        />
        <InlineTitleField
          value={displayTitle}
          editable={editable}
          onCommit={handleCommit}
          inputLabel="Tab title"
          testId="mobile-current-tile-title"
          className="min-w-0 flex-1 truncate text-ui-sm font-medium text-foreground"
        />
        <ContentMinimapButton tileInstanceId={tile.instanceId} />
      </div>
      {/* Under the row, inside the bar's own border, so the strip reads as the
          header's lower edge rather than as a banner floating over the tile. */}
      {showChatStrip ? (
        <StreamSyncingBar
          spell={chatSpell}
          surfaceLabel="Chat"
          testId="chat-stream-syncing-bar"
        />
      ) : null}
    </div>
  );
}
