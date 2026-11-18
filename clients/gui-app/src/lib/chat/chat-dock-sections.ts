import type { DockRegionId } from "@/lib/layout/region-id";

/**
 * The dock's own model of its four members, in `lib` rather than beside the
 * React context that used to own it.
 *
 * This is a MODEL type - which rows the dock has, what the arrangement's
 * region ids are called here, and what a screen reader calls each one. It is
 * read by the Zustand store that remembers which pill a chat has open, and a
 * store may not import from a component: the same rule
 * `chat-dock-panel-height.ts` states in its own header, for the settings store
 * that clamps with it. The React context, its hooks and the chip models stay
 * in `components/chat/chat-dock-compact-context.ts`.
 */
export type ChatDockSection =
  | "filesChanged"
  | "activeAgents"
  | "background"
  | "todo";

/**
 * The dock's own name for one of the dock regions.
 *
 * Two vocabularies, deliberately: the registry words a region for someone
 * reading the layout form ("Running agents"), while the dock names its rows
 * after the panels they mount. This is the one place they meet, so the order
 * the arrangement holds can be read as a list of sections.
 *
 * Todo is a dock member with the same Full row / Chip / Hidden semantics as the
 * other three (L-139/L-142). The Message queue is not a member at all (G1-G2):
 * it is never a pill, so it has no section and no region.
 */
const SECTION_BY_REGION: Readonly<Record<DockRegionId, ChatDockSection>> = {
  changedFiles: "filesChanged",
  runningAgents: "activeAgents",
  background: "background",
  todo: "todo",
};

export function chatDockSection(regionId: DockRegionId): ChatDockSection {
  return SECTION_BY_REGION[regionId];
}

/**
 * The short name a screen reader gets for the open pill's panel.
 *
 * Sentence case, the same case the registry gives every region and the same
 * case the panel's own visible header prints: a name that differs from the
 * editor's row by the case of one letter is a typo, not a second vocabulary,
 * and a screen-reader user hears the difference.
 */
export const CHAT_DOCK_SECTION_NAME: Readonly<Record<ChatDockSection, string>> =
  {
    filesChanged: "Files changed",
    activeAgents: "Active agents",
    background: "Background",
    todo: "Todo",
  };
