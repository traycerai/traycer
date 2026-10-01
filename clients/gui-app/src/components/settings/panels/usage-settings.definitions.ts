import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

export const USAGE = defineSettingsSection("usage", {
  page: {
    availableWhen: alwaysAvailable,
    label: "Usage",
    description: "Token and cost usage across your agents.",
    keywords: [
      "tokens",
      "cost",
      "spend",
      "billing",
      "credits",
      "quota",
      "analytics",
    ],
  },
});
