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
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import type { TileKindId } from "@/stores/epics/canvas/tile-kinds";
import type { TileKindToRefMap } from "@/stores/epics/canvas/tile-kind-types";
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
import { DeletedArtifactsTile } from "./deleted-artifacts-tile";
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
  chat: ({ node, viewTabId, isActive }) => (
    <ChatTile node={node} viewTabId={viewTabId} isActive={isActive} />
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
  "deleted-artifacts": ({ node }) => <DeletedArtifactsTile node={node} />,
  // The ordinary chat surface fed from a published copy - see the tile's own
  // note. Bound, like every tile, to the tab's host: that host SERVES the cloud
  // read, and the chat's owning host is metadata the locked composer names.
  "published-chat": ({ node, epicId, viewTabId, isActive }) => (
    <PublishedChatTile
      node={node}
      epicId={epicId}
      viewTabId={viewTabId}
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
 * `useTabHostId()`.
 */
export function renderTile(args: TileRenderArgs<EpicCanvasTileRef>): ReactNode {
  return (
    <TabHostProvider hostId={args.node.hostId}>
      <TileFindScope
        node={args.node}
        viewTabId={args.viewTabId}
        tileId={args.tileId}
        epicId={args.epicId}
        isActive={args.isActive}
      >
        {tileRenderer(args.node.type)(args)}
      </TileFindScope>
    </TabHostProvider>
  );
}
