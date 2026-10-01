// Shared subagent display helpers consumed by BOTH the subagent renderer
// (`subagent-segment.tsx`) and the chat search projection (`chat-find.ts`).
// Keeping a single source means what the projection indexes can't drift from
// what the card actually renders (the previous duplication did exactly that).

import type {
  ChatMessage as ChatMessageModel,
  MessageSegment,
  SubagentChildSegment,
  SubagentSegment,
} from "@/stores/composer/chat-store";

export interface ProgressUpdateItem {
  readonly key: string;
  readonly text: string;
}

/**
 * The Result panel's presence rule: hidden whenever the card has at least one
 * child TEXT block, shown otherwise. Presence, never text comparison - the
 * result is the last all-text MESSAGE while a child is one BLOCK, and the same
 * text also comes back as the spawn tool's result under the CLI's hand-back
 * header, so any equality test breaks on whitespace or a multi-block final and
 * draws the answer twice. A browser-session row is a text block that carries no
 * prose, so it does not count.
 */
export function subagentHasChildText(
  children: ReadonlyArray<SubagentChildSegment>,
): boolean {
  return children.some(
    (child) => child.kind === "text" && child.browserSession === undefined,
  );
}

/**
 * The progress timeline a card draws: its lines minus every line whose trimmed
 * text is a child text block's trimmed text (an import records the subagent's
 * prose as progress too, and that prose now renders in the child list), then
 * adjacent-deduped. A line that matches no child - a model-authored summary -
 * stays. Which lines are per-tool noise is decided at the host, where the
 * provenance exists; this removes only what the child list already shows.
 */
export function subagentProgressItems(
  progressUpdates: ReadonlyArray<string>,
  children: ReadonlyArray<SubagentChildSegment>,
): ReadonlyArray<ProgressUpdateItem> {
  const childTexts = new Set(
    children.flatMap((child) =>
      child.kind === "text" ? [child.markdown.trim()] : [],
    ),
  );
  if (childTexts.size === 0) {
    return adjacentDedupedProgressItems(progressUpdates);
  }
  return adjacentDedupedProgressItems(
    progressUpdates.filter((update) => !childTexts.has(update.trim())),
  );
}

/**
 * Every card from the transcript root down to the card `id` names - the
 * open-as-chat breadcrumb trail - or `null` when no rendered row holds it
 * (the row left the loaded window, or the chat moved on).
 */
export function subagentCardPath(
  messages: ReadonlyArray<ChatMessageModel>,
  id: string,
): ReadonlyArray<SubagentSegment> | null {
  for (const message of messages) {
    const path = subagentCardPathIn(message.segments, id);
    if (path !== null) return path;
  }
  return null;
}

function subagentCardPathIn(
  segments: ReadonlyArray<MessageSegment | SubagentChildSegment>,
  id: string,
): ReadonlyArray<SubagentSegment> | null {
  for (const segment of segments) {
    if (segment.kind !== "subagent") continue;
    if (segment.id === id) return [segment];
    const below = subagentCardPathIn(segment.children, id);
    if (below !== null) return [segment, ...below];
  }
  return null;
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
