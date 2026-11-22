/**
 * ⌘F on a bot's channel opens its search, where every other tile opens its
 * find bar. The channel is not a find target: it has no bar, and what it
 * finds is not in the tile. The surface in view registers here, and the
 * find command offers the key here first.
 */
const BOT_SURFACE_SELECTOR = "[data-bot-surface]";

let openSearch: (() => void) | null = null;

/** The channel in view takes ⌘F until the returned function is called. */
export function registerBotChannelFind(open: () => void): () => void {
  openSearch = open;
  return () => {
    if (openSearch === open) openSearch = null;
  };
}

/**
 * Opens the search of the channel in view, if the key belongs to it: focus
 * is in the surface, or nowhere. A tile beside the surface keeps its own ⌘F.
 */
export function openBotChannelFind(): boolean {
  if (openSearch === null) return false;
  const focused = document.activeElement;
  if (
    focused !== null &&
    focused !== document.body &&
    focused.closest(BOT_SURFACE_SELECTOR) === null
  ) {
    return false;
  }
  openSearch();
  return true;
}
