import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

// Host-scoped: the page's scope gate conceals the hooks while the host
// connects or is unreachable and drops them for a host that vanished, so
// every card and row here folds into the page. Which kinds of notification
// interrupt is not here: that is the device's, under Application → Alerts.
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
      "host",
      "notification hooks",
      "hooks",
      "webhook",
      "script",
      "command",
      "trigger",
      "run on",
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
