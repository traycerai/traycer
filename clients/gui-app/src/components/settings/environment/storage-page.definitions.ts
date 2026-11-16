import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

/**
 * The Storage page's search entry, its groups and their rows. They are gated
 * on the host advertising the item write, which no shell predicate can decide,
 * so each folds into the page's entry: a result must land somewhere. That is
 * also why the rows labelled "When" cannot land on the wrong one: there is one
 * entry, and every group shows on the page it opens.
 */
export const STORAGE = defineSettingsSection("storage", {
  page: {
    availableWhen: alwaysAvailable,
    label: "Storage",
    description: "What to keep on disk.",
    keywords: [
      "storage",
      "disk",
      "disk space",
      "free space",
      "free up space",
      "full",
    ],
  },
  idleTasks: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Tasks you haven't used lately",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: ["idle", "unused"],
  },
  chats: {
    kind: "row",
    group: "idleTasks",
    search: { contributesTo: "page" },
    label: "Chats",
    description: "Keep them in the cloud instead of on disk.",
    availableWhen: alwaysAvailable,
    keywords: ["cloud", "chats"],
  },
  idleTaskWindow: {
    kind: "row",
    group: "idleTasks",
    search: { contributesTo: "page" },
    label: "When",
    description: "When to clean up a task nobody has used.",
    availableWhen: alwaysAvailable,
    keywords: ["idle", "unused", "days"],
  },
  archivedChats: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Archived chats",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: ["archived", "archive"],
  },
  archivedChatWindow: {
    kind: "row",
    group: "archivedChats",
    search: { contributesTo: "page" },
    label: "When",
    description: "Counted from the chat's last activity.",
    availableWhen: alwaysAvailable,
    keywords: ["archived", "archive", "hours", "days"],
  },
  fileEditSnapshots: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "File edit snapshots",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: ["snapshots", "undo", "diffs"],
  },
  fileEditSnapshotWindow: {
    kind: "row",
    group: "fileEditSnapshots",
    search: { contributesTo: "page" },
    label: "When",
    description:
      "Counted from the chat's last activity. Older edits may lose Undo and diffs.",
    availableWhen: alwaysAvailable,
    keywords: ["snapshots", "undo", "diffs", "days"],
  },
});
