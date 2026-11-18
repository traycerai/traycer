import { createContext, useContext } from "react";

/**
 * Where an in-app link opened from this subtree should land: the epic that
 * owns the surface, and the header tab whose canvas it is rendered in. Every
 * mount is inside a canvas tab (tiles, the sidebar, the mobile switcher), so a
 * surface with NO tab has no provider at all rather than a null tab id.
 *
 * Provided by `renderTile` for every canvas tile, so markdown anchors,
 * terminal OSC-8 links and every other in-tile link surface reach it without
 * threading props.
 */
export interface LinkTarget {
  readonly epicId: string;
  readonly viewTabId: string;
}

export const LinkTargetContext = createContext<LinkTarget | null>(null);

export function useLinkTarget(): LinkTarget | null {
  return useContext(LinkTargetContext);
}
