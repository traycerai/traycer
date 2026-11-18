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

/** A task in Needs you: the name the person knows it by, and when its oldest request was made. */
interface NeedsYouTask {
  readonly name: string;
  /** `null` while no prompt is loaded for it: the session says it waits, nothing more. */
  readonly since: number | null;
}

/**
 * The tasks in Needs you, each by a key it keeps across moves. A task is keyed
 * by its epic whether or not it has a tab in the strip, so opening its tab or
 * answering its oldest prompt is not an arrival; a prompt that names no task
 * is keyed by itself.
 */
function needsYouTasksOf(
  sections: ReadonlyArray<StripSectionGroup>,
): ReadonlyMap<string, NeedsYouTask> {
  const tasks = new Map<string, NeedsYouTask>();
  for (const { entries } of sections) {
    for (const entry of entries) {
      if (entry.kind === "prompt") {
        const epicId = needsYouItemEpicId(entry.item);
        tasks.set(
          epicId === null ? `prompt:${entry.item.row.feedId}` : epicId,
          {
            name: displayTitle(entry.item.taskTitle, "epic"),
            since: entry.row.createdAt,
          },
        );
        continue;
      }
      for (const { tab, row } of entry.members) {
        if (row.section === "needs-you") {
          tasks.set(tab.kind === "epic" ? tab.epicId : tabRefKey(tab), {
            name: displayTitle(tab.name, "epic"),
            since: row.createdAt,
          });
        }
      }
    }
  }
  return tasks;
}

/**
 * The announcement for tasks that arrive in Needs you, once each: "Staging CDP
 * verification needs you". An arrival is a task whose oldest request was made
 * after this announcer mounted: the notification and activity stores fill in
 * after the list appears, so a task that was already waiting shows up late and
 * is not news. A task the session says is waiting but with no prompt loaded has
 * no request time and is not announced until its prompt arrives. No other move
 * is announced. It follows the tasks' sections, not where a held row is drawn,
 * since what a screen reader user needs to hear is that the task needs them.
 */
export function useNeedsYouAnnouncement(
  sections: ReadonlyArray<StripSectionGroup>,
): NeedsYouAnnouncement {
  const tasks = needsYouTasksOf(sections);
  const signature = [...tasks]
    .map(([key, { since }]) => `${key}@${String(since)}`)
    .join("\n");
  const [mountedAt] = useState(() => Date.now());
  const [seen, setSeen] = useState({
    signature,
    tasks,
    announcement: { id: 0, text: "" },
  });
  if (signature !== seen.signature) {
    const arrived = [...tasks]
      .filter(
        ([key, { since }]) =>
          since !== null &&
          since > mountedAt &&
          (seen.tasks.get(key)?.since ?? null) === null,
      )
      .map(([, { name }]) => `${name} needs you`);
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
