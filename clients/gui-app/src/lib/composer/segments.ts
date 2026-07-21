/**
 * Composer prompt parsing: splits text into mention tokens and plaintext segments.
 * Unrelated to tool input summarization; see src/lib/segment-summary.ts for display summaries.
 */
import type { ComposerPromptSegment } from "./types";

export const MENTION_TOKEN_REGEX = /(^|\s)@([^\s@]+)(?=\s|$)/g;
const COMPLETE_ENTITY_TOKEN_REGEX =
  /^(epic:[^/\s]+|(spec|ticket|story|review|chat|terminal-agent):[^/\s]+\/[^\s]+)$/u;

interface MentionTokenMatch {
  path: string;
  start: number;
  end: number;
}

function pushTextSegment(
  segments: ComposerPromptSegment[],
  text: string,
): void {
  if (!text) return;
  const last = segments.length > 0 ? segments[segments.length - 1] : null;
  if (last && last.type === "text") {
    last.text += text;
    return;
  }
  segments.push({ type: "text", text });
}

function collectMentionMatches(text: string): MentionTokenMatch[] {
  const matches: MentionTokenMatch[] = [];
  for (const match of text.matchAll(MENTION_TOKEN_REGEX)) {
    const fullMatch = match[0];
    const prefix = match[1];
    const path = match[2];
    const matchIndex = match.index;
    const start = matchIndex + prefix.length;
    const end = start + fullMatch.length - prefix.length;
    const completeEndMention =
      end < text.length || COMPLETE_ENTITY_TOKEN_REGEX.test(path);
    if (path.length > 0 && completeEndMention) {
      matches.push({ path, start, end });
    }
  }
  return matches.toSorted((left, right) => left.start - right.start);
}

export function splitPromptIntoComposerSegments(
  prompt: string,
): ComposerPromptSegment[] {
  const segments: ComposerPromptSegment[] = [];
  if (!prompt) {
    return segments;
  }

  const matches = collectMentionMatches(prompt);
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue;
    if (match.start > cursor) {
      pushTextSegment(segments, prompt.slice(cursor, match.start));
    }
    segments.push({ type: "mention", path: match.path });
    cursor = match.end;
  }
  if (cursor < prompt.length) {
    pushTextSegment(segments, prompt.slice(cursor));
  }
  return segments;
}

export function collapsedPromptLength(prompt: string): number {
  return splitPromptIntoComposerSegments(prompt).reduce((total, segment) => {
    if (segment.type === "mention") return total + 1;
    return total + segment.text.length;
  }, 0);
}
