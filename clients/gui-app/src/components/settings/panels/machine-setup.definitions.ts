import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

export const MACHINE_SETUP = defineSettingsSection("machine-setup", {
  page: {
    availableWhen: alwaysAvailable,
    label: "Machine setup",
    description:
      "A script each computer runs to set itself up: once when it first gets your settings, and again when you change it.",
    keywords: ["setup script", "bootstrap", "install", "provision", "retry"],
  },
});
