import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

export const SKILLS = defineSettingsSection("skills", {
  page: {
    availableWhen: alwaysAvailable,
    label: "Skills",
    description: "The skills each coding agent can use.",
    keywords: ["skill", "skills", "playbook", "install", "add to personal"],
  },
});
