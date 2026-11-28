import {
  readFreshSafeAreaInsets,
  readSafeAreaInsets,
} from "@/lib/safe-area-insets";
import { getMobileAppPlatform } from "@/lib/mobile-app";
import {
  readSystemGestureInsets,
  systemGestureInsetsReady,
} from "@/lib/system-gesture-insets";

const EDGE_ZONE_PX = 32;

/** The navigable strips, measured from the viewport rather than the window. */
function readEdgeSwipeZones(): {
  readonly left: number;
  readonly right: number;
} {
  const safe =
    getMobileAppPlatform() === "android"
      ? readFreshSafeAreaInsets()
      : readSafeAreaInsets();
  const system = readSystemGestureInsets();
  return {
    left: Math.min(window.innerWidth, Math.max(0, safe.left, system.left)),
    right: Math.max(
      0,
      window.innerWidth - Math.max(0, safe.right, system.right),
    ),
  };
}

export function edgeSwipeDirectionAt(
  clientX: number,
): "back" | "forward" | null {
  if (!systemGestureInsetsReady()) return null;
  const { left, right } = readEdgeSwipeZones();
  if (
    left < right &&
    clientX >= left &&
    clientX <= Math.min(right, left + EDGE_ZONE_PX)
  ) {
    return "back";
  }
  if (
    left < right &&
    clientX <= right &&
    clientX >= Math.max(left, right - EDGE_ZONE_PX)
  ) {
    return "forward";
  }
  return null;
}

/** Other horizontal gestures yield both the system strip and the app band. */
export function isEdgeSwipeReserved(clientX: number): boolean {
  const { left, right } = readEdgeSwipeZones();
  if (left >= right) return clientX >= 0 && clientX <= window.innerWidth;
  return (
    clientX <= Math.min(right, left + EDGE_ZONE_PX) ||
    clientX >= Math.max(left, right - EDGE_ZONE_PX)
  );
}

export function isLeadingEdgeSwipeReserved(clientX: number): boolean {
  const { left, right } = readEdgeSwipeZones();
  if (left >= right) return clientX >= 0 && clientX <= window.innerWidth;
  return clientX >= 0 && clientX <= Math.min(right, left + EDGE_ZONE_PX);
}
