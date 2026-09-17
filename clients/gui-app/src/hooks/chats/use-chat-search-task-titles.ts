import { useMemo } from "react";
import { useCloudEpicTasksQuery } from "@/hooks/epics/use-cloud-epic-tasks-query";
import { chatSearchTaskTitleIndex } from "@/lib/chat-search/chat-search-results";

/**
 * Task names for chat search results, indexed once per task-list change rather
 * than looked up per row. Reads the same cached task list the Start page
 * renders, so a task the window has never opened still has a name.
 *
 * The list is what that query has loaded - its first page plus any "Show more"
 * tails - so a task beyond it has no entry and its results render no name.
 */
export function useChatSearchTaskTitles(): ReadonlyMap<string, string> {
  const { tasks } = useCloudEpicTasksQuery(undefined, { enabled: true });
  return useMemo(() => chatSearchTaskTitleIndex(tasks), [tasks]);
}
