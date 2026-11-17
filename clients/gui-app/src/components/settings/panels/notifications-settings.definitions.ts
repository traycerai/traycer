import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

// Host-scoped: the page's scope gate conceals both cards while the host
// connects or is unreachable and drops them for a host that vanished, so
// every card and row here folds into the page. Which kinds of notification
// interrupt is not here: that is the device's, under Application → Alerts.
export const HOST_NOTIFICATIONS = defineSettingsSection("notifications", {
  page: {
    availableWhen: alwaysAvailable,
    label: "Notifications",
    description: "Long-turn alerts, and what your automation receives.",
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
  // Untitled: it holds the turn alert alone, and the row names itself.
  longTurns: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Long turns",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  longTurnAlert: {
    kind: "row",
    group: "longTurns",
    search: { contributesTo: "page" },
    label: "Alert when a turn runs longer than",
    description:
      "Notifies you once per turn. Time waiting on your approval or answer doesn't count.",
    availableWhen: alwaysAvailable,
    keywords: ["long", "running", "stuck", "duration", "turn"],
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
