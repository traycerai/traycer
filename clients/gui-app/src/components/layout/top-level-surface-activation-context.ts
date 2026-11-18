import { createContext, use, type FocusEvent, type PointerEvent } from "react";
import type { HeaderTab } from "@/stores/tabs/types";

export type TopLevelSurfaceActivator = (tab: HeaderTab) => void;

export const TopLevelSurfaceActivationContext =
  createContext<TopLevelSurfaceActivator | null>(null);

export function useTopLevelSurfaceActivator(): TopLevelSurfaceActivator | null {
  return use(TopLevelSurfaceActivationContext);
}

/**
 * Deliberate interactions transfer command ownership to a split partner.
 * Hover, wheel, and passive pointer movement intentionally have no path here.
 */
export function activateTopLevelSurfaceFromPointer(
  event: PointerEvent<HTMLElement>,
  focused: boolean,
  tab: HeaderTab,
  activate: TopLevelSurfaceActivator | null,
): void {
  if (focused || activate === null || event.defaultPrevented) return;
  activate(tab);
}

export function activateTopLevelSurfaceFromFocus(
  event: FocusEvent<HTMLElement>,
  focused: boolean,
  tab: HeaderTab,
  activate: TopLevelSurfaceActivator | null,
): void {
  // A deliberate keyboard focus into a background pane activates it. The
  // focus-restore BOUNCE (a pane-local portal's Radix close-autofocus refocusing
  // its trigger on defocus unmount, which would fire here and reactivate the
  // just-defocused pane) is killed at its source by `usePaneCloseAutoFocusGuard`
  // (`onCloseAutoFocus` -> `preventDefault`) — it is not filtered here, because a
  // programmatic `.focus()` is `isTrusted:true` in Chrome and cannot be
  // distinguished from a genuine user focus at this point.
  if (focused || activate === null || event.defaultPrevented) return;
  activate(tab);
}
