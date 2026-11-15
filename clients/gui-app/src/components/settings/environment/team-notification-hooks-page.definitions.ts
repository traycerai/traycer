import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";
import { TEAM_NOTIFICATION_HOOKS_COPY } from "../panels/cloud-notification-copy";

export const TEAM_NOTIFICATION_HOOKS = defineSettingsSection(
  "notification-hooks",
  {
    page: {
      availableWhen: alwaysAvailable,
      label: TEAM_NOTIFICATION_HOOKS_COPY.title,
      description: null,
      keywords: ["team", "webhook", "HTTP", "headers"],
    },
  },
);
