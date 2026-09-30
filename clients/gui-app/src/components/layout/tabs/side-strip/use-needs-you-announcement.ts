import { useState } from "react";
import { displayTitle } from "@/lib/display-title";
import { needsYouItemEpicId } from "@/stores/notifications/needs-you-items";
import { tabRefKey } from "@/stores/tabs/layout";
import type { StripSectionGroup } from "./strip-sections";

/** What the live region last said; `id` changes for each new announcement. */
export interface NeedsYouAnnouncement {
  readonly id: number;
  readonly text: string;
}

/**
 * The tasks in Needs you, each by a key it keeps across moves and the name the
 * person knows it by. A task is keyed by its epic whether or not it has a tab
 * in the strip, so opening its tab or answering its oldest prompt is not an
 * arrival; a prompt that names no task is keyed by itself.
 */
function needsYouTasksOf(
  sections: ReadonlyArray<StripSectionGroup>,
): ReadonlyMap<string, string> {
  const tasks = new Map<string, string>();
  for (const { entries } of sections) {
    for (const entry of entries) {
      if (entry.kind === "prompt") {
        const epicId = needsYouItemEpicId(entry.item);
        tasks.set(
          epicId === null ? `prompt:${entry.item.row.feedId}` : epicId,
          displayTitle(entry.item.taskTitle, "epic"),
        );
        continue;
      }
      for (const { tab, row } of entry.members) {
        if (row.section === "needs-you") {
          tasks.set(
            tab.kind === "epic" ? tab.epicId : tabRefKey(tab),
            displayTitle(tab.name, "epic"),
          );
        }
      }
    }
  }
  return tasks;
}

/**
 * The announcement for tasks that arrive in Needs you, once each: "Staging CDP
 * verification needs you". What the person already has in Needs you when the
 * list appears is not announced, and no other move is. It follows the tasks'
 * sections, not where a held row is drawn, since what a screen reader user
 * needs to hear is that the task needs them.
 */
export function useNeedsYouAnnouncement(
  sections: ReadonlyArray<StripSectionGroup>,
): NeedsYouAnnouncement {
  const tasks = needsYouTasksOf(sections);
  const signature = [...tasks.keys()].join("\n");
  const [seen, setSeen] = useState({
    signature,
    tasks,
    announcement: { id: 0, text: "" },
  });
  if (signature !== seen.signature) {
    const arrived = [...tasks]
      .filter(([key]) => !seen.tasks.has(key))
      .map(([, name]) => `${name} needs you`);
    setSeen({
      signature,
      tasks,
      announcement:
        arrived.length === 0
          ? seen.announcement
          : { id: seen.announcement.id + 1, text: arrived.join(". ") },
    });
  }
  return seen.announcement;
}
