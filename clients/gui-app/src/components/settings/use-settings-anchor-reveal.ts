import { useCallback, useEffect, useRef } from "react";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";
import type { SettingsSectionId } from "@/lib/settings-sections";

/**
 * How long after the REQUEST to keep looking for the anchor before giving up.
 *
 * The element is not there when the click happens and often is not there a
 * frame later either: panels render content behind host RPCs and behind a
 * scope gate that conceals it while the host connects. Three seconds covers a
 * cold RPC on a slow link without leaving a stale request armed long enough
 * to fire at a user who has since navigated somewhere else on purpose.
 *
 * Measured from `requestedAt`, never from when a watcher started looking: a
 * watcher that mounts later (the surface was closed and reopened) must not
 * grant an old request a fresh three seconds.
 */
const REVEAL_DEADLINE_MS = 3000;

/**
 * How long the found element stays marked.
 *
 * Long enough to survive the smooth scroll that precedes it and still be lit
 * when the eye arrives; short enough that it reads as an answer to the click
 * rather than as a new permanent state of the row.
 */
const FLASH_MS = 1800;

/** Set on the revealed element while it is lit. See `settings-search.css`. */
const FLASH_ATTRIBUTE = "data-settings-anchor-flash";

/**
 * On the scrolling pane each settings surface wraps its panel in — the page a
 * `null`-anchor request means. Owned by the surfaces, not by the panels, so
 * every section has one however bespoke its panel is.
 */
const PANEL_PANE_SELECTOR = "[data-settings-panel-pane]";

/**
 * Scrolls to, and briefly marks, the element a search result asked for.
 *
 * Mounted once beside the panel outlet rather than inside each panel: the
 * element belongs to whichever panel is on screen, no panel knows it is being
 * searched, and one watcher cannot race a second copy of itself.
 *
 * `activeSection` is what the surface is CURRENTLY showing. A request for
 * another section is not dropped — the click that made it also started a
 * navigation, and this hook may well run before that navigation commits — it
 * simply finds nothing until the right panel arrives, which the polling below
 * handles for free.
 *
 * A request with a `null` anchor is a page result: once the requested section
 * is the one on screen, its pane scrolls back to the top and nothing is marked.
 */
export function useSettingsAnchorReveal(
  activeSection: SettingsSectionId | null,
): void {
  const pendingReveal = useSettingsSearchStore((state) => state.pendingReveal);
  const clearReveal = useSettingsSearchStore((state) => state.clearReveal);
  // The flash outlives the request that caused it, so it cannot be owned by
  // the effect below.
  //
  // Finding the element ends the REQUEST — the watcher clears it so a
  // never-resolved one cannot fire later — but the mark has to stay lit for
  // most of two seconds after that. Those two lifetimes used to share one
  // effect, and because clearing the request mutates a value that effect
  // depends on, React tore the effect down the instant it succeeded and the
  // teardown stripped the attribute it had just set. The row scrolled into
  // view and never lit up. Refs keep the mark out of that dependency.
  const flashTimerRef = useRef<number | null>(null);
  const flashedRef = useRef<Element | null>(null);

  const clearFlash = useCallback((): void => {
    if (flashTimerRef.current !== null) {
      window.clearTimeout(flashTimerRef.current);
      flashTimerRef.current = null;
    }
    flashedRef.current?.removeAttribute(FLASH_ATTRIBUTE);
    flashedRef.current = null;
  }, []);

  useEffect(() => {
    if (pendingReveal === null) return;

    let frame = 0;

    const attempt = (): void => {
      // Checked BEFORE looking, not only on a miss: a request that has
      // outlived its deadline must not fire just because its element happens
      // to be on screen when a watcher finally looks.
      if (Date.now() - pendingReveal.requestedAt >= REVEAL_DEADLINE_MS) {
        clearReveal();
        return;
      }
      if (pendingReveal.anchor === null) {
        // The section is the whole target, so it has to be the one on screen
        // — the pane is the surface's, and it holds the previous section's
        // panel until the navigation commits.
        const pane =
          activeSection === pendingReveal.section
            ? document.querySelector(PANEL_PANE_SELECTOR)
            : null;
        if (pane === null) {
          frame = requestAnimationFrame(attempt);
          return;
        }
        clearFlash();
        pane.scrollTo({
          top: 0,
          behavior: prefersReducedMotion() ? "auto" : "smooth",
        });
        clearReveal();
        return;
      }
      const target = document.querySelector(
        `[${ANCHOR_ATTRIBUTE}="${cssEscape(pendingReveal.anchor)}"]`,
      );
      // Present is not enough. A scope gate keeps its content MOUNTED but
      // hidden while the host connects, so an element can exist, be found,
      // and scroll nowhere visible — spending the request on nothing. Keep
      // polling until it can actually be seen, or the deadline passes.
      if (target === null || !isVisible(target)) {
        frame = requestAnimationFrame(attempt);
        return;
      }
      // ORDER IS LOAD-BEARING. The previous mark comes off first, the scroll
      // reads layout second, and only then does the new mark go on. Removing
      // and re-adding the attribute back to back would leave the browser no
      // style recalc in between, and a CSS animation that is still running
      // does not restart for a change it never observed — so clicking the
      // same result again while it was lit showed nothing. The scroll's
      // `getBoundingClientRect` reads are the recalc that separates the two.
      clearFlash();
      scrollPaneToCenter(target);
      target.setAttribute(FLASH_ATTRIBUTE, "true");
      flashedRef.current = target;
      flashTimerRef.current = window.setTimeout(clearFlash, FLASH_MS);
      clearReveal();
    };

    frame = requestAnimationFrame(attempt);

    // Only the poll is this effect's to cancel. The mark is deliberately left
    // alone here — see the refs above.
    return () => cancelAnimationFrame(frame);
  }, [pendingReveal, activeSection, clearReveal, clearFlash]);

  // The attribute lives on a DOM node React does not know this hook touched,
  // so a real unmount mid-flash would leave it lit on a node React may reuse.
  //
  // The surface closing also abandons whatever request is pending — it must
  // not fire when Settings is next opened. The clear is DEFERRED a tick and
  // cancelled by the next mount of this same watcher: React's development
  // double-mount unmounts and remounts synchronously, so its clear never
  // runs, and a request armed just before the panel existed (the phone's
  // section list navigating into it) survives; a real unmount has no remount
  // to cancel it.
  const deferredClearRef = useRef<number | null>(null);
  useEffect(() => {
    if (deferredClearRef.current !== null) {
      window.clearTimeout(deferredClearRef.current);
      deferredClearRef.current = null;
    }
    return () => {
      clearFlash();
      deferredClearRef.current = window.setTimeout(() => {
        deferredClearRef.current = null;
        clearReveal();
      }, 0);
    };
  }, [clearFlash, clearReveal]);
}

/** The attribute a panel puts on anything a search result can land on. */
export const ANCHOR_ATTRIBUTE = "data-settings-anchor";

/**
 * Scrolls ONLY the pane the row lives in, so the row lands centered in it.
 *
 * Not `scrollIntoView`. That walks every scrollable ancestor and moves each
 * one until the row is visible in all of them — and in the modal surface that
 * chain runs past the panel's own pane into the overlay's container, so the
 * whole dialog (header, rail and all) lurched upward with the panel. The pane
 * a settings panel scrolls in is the nearest ancestor that actually scrolls,
 * and it is the only one with any business moving.
 *
 * Centered, not flush to the top: a row scrolled to the top of the pane loses
 * the group heading above it, and the heading is half of what tells the user
 * they landed in the right place.
 */
function scrollPaneToCenter(target: Element): void {
  const pane = nearestScrollingAncestor(target);
  if (pane === null) return;
  const paneRect = pane.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const targetTopInPane = targetRect.top - paneRect.top + pane.scrollTop;
  const centered =
    targetTopInPane - (pane.clientHeight - targetRect.height) / 2;
  pane.scrollTo({
    top: Math.max(0, centered),
    behavior: prefersReducedMotion() ? "auto" : "smooth",
  });
}

/**
 * Whether the element is rendered where a user could see it: not inside a
 * `display: none` subtree (an `<Activity mode="hidden">` scope gate, a
 * `hidden` attribute). `checkVisibility` where the engine has it; otherwise
 * `offsetParent`, which is `null` for exactly those subtrees (and for fixed
 * elements, which no settings row is).
 */
function isVisible(element: Element): boolean {
  if (typeof element.checkVisibility === "function") {
    return element.checkVisibility();
  }
  return element instanceof HTMLElement && element.offsetParent !== null;
}

/**
 * The closest ancestor that can scroll vertically: one whose `overflow-y`
 * allows it AND whose content actually overflows. The second half matters —
 * the panel shell and several groups declare `overflow-hidden`, and a pane
 * that merely permits scrolling but has nothing to scroll would swallow the
 * request and leave the real pane above it untouched.
 */
function nearestScrollingAncestor(element: Element): HTMLElement | null {
  let current = element.parentElement;
  while (current !== null) {
    const { overflowY } = getComputedStyle(current);
    const canScroll = overflowY === "auto" || overflowY === "scroll";
    if (canScroll && current.scrollHeight > current.clientHeight) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

/**
 * Anchors are authored kebab-case tokens, so this never has real work to do —
 * but the value reaches `querySelector`, and a selector built by
 * concatenation is the one place a future anchor with a dot or a colon in it
 * would stop being a lookup and start being a different selector. `CSS.escape`
 * where the runtime has it (every browser this app targets), and a
 * conservative fallback for the jsdom-shaped environments that do not.
 */
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^\w-]/g, "\\$&");
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
