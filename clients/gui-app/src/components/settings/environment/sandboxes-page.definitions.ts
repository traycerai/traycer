import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

/**
 * SLOT (the sandboxes plan replaces it with its page's definitions): the
 * Sandboxes page's search entry.
 */
export const SANDBOXES = defineSettingsSection("sandboxes", {
  page: {
    availableWhen: alwaysAvailable,
    label: "Sandboxes",
    description: "Sandboxes running on this configuration's settings.",
    keywords: ["sandbox", "cloud", "automations"],
  },
});
