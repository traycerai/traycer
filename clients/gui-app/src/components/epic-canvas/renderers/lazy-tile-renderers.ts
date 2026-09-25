import { lazy } from "react";

/**
 * The canvas tile renderers `tile-render.tsx` does not need at boot, each a
 * `lazy()` component fetched the first time a tile of that kind mounts.
 *
 * The registry sits on the app's static path (the hosted chat surface renders
 * through it), so a renderer imported there directly is evaluated at startup
 * with everything it pulls in, whether or not such a tile is ever opened. Chat
 * and published chat stay eager: the hosted chat surface needs them at once.
 *
 * The rest load as two coarse chunks rather than a chunk per kind: the
 * communication graph, which brings its own graph-layout and canvas libraries,
 * and every other kind together (`deferred-tiles.ts`). Keep the groups few:
 * besides its own chunk, each lazily-loaded group splits the startup modules it
 * shares with the app into further chunks of their own, and every chunk a
 * WebView keeps costs memory.
 */

const deferredTiles = () => import("./deferred-tiles");

export const ReviewTile = lazy(() =>
  deferredTiles().then((module) => ({ default: module.ReviewTile })),
);
export const SpecTile = lazy(() =>
  deferredTiles().then((module) => ({ default: module.SpecTile })),
);
export const StoryTile = lazy(() =>
  deferredTiles().then((module) => ({ default: module.StoryTile })),
);
export const TicketTile = lazy(() =>
  deferredTiles().then((module) => ({ default: module.TicketTile })),
);
export const DeletedArtifactsTile = lazy(() =>
  deferredTiles().then((module) => ({ default: module.DeletedArtifactsTile })),
);
export const WorkspaceFileTile = lazy(() =>
  deferredTiles().then((module) => ({ default: module.WorkspaceFileTile })),
);
export const GitDiffTile = lazy(() =>
  deferredTiles().then((module) => ({ default: module.GitDiffTile })),
);
export const SnapshotDiffTile = lazy(() =>
  deferredTiles().then((module) => ({ default: module.SnapshotDiffTile })),
);
export const PrDetailTile = lazy(() =>
  deferredTiles().then((module) => ({ default: module.PrDetailTile })),
);
export const PrDiffTile = lazy(() =>
  deferredTiles().then((module) => ({ default: module.PrDiffTile })),
);
export const TerminalTile = lazy(() =>
  deferredTiles().then((module) => ({ default: module.TerminalTile })),
);
export const TuiAgentTile = lazy(() =>
  deferredTiles().then((module) => ({ default: module.TuiAgentTile })),
);
export const ManagedCommandOutputTile = lazy(() =>
  deferredTiles().then((module) => ({
    default: module.ManagedCommandOutputTile,
  })),
);
export const BrowserSessionTile = lazy(() =>
  deferredTiles().then((module) => ({ default: module.BrowserSessionTile })),
);

export const CommGraphTile = lazy(() =>
  import("./comm-graph-tile").then((module) => ({
    default: module.CommGraphTile,
  })),
);
