import { neverOffered } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

// Retired with notification hooks, the last thing the page held. Every
// section keeps its one collection; no shell offers this one, so search never
// leads to it, and its route opens Alerts.
export const HOST_NOTIFICATIONS = defineSettingsSection("notifications", {
  page: {
    availableWhen: neverOffered,
    label: "Notifications",
    description: "Scripts and URLs a host ran when it created a notification.",
    keywords: ["notification hooks", "hooks", "webhook"],
  },
});
