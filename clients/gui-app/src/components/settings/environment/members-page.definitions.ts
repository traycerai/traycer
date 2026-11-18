import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

/** The Members page's search entry; the row shows only under a team. */
export const MEMBERS = defineSettingsSection("members", {
  page: {
    availableWhen: alwaysAvailable,
    label: "Members",
    description: "Who is in this team and what each person can change.",
    keywords: ["team", "invite", "role", "admin", "editor", "viewer", "seat"],
  },
});
