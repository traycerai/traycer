/**
 * Canvas tile-kind render registry.
 *
 * Maps every `TileKindId` to a renderer typed against that kind's own ref
 * (`{ [K in TileKindId]: TileRenderer<TileKindToRefMap[K]> }`), so a
 * missing kind fails the build and each renderer receives a correctly
 * narrowed `node`. `renderTile` is the single dispatch point - there is
 * no per-kind branching outside this table.
 */
import type { ReactNode } from "react";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { TileFindScope } from "@/components/epic-canvas/tile-find/tile-find-scope";
import { TileMinimapScope } from "@/components/epic-canvas/tile-minimap/tile-minimap-scope";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import type { TileKindId } from "@/stores/epics/canvas/tile-kinds";
import type { TileKindToRefMap } from "@/stores/epics/canvas/tile-kind-types";
import { LinkTargetProvider } from "@/lib/links/link-target-provider";
import { BrowserSessionsHostBoundary } from "./browser-sessions-provider";
import { BrowserSessionTile } from "./browser-session-tile";
import { ChatTile } from "./chat-tile";
import { ReviewTile } from "./review-tile";
import { SpecTile } from "./spec-tile";
import { StoryTile } from "./story-tile";
import { TerminalTile } from "./terminal-tile";
import { TuiAgentTile } from "./tui-agent-tile";
import { TicketTile } from "./ticket-tile";
import { WorkspaceFileTile } from "./workspace-file-tile";
import { GitDiffTile } from "./git-diff-tile";
import { SnapshotDiffTile } from "./snapshot-diff-tile";
import { ManagedCommandOutputTile } from "./managed-command-output-tile";
import { CommGraphTile } from "./comm-graph-tile";
import { PublishedChatTile } from "./published-chat-tile";
import { PrDetailTile } from "./pr-detail-tile";
import { PrDiffTile } from "./pr-diff-tile";
import { PaneOpener } from "@/components/epic-canvas/canvas/pane-opener";

export interface TileRenderArgs<R extends EpicCanvasTileRef> {
  readonly node: R;
  readonly viewTabId: string;
  readonly tileId: string;
  /** Epic that owns this tile's tab. Needed by the blank tile's inline opener. */
  readonly epicId: string;
  readonly isActive: boolean;
}

type TileRenderer<R extends EpicCanvasTileRef> = (
  args: TileRenderArgs<R>,
) => ReactNode;

type TileRendererRegistry = {
  readonly [K in TileKindId]: TileRenderer<TileKindToRefMap[K]>;
};

const TILE_RENDERERS: TileRendererRegistry = {
  chat: ({ node, viewTabId, tileId, isActive }) => (
    <ChatTile
      node={node}
      viewTabId={viewTabId}
      tileId={tileId}
      isActive={isActive}
    />
  ),
  "terminal-agent": ({ node, viewTabId, tileId, isActive }) => (
    <TuiAgentTile
      node={node}
      viewTabId={viewTabId}
      tileId={tileId}
      isActive={isActive}
    />
  ),
  spec: ({ node, viewTabId, tileId, isActive }) => (
    <SpecTile
      node={node}
      viewTabId={viewTabId}
      tileId={tileId}
      isActive={isActive}
    />
  ),
  ticket: ({ node, viewTabId, tileId, isActive }) => (
    <TicketTile
      node={node}
      viewTabId={viewTabId}
      tileId={tileId}
      isActive={isActive}
    />
  ),
  story: ({ node, viewTabId, tileId, isActive }) => (
    <StoryTile
      node={node}
      viewTabId={viewTabId}
      tileId={tileId}
      isActive={isActive}
    />
  ),
  review: ({ node, viewTabId, tileId, isActive }) => (
    <ReviewTile
      node={node}
      viewTabId={viewTabId}
      tileId={tileId}
      isActive={isActive}
    />
  ),
  terminal: ({ node, viewTabId, tileId, isActive }) => (
    <TerminalTile
      node={node}
      viewTabId={viewTabId}
      tileId={tileId}
      isActive={isActive}
    />
  ),
  "browser-session": ({ node, viewTabId, tileId, epicId }) => (
    <BrowserSessionTile
      node={node}
      viewTabId={viewTabId}
      paneId={tileId}
      epicId={epicId}
    />
  ),
  "workspace-file": ({ node, viewTabId, isActive }) => (
    <WorkspaceFileTile node={node} viewTabId={viewTabId} isActive={isActive} />
  ),
  "git-diff": ({ node, viewTabId, tileId, isActive }) => (
    <GitDiffTile
      node={node}
      viewTabId={viewTabId}
      tileId={tileId}
      isActive={isActive}
    />
  ),
  "snapshot-diff": ({ node, viewTabId }) => (
    <SnapshotDiffTile node={node} viewTabId={viewTabId} />
  ),
  "managed-command-output": ({ node, viewTabId, tileId, epicId }) => (
    <ManagedCommandOutputTile
      node={node}
      viewTabId={viewTabId}
      tileId={tileId}
      epicId={epicId}
    />
  ),
  // Epic-scoped, not host-scoped: the tile fans a subscription out per host.
  // The surrounding `TabHostProvider` carries the ref's inert placeholder host
  // and this body never reads it.
  "comm-graph": ({ node, viewTabId }) => (
    <CommGraphTile node={node} viewTabId={viewTabId} />
  ),
  // The ordinary chat surface fed from a published copy - see the tile's own
  // note. Bound, like every tile, to the tab's host: that host SERVES the cloud
  // read, and the chat's owning host is metadata the locked composer names.
  "published-chat": ({ node, epicId, viewTabId, tileId, isActive }) => (
    <PublishedChatTile
      node={node}
      epicId={epicId}
      viewTabId={viewTabId}
      tileId={tileId}
      isActive={isActive}
    />
  ),
  "pr-detail": ({ node, epicId, viewTabId, isActive }) => (
    <PrDetailTile
      node={node}
      epicId={epicId}
      viewTabId={viewTabId}
      isActive={isActive}
    />
  ),
  "pr-diff": ({ node, epicId, viewTabId, isActive }) => (
    <PrDiffTile
      node={node}
      epicId={epicId}
      viewTabId={viewTabId}
      isActive={isActive}
    />
  ),
  // A blank tab's body IS the inline opener; picking content replaces it in
  // place (via openTileInPane). `tileId` is the group id; `isActive` drives
  // the opener's autofocus.
  blank: ({ viewTabId, tileId, epicId, isActive }) => (
    <PaneOpener
      epicId={epicId}
      tabId={viewTabId}
      groupId={tileId}
      active={isActive}
    />
  ),
};

function tileRenderer<K extends TileKindId>(
  kind: K,
): TileRenderer<TileKindToRefMap[K]> {
  return TILE_RENDERERS[kind];
}

/**
 * Render any canvas tile. Wraps the kind-specific body in
 * `<TabHostProvider>` so every tile reads its bound host via
 * `useTabHostId()`, in `<LinkTargetProvider>` so an in-app link opens on this
 * tile's own canvas tab, and in `<BrowserSessionsHostBoundary>` so everything
 * inside the tile - link opening, terminal OSC-8 links, the browser tile
 * itself - reads the sessions stream of the TILE's host rather than the
 * canvas host's. Without it a tile on a remote host sees the canvas host's
 * stream, and every consumer that compares the two has to fall back; the
 * boundary makes that mismatch impossible instead of handled per surface.
 * It is a no-op when the tile is on the canvas host, and coordinators are
 * refcounted, so N tiles on one host share one stream.
 *
 * Accepted cost: the coordinator is acquired EAGERLY while the tile is
 * mounted - a lazy one would not be live at click time, so the first link
 * click would still fall out to the OS browser. A tile on a host that is
 * asleep therefore holds a capped-backoff (1s→30s) reconnect loop, one socket
 * per host per epic. Gating on reachability was rejected: stale or pending
 * reachability reintroduces exactly the first-click failure this closes.
 */
export function renderTile(args: TileRenderArgs<EpicCanvasTileRef>): ReactNode {
  return (
    <TabHostProvider hostId={args.node.hostId}>
      <BrowserSessionsHostBoundary
        hostId={args.node.hostId}
        epicId={args.epicId}
      >
        <LinkTargetProvider epicId={args.epicId} viewTabId={args.viewTabId}>
          <TileFindScope
            node={args.node}
            viewTabId={args.viewTabId}
            tileId={args.tileId}
            epicId={args.epicId}
            isActive={args.isActive}
          >
            <TileMinimapScope tileInstanceId={args.node.instanceId}>
              {tileRenderer(args.node.type)(args)}
            </TileMinimapScope>
          </TileFindScope>
        </LinkTargetProvider>
      </BrowserSessionsHostBoundary>
    </TabHostProvider>
  );
}
