import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

export const SECRETS = defineSettingsSection("secrets", {
  page: {
    availableWhen: alwaysAvailable,
    label: "Secrets",
    description: "Values and logins your agents use.",
    keywords: [
      "secret",
      "api key",
      "token",
      "credential",
      "github",
      "password",
    ],
  },
});
