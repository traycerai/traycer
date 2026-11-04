import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

/** The Sandboxes page's search entry, and its storage row. */
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
  // Gated on the selected host advertising the item write, which no shell
  // predicate can decide, so it folds into the page's entry: a result must
  // land somewhere.
  freeUpSpace: {
    kind: "row",
    group: null,
    search: { contributesTo: "page" },
    label: "Free up space on this computer",
    description:
      "Keep chats and artifacts of tasks you haven't used lately in the cloud instead of on disk. Applies on every host in this environment.",
    availableWhen: alwaysAvailable,
    keywords: ["storage", "disk", "disk space", "free space", "full"],
  },
});
