import { useRouter } from "@tanstack/react-router";
import type { RouterHistory } from "@tanstack/react-router";
import { getHistoryController } from "@/lib/persistent-history";
import { isMobileApp } from "@/lib/mobile-app";

/**
 * Whether in-app back/forward may show CHROME on this shell - the header
 * arrows, the mouse-button reservation, the palette rows.
 *
 * TWO FACTS, and they are deliberately not the same question. The first is
 * capability: the current router's history carries the persistent-history
 * controller brand, so there is a stack to walk at all. The second is
 * presentation: the installed mobile app HAS that stack and must not grow any
 * of that chrome for it. The phone's affordance is the edge swipe, and it is
 * the whole affordance - a header with no room for arrows, a palette a thumb
 * does not open, and mouse buttons that do not exist. Chrome added here would
 * be chrome nobody on that shell can use.
 *
 * So the gesture asks nothing of this predicate. It walks the same stack
 * through the same `goBack` / `goForward`, and those already no-op on a history
 * with no controller - which is what keeps the phone's swipe and the desktop's
 * arrows one implementation rather than two answers to "go back".
 *
 * Stated once, here, because the predicate has three call sites that cannot see
 * each other: this hook, the keybinding router adapter (which the palette reads
 * through, since it mounts above `<RouterProvider>` where router context is
 * null), and the mouse listener. A copy of the rule in each is how one of them
 * ends up disagreeing.
 */
export function historyNavChromeAvailable(history: RouterHistory): boolean {
  if (getHistoryController(history) === null) return false;
  return !isMobileApp();
}

/**
 * {@link historyNavChromeAvailable} for a component, off the CURRENT router's
 * history - never a module-level singleton, so multi-window routers each
 * resolve their own.
 */
export function useHistoryNavAvailable(): boolean {
  const router = useRouter();
  return historyNavChromeAvailable(router.history);
}
