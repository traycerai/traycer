import { TabIcon } from "@/components/epic-canvas/canvas/tab-strip";
import {
  terminalTabDisplayTitle,
  terminalTabUsesLegacyReads,
  useTerminalTabControl,
  type TerminalTabControl,
} from "@/components/epic-canvas/canvas/use-terminal-tab-control";
import {
  useBrowserTabPresentation,
  type BrowserTabPresentation,
} from "@/components/epic-canvas/canvas/browser-tab-presentation";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { ContentMinimapButton } from "@/components/minimap/content-minimap-button";
import { MobileLevel2MenuTrigger } from "@/components/layout/shell/mobile-level2";
import type { MobileLevel2Form } from "@/lib/layout/mobile-layout-form";
import { useChatStreamSyncState } from "@/hooks/chats/use-chat-stream-sync-state";
import { usePublishSurfaceSync } from "@/hooks/sync/use-publish-surface-sync";
import { useStreamSyncingSpell } from "@/hooks/sync/use-stream-syncing-spell";
import { SURFACE_SYNC_RANK } from "@/stores/sync/surface-sync-store";
import { NO_STREAM_SYNCING_SPELL } from "@/lib/sync/stream-syncing-state";
import "@/components/layout/shell/mobile-shell-touch-targets.css";
import {
  useEpicTabDisplayTitle,
  useEpicLiveArtifactTitleGenerating,
} from "@/lib/epic-selectors";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import type {
  BrowserSessionTileRef,
  EpicCanvasTileRef,
  EpicTerminalRef,
} from "@/stores/epics/canvas/types";

interface MobileCurrentTileBarProps {
  readonly epicId: string;
  readonly tile: EpicCanvasTileRef;
  readonly level2: MobileLevel2Form;
}

/**
 * The row naming the tile on screen: live icon, the display title, and - for a
 * tile whose content has an outline - the minimap button at the trailing edge.
 * It is also what reports a chat's stream to the app shell, so it renders in
 * every form of level 2.
 *
 * In the `bar` form it is the tile bar: switching tabs is the header's switcher
 * trigger, so it carries no BETWEEN-tile navigation; the minimap moves within
 * the tile already on screen, and the title is a label, never a control: a tap
 * on this bar is almost always a reach for the tile below it. Renaming a tile
 * lives in the switcher row's actions menu.
 *
 * Beside the column it is the pane's header and still a label. In the `menu`
 * form the icon and title are the trigger of the `MobileTileMenu` around it.
 *
 * Icon + title reuse the exact desktop tab-strip resolution (`TabIcon`,
 * `useEpicTabDisplayTitle`), including the terminal bound-host client so a
 * terminal tab shows its live host title rather than the stored name.
 */
export function MobileCurrentTileBar(props: MobileCurrentTileBarProps) {
  if (props.tile.type === "browser-session") {
    return <MobileBrowserCurrentTileBar {...props} tile={props.tile} />;
  }
  if (props.tile.type === "terminal") {
    // The terminal control resolves its authority through the tab-scoped host
    // (`useTabHostId`), exactly as the desktop strip's `TerminalTabItem` does,
    // and this bar sits outside every tile's own provider - so it binds one
    // itself. Without it the bar throws above the tile's error boundary, and
    // every reload re-selects the same terminal tile and throws again.
    return (
      <TabHostProvider hostId={props.tile.hostId}>
        <MobileTerminalCurrentTileBar {...props} tile={props.tile} />
      </TabHostProvider>
    );
  }
  return (
    <MobileCurrentTileBarBody
      {...props}
      browserPresentation={null}
      terminalControl={null}
    />
  );
}

/**
 * A terminal's title goes through its host authority, as the tab strip's does:
 * the plain verbs on a capable host, the legacy `terminal.list` only on a host
 * without them (the Automations host serves the plain verbs alone).
 */
function MobileTerminalCurrentTileBar(
  props: Omit<MobileCurrentTileBarProps, "tile"> & {
    readonly tile: EpicTerminalRef;
  },
) {
  const terminalControl = useTerminalTabControl(props.epicId, props.tile);
  return (
    <MobileCurrentTileBarBody
      {...props}
      browserPresentation={null}
      terminalControl={terminalControl}
    />
  );
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
      terminalControl={null}
    />
  );
}

function MobileCurrentTileBarBody(
  props: MobileCurrentTileBarProps & {
    readonly browserPresentation: BrowserTabPresentation | null;
    readonly terminalControl: TerminalTabControl | null;
  },
) {
  const { epicId, tile, level2, browserPresentation, terminalControl } = props;
  const isTerminal = tile.type === "terminal";
  // Terminal titles resolve against the tab's bound host; `null` for every
  // other kind (mirrors the tab strip). `useHostClientForHostId(null)` returns
  // the DEFAULT client, so the non-terminal branch must pass null explicitly.
  const resolvedHostClient = useHostClientForHostId(
    isTerminal ? tile.hostId : null,
  );
  // The legacy reads only for a host without the plain verbs, as the tab strip.
  const terminalHostClient =
    isTerminal && terminalTabUsesLegacyReads(terminalControl)
      ? resolvedHostClient
      : null;
  const fallbackDisplayTitle = useEpicTabDisplayTitle(
    {
      id: tile.id,
      name: tile.name,
      type: tile.type,
      hostId: tile.hostId,
    },
    epicId,
    terminalHostClient,
  );
  const titleGenerationPending = useEpicLiveArtifactTitleGenerating(
    tile.type === "chat" ? tile.id : null,
    epicId,
    tile.hostId,
  );
  const displayTitle =
    browserPresentation?.title ??
    terminalTabDisplayTitle(terminalControl, fallbackDisplayTitle);

  // A chat is the one tile kind whose own stream can be away while its content
  // stays on screen with nothing said about it. Terminals already overlay
  // theirs, a shell window already banners its own, and every artifact kind is
  // served by the Epic stream the outer strip covers. `null` for the rest, so
  // the hook is unconditional and simply resolves no session.
  const isChat = tile.type === "chat";
  const chatSync = useChatStreamSyncState(
    epicId,
    tile.id,
    isChat ? tile.hostId : null,
  );
  // Run the clock on THIS chat's outage whether or not the strip is drawn. The
  // suppression below hides the strip while the Epic's is speaking, and the
  // Epic's stream typically returns first: a clock that lived inside the hidden
  // strip would start over at that hand-off, so one continuous chat outage
  // would read as a fresh "Syncing…" a minute in, and would set its animation
  // running again past the bound the escalation exists to impose. Keyed on the
  // tile's host and id, so swiping to a different chat starts a new spell
  // instead of inheriting this one's verdict.
  const chatSpell = useStreamSyncingSpell({
    status: chatSync.status,
    hasContent: chatSync.hasContent,
    identity: `chat:${tile.hostId}:${tile.id}`,
  });
  // REPORTED, not rendered. The one indicator lives in the app shell, which
  // orders this against the session and Epic legs by rank - so there is no
  // suppression to coordinate here, and a hand-off changes what the indicator
  // says rather than which element says it.
  //
  // A non-chat tile publishes a spell that never runs. Its stream is either
  // covered by the Epic's report (every artifact kind), or already narrated by
  // the tile itself (a terminal's overlay, a shell window's banner).
  usePublishSurfaceSync({
    // Host-scoped: a chat id is host-minted, so the same id names a different
    // conversation on another machine.
    key: `chat:${tile.hostId}:${tile.id}`,
    rank: SURFACE_SYNC_RANK.chat,
    label: "Chat",
    spell: isChat ? chatSpell : NO_STREAM_SYNCING_SPELL,
    wake: isChat ? chatSync.wake : null,
  });

  const icon = (
    <TabIcon
      epicId={epicId}
      tab={tile}
      titleGenerationPending={titleGenerationPending}
      browserPresentation={browserPresentation}
    />
  );
  const title = (
    <span
      data-testid="mobile-current-tile-title"
      className="min-w-0 flex-1 truncate text-ui-sm font-medium text-foreground"
    >
      {displayTitle}
    </span>
  );

  return (
    <div
      data-mobile-shell-touch-scope=""
      className="shrink-0 border-b border-canvas-border/70 bg-canvas"
    >
      <div
        data-testid={
          level2 === "bar"
            ? "mobile-current-tile-bar"
            : "mobile-tile-pane-header"
        }
        className="flex min-h-11 w-full items-center gap-2 px-3"
      >
        {level2 === "menu" ? (
          <MobileLevel2MenuTrigger
            testId="mobile-tile-menu-trigger"
            className="mr-auto"
          >
            {icon}
            {title}
          </MobileLevel2MenuTrigger>
        ) : (
          <>
            {icon}
            {title}
          </>
        )}
        <ContentMinimapButton tileInstanceId={tile.instanceId} />
      </div>
    </div>
  );
}
