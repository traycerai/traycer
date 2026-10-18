/**
 * The sidebar's ten panels, as ids.
 *
 * Zero imports by design, for the same reason `lib/layout/region-id.ts` has
 * none: the layout model owns the rail's shape (`lib/layout/rail.ts`), the
 * panel store owns each panel's view state, and the sidebar components own the
 * panels themselves - so the vocabulary all three speak cannot sit inside any
 * one of them without making the other two depend on it.
 */

export const LEFT_PANEL_IDS = [
  "chats",
  "terminals",
  "browsers",
  "artifacts",
  "files",
  "git-diff",
  "pull-requests",
  "file-tree",
  "sharing",
  "comments",
] as const;

export type LeftPanelId = (typeof LEFT_PANEL_IDS)[number];

export function isLeftPanelId(value: unknown): value is LeftPanelId {
  return LEFT_PANEL_IDS.some((panelId) => panelId === value);
}

/**
 * Explicit show/hide the user chose. An absent entry means the panel follows
 * its own presence rule, which is what keeps the map sparse.
 */
export type PanelVisibilityOverrideById = Readonly<
  Partial<Record<LeftPanelId, boolean>>
>;
