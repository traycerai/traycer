import {
  alwaysAvailable,
  isPushPermissionRowAvailable,
  isSystemNotificationsRowAvailable,
} from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

export const APP_NOTIFICATIONS = defineSettingsSection("app-notifications", {
  page: {
    availableWhen: alwaysAvailable,
    label: "Sounds",
    description: "How this app alerts you across hosts.",
    keywords: [
      "notifications",
      "alerts",
      "banner",
      "push",
      "sound",
      "chime",
      "audio",
      "beep",
      "volume",
      "mute",
      "ding",
    ],
  },
  // The chime card shows no heading — the page already names it — so it is not
  // a destination of its own; it and its rows fold into the page.
  chimes: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Chimes",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  chimeNeedsAction: {
    kind: "row",
    group: "chimes",
    search: { contributesTo: "page" },
    label: "Needs action",
    description: "Approvals and interviews.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  chimeFailure: {
    kind: "row",
    group: "chimes",
    search: { contributesTo: "page" },
    label: "Failure",
    description: "Errored turns, stalls, crashes, and rate limits.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  chimeDone: {
    kind: "row",
    group: "chimes",
    search: { contributesTo: "page" },
    label: "Done",
    description: "Completed or intentionally stopped turns.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  chimeInfo: {
    kind: "row",
    group: "chimes",
    search: { contributesTo: "page" },
    label: "Info",
    description:
      "Sharing, comments, access changes, and other informational notifications.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  // Where the alerts themselves are configured: the OS (or, in the phone app,
  // its push permission) and the selected host's own page. Each used to be a
  // heading over one row. Notification events is drawn in every shell, so the
  // group is never empty.
  notifications: {
    kind: "group",
    search: { anchor: "app-notifications-notifications" },
    label: "Notifications",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: ["alerts", "delivery"],
  },
  osNotifications: {
    kind: "row",
    group: "notifications",
    search: { anchor: "app-notifications-os" },
    label: "OS notifications",
    description:
      "Banners, badges, and delivery are managed by your operating system.",
    availableWhen: isSystemNotificationsRowAvailable,
    keywords: ["os", "native", "banner", "badge", "macos", "windows", "system"],
  },
  // "On this phone", never "on this device": in this GUI "device" is the UI
  // word for a HOST, and this row is about the phone in the person's hand.
  pushNotifications: {
    kind: "row",
    group: "notifications",
    search: { anchor: "app-notifications-push" },
    label: "Push notifications on this phone",
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
  // descriptions are the chime rows', so a word means one thing on the page.
  pushNeedsAction: {
    kind: "row",
    group: "notifications",
    search: { anchor: "app-notifications-push-needs-action" },
    label: "Needs action",
    description: "Approvals and interviews.",
    availableWhen: isPushPermissionRowAvailable,
    keywords: ["push", "phone", "buzz", "needs action"],
  },
  pushFailure: {
    kind: "row",
    group: "notifications",
    search: { anchor: "app-notifications-push-failure" },
    label: "Failure",
    description: "Errored turns, stalls, crashes, and rate limits.",
    availableWhen: isPushPermissionRowAvailable,
    keywords: ["push", "phone", "buzz", "failure"],
  },
  pushDone: {
    kind: "row",
    group: "notifications",
    search: { anchor: "app-notifications-push-done" },
    label: "Done",
    description: "Completed or intentionally stopped turns.",
    availableWhen: isPushPermissionRowAvailable,
    keywords: ["push", "phone", "buzz", "done"],
  },
  pushInfo: {
    kind: "row",
    group: "notifications",
    search: { anchor: "app-notifications-push-info" },
    label: "Info",
    description:
      "Sharing, comments, access changes, and other informational notifications.",
    availableWhen: isPushPermissionRowAvailable,
    keywords: ["push", "phone", "buzz", "info"],
  },
  notificationEvents: {
    kind: "row",
    group: "notifications",
    search: { anchor: "app-notification-events" },
    label: "Notification events",
    description:
      "Choose which events alert you for the host selected in Settings.",
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
