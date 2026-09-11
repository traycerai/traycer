import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

export const LINK_PHONE = defineSettingsSection("link-phone", {
  page: {
    label: "Link mobile app",
    description: "Sign the Traycer mobile app in by scanning this code.",
    keywords: [
      "phone",
      "mobile",
      "qr",
      "pair",
      "link",
      "ios",
      "android",
      "code",
      "scan",
    ],
  },
});
