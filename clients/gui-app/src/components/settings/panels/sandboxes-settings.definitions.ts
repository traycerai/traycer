import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

export const SANDBOXES = defineSettingsSection("sandboxes", {
  page: {
    availableWhen: alwaysAvailable,
    label: "Sandboxes",
    description:
      "Every sandbox running on a configuration's settings and what each one costs.",
    keywords: [
      "sandbox",
      "cloud",
      "computer",
      "suspend",
      "resume",
      "destroy",
      "idle",
      "automations",
      "agent sandbox",
    ],
  },
});
