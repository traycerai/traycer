import type { AppIconBadgeCountSource } from "@traycer-clients/shared/platform/runner-host";
import type { NotificationBellState } from "@/stores/notifications/merged-notifications";

/** The one mark the bell wears. */
export type BellMark = "needsYou" | "attention" | "unknown" | "quietDot" | null;

/**
 * The amber count of tasks and actionable notices; else the red count
 * of what needs attention, failures among it; else the hollow `unknown` dot;
 * else the quiet dot for anything unread.
 */
export function bellMarkOf(
  state: NotificationBellState,
  needsYou: number,
): BellMark {
  if (needsYou > 0) return "needsYou";
  switch (state.kind) {
    case "attention":
      return "attention";
    case "unknown":
      return "unknown";
    case "quietDot":
      return "quietDot";
    case "clear":
      return null;
  }
}

/**
 * The number on the app icon: the number the app's own surface draws for
 * `source`. `"bell"` follows `bellMarkOf`, so it cannot drift from the header
 * bell: its amber or red count, and nothing for a dot. `"attention"` is the
 * phone's Notifications row, which draws the red count alone.
 */
export function appIconBadgeCount(
  source: AppIconBadgeCountSource,
  bellState: NotificationBellState,
  needsYouCount: number,
): number {
  if (source === "attention") {
    return bellState.kind === "attention" ? bellState.count : 0;
  }
  switch (bellMarkOf(bellState, needsYouCount)) {
    case "needsYou":
      return needsYouCount;
    case "attention":
      return bellState.kind === "attention" ? bellState.count : 0;
    case "unknown":
    case "quietDot":
    case null:
      return 0;
  }
}
