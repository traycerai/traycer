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
  // Overlay presentation hooks prevent focus restoration into background panes.
  // Do not filter programmatic focus here: Chrome reports it as trusted too.
  if (focused || activate === null || event.defaultPrevented) return;
  activate(tab);
}
