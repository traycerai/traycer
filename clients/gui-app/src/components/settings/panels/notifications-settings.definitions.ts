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
      "notification hooks",
      "hooks",
      "webhook",
      "trigger",
    ],
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
