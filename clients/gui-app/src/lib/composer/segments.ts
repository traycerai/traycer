/**
 * Composer prompt parsing: splits text into mention tokens and plaintext segments.
 * Unrelated to tool input summarization; see src/lib/segment-summary.ts for display summaries.
 */
import type { ComposerPromptSegment } from "./types";

export const MENTION_TOKEN_REGEX = /(^|\s)@([^\s@]+)(?=\s|$)/g;
// `terminal-agent` and `terminal` can be listed in either order: the pattern is
// anchored at both ends, so a `terminal:` match on a `@terminal-agent:…` token
// leaves `-agent` unconsumed, fails the anchor, and backtracks into the longer
// arm. What the anchors buy is exactly that - no partial prefix can be
// mistaken for a whole token.
// `github-pr` / `github-issue` are listed ahead of the shorter prefixes for
// readability only - the alternation is anchored at both ends, so no prefix can
// swallow another's token.
// `browser-tab:<title>` carries no `/epicId` segment (a browser tab is not
// epic-entity-shaped the way `chat:`/`terminal:` are), so it gets its own
// bare alternative rather than joining the `type:epicId/id` group.
const COMPLETE_ENTITY_TOKEN_REGEX =
  /^(epic:[^/\s]+|browser-tab:[^/\s]+|(spec|ticket|story|review|chat|terminal-agent|terminal|github-pr|github-issue):[^/\s]+\/[^\s]+)$/u;

/**
 * A GitHub entity token ends at its reference, and nothing after it belongs.
 *
 * `MENTION_TOKEN_REGEX` captures a whole non-space run, and the entity pattern
 * accepts any non-space tail - so `@github-pr:acme/widgets#123,` carried the
 * comma INTO the path. The sent-message renderer then looks the attachment up
 * by that comma-suffixed path, misses the real one, and falls back to a generic
 * chip with the punctuation swallowed into its label. Typing a comma after a
 * mention is ordinary, so this is the common case rather than the exotic one.
 *
 * Trimmed only for GitHub tokens, and only because their grammar states where
 * they END: the reference is `#` followed by digits, so anything after the
 * final digit run provably is not part of the token. The other entity kinds
 * have no such terminator - trimming them would be guesswork about which
 * trailing characters are meaningful, and their behaviour here is unchanged.
 */
const GITHUB_ENTITY_TOKEN_REGEX = /^(?:github-pr|github-issue):[^\s]*#\d+/u;

/** The token itself, with any trailing non-reference characters returned to the text. */
function entityTokenWithoutTrailingText(path: string): string {
  return GITHUB_ENTITY_TOKEN_REGEX.exec(path)?.[0] ?? path;
}

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
    const prefix = match[1];
    const path = entityTokenWithoutTrailingText(match[2]);
    const matchIndex = match.index;
    const start = matchIndex + prefix.length;
    // Measured from the TRIMMED path, so whatever was trimmed falls back into
    // the following text segment instead of disappearing with the token.
    const end = start + "@".length + path.length;
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
