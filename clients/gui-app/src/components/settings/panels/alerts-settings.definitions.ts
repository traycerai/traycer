import {
  alwaysAvailable,
  isAlertsSystemGroupAvailable,
  isPushPermissionRowAvailable,
  isSystemNotificationsRowAvailable,
} from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

export const ALERTS = defineSettingsSection("alerts", {
  page: {
    availableWhen: alwaysAvailable,
    label: "Alerts",
    description:
      "What interrupts you on this computer or phone. Every notification still appears in the bell.",
    keywords: [
      "notifications",
      "alerts",
      "banner",
      "push",
      "toast",
      "in-app notifications",
      "interrupt",
    ],
  },
  // One row per kind: whether it interrupts on this device - the Notify
  // switch, or in the phone app the per-phone push switch - and its chime.
  notifications: {
    kind: "group",
    search: { anchor: "alerts-notifications" },
    label: "Notifications",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [
      "kind",
      "severity",
      "notify",
      "chime",
      "sound",
      "ding",
      "beep",
      "mute",
      "buzz",
    ],
  },
  needsAction: {
    kind: "row",
    group: "notifications",
    search: { anchor: "alerts-needs-action" },
    label: "Needs action",
    description: "Approvals and interviews.",
    availableWhen: alwaysAvailable,
    keywords: ["notify", "chime"],
  },
  failure: {
    kind: "row",
    group: "notifications",
    search: { anchor: "alerts-failure" },
    label: "Failure",
    description: "Errored turns, stalls, crashes, and rate limits.",
    availableWhen: alwaysAvailable,
    keywords: ["notify", "chime"],
  },
  done: {
    kind: "row",
    group: "notifications",
    search: { anchor: "alerts-done" },
    label: "Done",
    description: "Completed or intentionally stopped turns.",
    availableWhen: alwaysAvailable,
    keywords: ["notify", "chime"],
  },
  info: {
    kind: "row",
    group: "notifications",
    search: { anchor: "alerts-info" },
    label: "Info",
    description:
      "Sharing, comments, access changes, and other informational notifications.",
    availableWhen: alwaysAvailable,
    keywords: ["notify", "chime"],
  },
  // Where the OS keeps its own part: banner settings on the desktop, the push
  // permission in the phone app. A shell with neither draws no card.
  system: {
    kind: "group",
    search: { anchor: "alerts-system" },
    label: "System",
    description: null,
    breadcrumb: null,
    availableWhen: isAlertsSystemGroupAvailable,
    keywords: ["os", "permission"],
  },
  osNotifications: {
    kind: "row",
    group: "system",
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
    group: "system",
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
});
