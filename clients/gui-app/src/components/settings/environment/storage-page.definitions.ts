import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

/**
 * The Storage page's search entry, and its rows. The rows are gated on the
 * host advertising the item write, which no shell predicate can decide, so
 * each folds into the page's entry: a result must land somewhere.
 */
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
  chats: {
    kind: "row",
    group: null,
    search: { contributesTo: "page" },
    label: "Chats",
    description:
      "Keep chats of tasks you haven't used lately in the cloud instead of on disk.",
    availableWhen: alwaysAvailable,
    keywords: ["cloud", "chats"],
  },
  artifacts: {
    kind: "row",
    group: null,
    search: { contributesTo: "page" },
    label: "Artifacts",
    description:
      "Keep artifacts of tasks you haven't used lately in the cloud instead of on disk.",
    availableWhen: alwaysAvailable,
    keywords: ["cloud", "artifacts"],
  },
  idleTasks: {
    kind: "row",
    group: null,
    search: { contributesTo: "page" },
    label: "Idle tasks",
    description: "When to clean up a task nobody has used.",
    availableWhen: alwaysAvailable,
    keywords: ["idle", "unused", "days"],
  },
  archivedChats: {
    kind: "row",
    group: null,
    search: { contributesTo: "page" },
    label: "Archived chats",
    description: "When to clean up a chat that stays archived.",
    availableWhen: alwaysAvailable,
    keywords: ["archived", "archive", "days"],
  },
});
