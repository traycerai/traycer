/**
 * Arrow keys through the vertical strip's tabs: Up and Down move focus to the
 * previous or next tab as the list draws them (a split pair's left half, then
 * its right half), and Left and Right move between a pair's two halves. They
 * stop at the ends. Only tabs count: group headers and labels, agent rows and
 * section headers are other roles, and a folded section draws only the row it
 * keeps, so its other tabs are not in the list to visit.
 */

const TAB_SELECTOR = '[role="tab"]';
const PAIR_SELECTOR = "[data-side-split-pair]";

/** The tab focus moves to from `from` for `key`, or `null` when the key moves nothing. */
export function stripArrowTarget(
  list: HTMLElement,
  from: HTMLElement,
  key: string,
): HTMLElement | null {
  const tabs = [...list.querySelectorAll<HTMLElement>(TAB_SELECTOR)].filter(
    (tab) => tab.closest("[aria-hidden='true'], [hidden], [inert]") === null,
  );
  const index = tabs.indexOf(from);
  if (index < 0) return null;
  switch (key) {
    case "ArrowDown":
      return tabs.at(index + 1) ?? null;
    case "ArrowUp":
      return index > 0 ? (tabs.at(index - 1) ?? null) : null;
    case "ArrowLeft":
    case "ArrowRight": {
      const pair = from.closest(PAIR_SELECTOR);
      if (pair === null) return null;
      const halves = tabs.filter((tab) => tab.closest(PAIR_SELECTOR) === pair);
      const half = halves.indexOf(from) + (key === "ArrowRight" ? 1 : -1);
      return half >= 0 ? (halves.at(half) ?? null) : null;
    }
    default:
      return null;
  }
}
