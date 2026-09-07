/**
 * What a non-desktop surface changes about the chat tree, named so the tree itself stays one component instead of being re-implemented per form factor.
 * Those are the three things supplied here, rather than growing a parallel row.
 */
import { createContext, use } from "react";

export interface ChatTreeSurface {
  /**
   * Not only tile opens.
   * A row's tap calls it after opening the tile; "New child agent" calls it before opening the modal, which opens no tile at all.
   */
  readonly onRowActivated: () => void;
  /**
   * Show the row controls that otherwise wait for hover. A tree on touch has no
   * hover state to reveal them with, so they would be permanently unreachable.
   */
  readonly revealRowControls: boolean;
  /**
   * The query to narrow the tree by, when the surface owns it; `null` to read the panel's own per-tab query, which is the desktop behaviour.
   * A sheet's query is deliberately NOT the panel's.
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
 * Whether this tree's rows must show the controls that otherwise wait for hover.
 * Its own hook so the row components read one boolean rather than repeating the null-surface fallback - which on the row button is enough branching to push it past the complexity ceiling.
 */
export function useRevealRowControls(): boolean {
  const surface = useChatTreeSurface();
  if (surface === null) return false;
  return surface.revealRowControls;
}
