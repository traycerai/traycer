import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

// Account notifications read and save through authn without a computer.
// Which kinds of notification interrupt is the device's, under
// Application → Alerts.
export const HOST_NOTIFICATIONS = defineSettingsSection("notifications", {
  page: {
    availableWhen: alwaysAvailable,
    label: "Notifications",
    description:
      "What your automation receives when a host creates a notification.",
    keywords: [
      "inbox",
      "filter",
      "automation",
      "in-app notifications",
      "toast",
      "severity",
      "notification hooks",
      "hooks",
      "webhook",
      "trigger",
    ],
  },
  inAppNotifications: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "In-app notifications",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  severityNeedsAction: {
    kind: "row",
    group: "inAppNotifications",
    search: { contributesTo: "page" },
    label: "Needs action",
    description: "Approvals and interviews.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  severityFailure: {
    kind: "row",
    group: "inAppNotifications",
    search: { contributesTo: "page" },
    label: "Failure",
    description: "Errored turns, stalls, crashes, and rate limits.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  severityDone: {
    kind: "row",
    group: "inAppNotifications",
    search: { contributesTo: "page" },
    label: "Done",
    description: "Completed or intentionally stopped turns.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  severityInfo: {
    kind: "row",
    group: "inAppNotifications",
    search: { contributesTo: "page" },
    label: "Info",
    description: "Updates that need nothing from you.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  notificationHooks: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Notification hooks",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
});
