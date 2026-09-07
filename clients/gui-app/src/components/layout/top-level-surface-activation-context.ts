import { createContext, use, type FocusEvent, type PointerEvent } from "react";
import type { HeaderTab } from "@/stores/tabs/types";

export type TopLevelSurfaceActivator = (tab: HeaderTab) => void;

export const TopLevelSurfaceActivationContext =
  createContext<TopLevelSurfaceActivator | null>(null);

export function useTopLevelSurfaceActivator(): TopLevelSurfaceActivator | null {
  return use(TopLevelSurfaceActivationContext);
}

/** Hover, wheel, and passive pointer movement intentionally have no path here. */
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
  // The focus-restore bounce (a pane-local portal's Radix close-autofocus refocusing its trigger on defocus
  // unmount.
  if (focused || activate === null || event.defaultPrevented) return;
  activate(tab);
}
