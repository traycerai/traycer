import { epicDisplayTitle, UNTITLED_EPIC_TITLE } from "@/lib/display-title";

const TASK_MENTION_ALIASES: ReadonlySet<string> = new Set([
  "task",
  "tasks",
  "epic",
  "epics",
]);

export const UNTITLED_TASK_TITLE = "Untitled task";

export function isTaskMentionAliasQuery(query: string): boolean {
  return TASK_MENTION_ALIASES.has(query.trim().toLowerCase());
}

export function taskMentionQueryForRequest(query: string): string {
  const trimmed = query.trim();
  return isTaskMentionAliasQuery(trimmed) ? "" : trimmed;
}

export function taskMentionDisplayTitle(epic: {
  readonly title: string;
  readonly initialUserPrompt: string;
}): string {
  if (epic.title.length > 0) return epic.title;
  const label = epicDisplayTitle(epic);
  return label === UNTITLED_EPIC_TITLE ? UNTITLED_TASK_TITLE : label;
}

export function taskMentionTitleFromRawTitle(rawTitle: string): string {
  return rawTitle.length > 0 ? rawTitle : UNTITLED_TASK_TITLE;
}
