import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

export const DEVICES = defineSettingsSection("devices", {
  page: {
    availableWhen: alwaysAvailable,
    label: "Sessions",
    description:
      "Review where your account is signed in and remove access you no longer recognize.",
    keywords: [
      "devices",
      "sign out",
      "logout",
      "security",
      "account",
      "revoke",
      "login",
    ],
  },
});
