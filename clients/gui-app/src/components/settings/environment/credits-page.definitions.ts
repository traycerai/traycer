import { CREDITS_PAGE } from "@/components/settings/panels/credits-settings.definitions";
import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

/** The Credits page's search entry, from E8's page copy. */
export const CREDITS = defineSettingsSection("credits", {
  page: {
    availableWhen: alwaysAvailable,
    label: CREDITS_PAGE.label,
    description: CREDITS_PAGE.description,
    keywords: CREDITS_PAGE.keywords,
  },
});
