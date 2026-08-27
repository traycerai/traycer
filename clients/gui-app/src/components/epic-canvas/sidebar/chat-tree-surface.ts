/**
 * What a non-desktop surface changes about the chat tree, named so the tree
 * itself stays one component instead of being re-implemented per form factor.
 *
 * `null` - the default, and what the desktop sidebar provides by not providing
 * anything - means the tree behaves exactly as it always has: a row opens its
 * tile and nothing else happens, the row's controls reveal on hover, and the
 * query comes from the panel's own persisted state.
 *
 * A phone has no hover to reveal by, a sheet has to close itself once it has
 * handed a tile over, and a sheet's search query dies with it. Those are the
 * three things supplied here, rather than growing a parallel row. Everything
 * else about the tree - geometry, indent rails, icons, truncation, status, and
 * what a tap actually opens - is the same code on both, which is the point.
 */
import { createContext, use } from "react";

export interface ChatTreeSurface {
  /**
   * Runs when a row action has finished with the surface - the switcher sheet
   * closes here, so whatever the user picked takes the screen.
   *
   * Not only tile opens. A row's tap calls it after opening the tile; "New
   * child agent" calls it before opening the modal, which opens no tile at all.
   * What the two share is that the surface has served its purpose and should
   * get out of the way, and that is the property being named - an action that
   * dismisses from one control and not another is a divergence, not a feature.
   *
   * Deliberately NOT an override of the opening itself. A row's tap opens a
   * PREVIEW tile on both form factors, and on the phone that is the load-
   * bearing choice rather than a desktop leftover: a viewport showing one tile
   * at a time would otherwise accumulate tiles it never displays and offers no
   * way to close. So the tree keeps owning what opening means, including the
   * ref and its host binding, and a surface only appends to it.
   */
  readonly onRowActivated: () => void;
  /**
   * Show the row controls that otherwise wait for hover. A tree on touch has no
   * hover state to reveal them with, so they would be permanently unreachable.
   */
  readonly revealRowControls: boolean;
  /**
   * The query to narrow the tree by, when the surface owns it; `null` to read
   * the panel's own per-tab query, which is the desktop behaviour.
   *
   * A sheet's query is deliberately NOT the panel's. The sidebar persists its
   * query per tab because its panel stays on screen across everything the user
   * does; a sheet is dismissed the moment a row is tapped, so a query outliving
   * it would greet the next open with a narrowed list and no memory of why.
   * A surface owning its query also owns the input that edits it, so the tree
   * renders none of its own.
   */
  readonly searchQuery: string | null;
}

export const ChatTreeSurfaceContext = createContext<ChatTreeSurface | null>(
  null,
);

/** The mounting surface's overrides, or `null` on the desktop sidebar. */
export function useChatTreeSurface(): ChatTreeSurface | null {
  return use(ChatTreeSurfaceContext);
}

/**
 * Whether this tree's rows must show the controls that otherwise wait for
 * hover. Its own hook so the row components read one boolean rather than
 * repeating the null-surface fallback - which on the row button is enough
 * branching to push it past the complexity ceiling.
 */
export function useRevealRowControls(): boolean {
  const surface = useChatTreeSurface();
  if (surface === null) return false;
  return surface.revealRowControls;
}
