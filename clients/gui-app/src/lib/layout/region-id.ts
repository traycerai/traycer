/**
 * Every region the layout editor can address, as one flat union.
 *
 * Zero imports by design: the value model, the arrangement, the region
 * registry and the settings-search index all name these ids, and a module
 * that owned the union alongside anything else would put one of them in a
 * cycle with the rest.
 *
 * A region is a THING ON SCREEN, not a setting: `usageLimits` is the one
 * region the three old usage rows collapsed into (L-28), and the sidebar rail
 * is nine regions rather than one list, because each icon is hoverable,
 * selectable and separately shown or hidden.
 */

/** The composer toolbar's movable elements. Send is not one - it renders last. */
export type ToolbarRegionId = "attachImage" | "access" | "model" | "mic";

/**
 * The four rows above the message box, which share one order.
 *
 * Each obeys ONE rule - Full row, Chip or Hidden, reorderable in the dock, a
 * pill in the compact strip. The Message queue is deliberately NOT one of them
 * (staging round 2, G1-G2): queued messages are the user's own pending sends,
 * so the queue is never a pill, never hidden and never reordered - it sits in
 * a fixed slot directly above the composer whenever it holds anything.
 */
export type DockRegionId =
  | "runningAgents"
  | "changedFiles"
  | "background"
  | "todo";

/**
 * The sidebar rail's ten panels. Named for what they are rather than for the
 * panel ids they map onto (`chats` is titled "Agents"), which is what the rail
 * shows and what a person searching for one would type.
 */
export type RailRegionId =
  | "railAgents"
  | "railTerminals"
  | "railBrowsers"
  | "railArtifacts"
  | "railFiles"
  | "railGitDiff"
  | "railPullRequests"
  | "railFileTree"
  | "railSharing"
  | "railComments";

/**
 * What the transcript itself draws: the activity rows that fold a run of tool
 * calls, the reasoning blocks, and the time on each user message. Each is a
 * thing on screen with its own right-click, so each is a region rather than a
 * Chat area row.
 */
export type ChatDisplayRegionId = "toolActivity" | "thinking" | "timestamps";

/** The rail panels whose presence rule can leave them out, and so offer Auto. */
export type AutoRailRegionId = "railPullRequests" | "railComments";

export type RegionId =
  | "homeTab"
  | "usageLimits"
  | "resourceMonitor"
  | "minimap"
  | "contextUsage"
  | ChatDisplayRegionId
  | DockRegionId
  | ToolbarRegionId
  | RailRegionId;
