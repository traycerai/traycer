import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

/** The Storage page's search entry, and its one row. */
export const STORAGE = defineSettingsSection("storage", {
  page: {
    availableWhen: alwaysAvailable,
    label: "Storage",
    description: "What this environment's hosts keep on disk.",
    keywords: [
      "storage",
      "disk",
      "disk space",
      "free space",
      "free up space",
      "full",
    ],
  },
  // Gated on the host advertising the item write, which no shell predicate
  // can decide, so it folds into the page's entry: a result must land
  // somewhere.
  freeUpSpace: {
    kind: "row",
    group: null,
    search: { contributesTo: "page" },
    label: "Free up space on this computer",
    description:
      "Keep chats and artifacts of tasks you haven't used lately in the cloud instead of on disk. Applies on every host in this environment.",
    availableWhen: alwaysAvailable,
    keywords: ["cloud", "chats", "artifacts"],
  },
});
