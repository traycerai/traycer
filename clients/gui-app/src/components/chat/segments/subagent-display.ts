// Shared subagent display helpers consumed by BOTH the subagent renderer
// (`subagent-segment.tsx`) and the chat search projection (`chat-find.ts`).
// Keeping a single source means what the projection indexes can't drift from
// what the card actually renders (the previous duplication did exactly that).

export interface ProgressUpdateItem {
  readonly key: string;
  readonly text: string;
}

/**
 * Strip Traycer task-notification wrapper markup from a subagent name / type /
 * task string, returning the human-readable inner text (or null when empty).
 * Plain strings pass through trimmed.
 */
export function cleanSubagentNotificationText(
  input: string | null,
): string | null {
  if (input === null) return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (!trimmed.toLowerCase().includes("<task-notification")) return trimmed;
  const message =
    extractTagText(trimmed, "message") ??
    extractTagText(trimmed, "prompt") ??
    extractTagText(trimmed, "task") ??
    extractTagText(trimmed, "summary") ??
    extractTagText(trimmed, "task-notification");
  const cleaned = stripMonitorEventPrefix(
    message ?? stripTaskNotificationMarkup(trimmed),
  ).trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Collapse runs of adjacent identical progress lines into one item, mirroring
 * exactly what the rendered progress list shows. Each surviving line gets a
 * stable key (content hash + nth-occurrence) so React reconciles in place.
 */
export function adjacentDedupedProgressItems(
  progressUpdates: ReadonlyArray<string>,
): ReadonlyArray<ProgressUpdateItem> {
  const seenCounts = new Map<string, number>();
  return progressUpdates.reduce<ProgressUpdateItem[]>((acc, update) => {
    if (acc.at(-1)?.text !== update) {
      const count = (seenCounts.get(update) ?? 0) + 1;
      seenCounts.set(update, count);
      acc.push({
        key: `${stableProgressUpdateHash(update)}:${count}`,
        text: update,
      });
    }
    return acc;
  }, []);
}

function extractTagText(input: string, tagName: string): string | null {
  const match = new RegExp(
    `<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`,
    "i",
  ).exec(input);
  if (match === null) return null;
  const value = match[1].trim();
  return value.length > 0 ? value : null;
}

function stripTaskNotificationMarkup(input: string): string {
  return input
    .replace(/<task-id>[\s\S]*?<\/task-id>/gi, "")
    .replace(/<task-notification\b[^>]*>/gi, "")
    .replace(/<\/task-notification>/gi, "")
    .replace(/<\/?(summary|message|prompt|task)>/gi, "");
}

function stripMonitorEventPrefix(input: string): string {
  return input.replace(/^Monitor event:\s*/i, "");
}

function stableProgressUpdateHash(update: string): string {
  let hash = 0;
  for (const char of update) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash.toString(36);
}
