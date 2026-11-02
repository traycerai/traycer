import {
  alwaysAvailable,
  isPushPermissionRowAvailable,
  isSystemNotificationsRowAvailable,
} from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

export const ALERTS = defineSettingsSection("alerts", {
  page: {
    availableWhen: alwaysAvailable,
    label: "Alerts",
    description: "How this app alerts you.",
    keywords: ["notifications", "alerts", "banner", "push"],
  },
  // Where the alerts themselves are configured: the OS (or, in the phone app,
  // its push permission) and the selected host's own page. Each used to be a
  // heading over one row. Notification events is drawn in every shell, so the
  // group is never empty.
  notifications: {
    kind: "group",
    search: { anchor: "alerts-notifications" },
    label: "Notifications",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: ["alerts", "delivery"],
  },
  osNotifications: {
    kind: "row",
    group: "notifications",
    search: { anchor: "alerts-os" },
    label: "OS notifications",
    description: "Banners and badges are set in your operating system.",
    availableWhen: isSystemNotificationsRowAvailable,
    keywords: ["os", "native", "banner", "badge", "macos", "windows", "system"],
  },
  // No "on this device" qualifier: in this GUI "device" is the UI word for a
  // HOST, and "phone" is wrong on a tablet. The row only exists in the mobile
  // app, so the bare label already names the thing in the person's hand.
  pushNotifications: {
    kind: "row",
    group: "notifications",
    search: { anchor: "alerts-push" },
    label: "Push notifications",
    // The sentence reports the OS permission state, so it is the row's status.
    description: null,
    availableWhen: isPushPermissionRowAvailable,
    keywords: [
      "push",
      "mobile",
      "phone",
      "permission",
      "remote",
      "ios",
      "android",
      "device",
    ],
  },
  // One switch per severity under the push row, gated with it. Labels and
  // descriptions are the Sounds page's chime rows', so a word means one thing
  // on both pages.
  pushNeedsAction: {
    kind: "row",
    group: "notifications",
    search: { anchor: "alerts-push-needs-action" },
    label: "Needs action",
    description: "Approvals and interviews.",
    availableWhen: isPushPermissionRowAvailable,
    keywords: ["push", "phone", "buzz", "needs action"],
  },
  pushFailure: {
    kind: "row",
    group: "notifications",
    search: { anchor: "alerts-push-failure" },
    label: "Failure",
    description: "Errored turns, stalls, crashes, and rate limits.",
    availableWhen: isPushPermissionRowAvailable,
    keywords: ["push", "phone", "buzz", "failure"],
  },
  pushDone: {
    kind: "row",
    group: "notifications",
    search: { anchor: "alerts-push-done" },
    label: "Done",
    description: "Completed or intentionally stopped turns.",
    availableWhen: isPushPermissionRowAvailable,
    keywords: ["push", "phone", "buzz", "done"],
  },
  pushInfo: {
    kind: "row",
    group: "notifications",
    search: { anchor: "alerts-push-info" },
    label: "Info",
    description:
      "Sharing, comments, access changes, and other informational notifications.",
    availableWhen: isPushPermissionRowAvailable,
    keywords: ["push", "phone", "buzz", "info"],
  },
  notificationEvents: {
    kind: "row",
    group: "notifications",
    search: { anchor: "alerts-notification-events" },
    label: "Notification events",
    description: "Which events create a notification. Set per host.",
    availableWhen: alwaysAvailable,
    keywords: [
      "events",
      "turn done",
      "alerts",
      "filter",
      "which",
      "triggers",
      "when",
    ],
  },
});
