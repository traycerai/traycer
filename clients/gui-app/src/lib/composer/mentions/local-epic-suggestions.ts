import type {
  EpicMentionEpicSuggestion,
  TaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { EpicLight } from "@traycer/protocol/host/epic/unary-schemas";
import { isSubsequence } from "@traycer/protocol/utils/text/fuzzy";
import {
  isTaskMentionAliasQuery,
  taskMentionDisplayTitle,
} from "./task-mention-helpers";

export function buildEpicMentionSuggestionsFromTasks(
  tasks: ReadonlyArray<TaskLight>,
  query: string,
  limit: number,
): ReadonlyArray<EpicMentionEpicSuggestion> {
  const epics = tasks.flatMap((task) => {
    const light = task.epic?.light;
    return light === null || light === undefined ? [] : [light];
  });
  return rankEpics(epics, query, limit).map(buildSuggestion);
}

function buildSuggestion(epic: EpicLight): EpicMentionEpicSuggestion {
  return {
    kind: "epic",
    id: `epic:${epic.id}`,
    token: `epic:${epic.id}`,
    epicId: epic.id,
    label: taskMentionDisplayTitle(epic),
    description: countDescription(epic),
    status: epic.status,
    updatedAt: epic.updatedAt,
  };
}

function rankEpics(
  epics: ReadonlyArray<EpicLight>,
  query: string,
  limit: number,
): ReadonlyArray<EpicLight> {
  const normalized = query.trim().toLowerCase();
  return epics
    .flatMap((epic) => {
      const score = scoreEpic(epic, normalized);
      if (score === null) return [];
      return [{ epic, score, recency: -epic.updatedAt }];
    })
    .toSorted((left, right) =>
      left.score === right.score
        ? left.recency - right.recency
        : left.score - right.score,
    )
    .map((item) => item.epic)
    .slice(0, limit);
}

function scoreEpic(epic: EpicLight, normalizedQuery: string): number | null {
  if (normalizedQuery.length === 0) return 0;
  if (isTaskMentionAliasQuery(normalizedQuery)) return 250;
  const label = taskMentionDisplayTitle(epic).toLowerCase();
  const id = `epic:${epic.id}`.toLowerCase();
  if (label === normalizedQuery || id === normalizedQuery) return 0;
  if (label.startsWith(normalizedQuery)) return 100;
  if (label.includes(normalizedQuery)) return 200;
  if (id.includes(normalizedQuery)) return 300;
  if (
    isSubsequence(normalizedQuery, label) ||
    isSubsequence(normalizedQuery, id)
  ) {
    return 400 + label.length;
  }
  return null;
}

function countDescription(epic: EpicLight): string {
  return [
    countLabel(epic.specCount, "spec", "specs"),
    countLabel(epic.ticketCount, "ticket", "tickets"),
    countLabel(epic.storyCount, "story", "stories"),
    countLabel(epic.reviewCount, "review", "reviews"),
  ]
    .filter((value) => value.length > 0)
    .join(", ");
}

function countLabel(count: number, singular: string, plural: string): string {
  if (count <= 0) return "";
  return `${count} ${count === 1 ? singular : plural}`;
}
