/**
 * Display filter for the orchestration prelude. The fork injects role/team
 * context by prefixing the chat's first user message at creation time; the
 * block is model-facing context, not user input, so the chat bubble renders
 * the message without it. The stored/sent content is never mutated here —
 * this is presentation-only.
 *
 * Markers (emitted by the CLI's orchestration store):
 *   <!-- traycer-orchestration-prelude --> ... <!-- /traycer-orchestration-prelude -->
 */
import type { JsonContent } from "@traycer/protocol/common/registry";

export const ORCHESTRATION_PRELUDE_START =
  "<!-- traycer-orchestration-prelude -->";
export const ORCHESTRATION_PRELUDE_END =
  "<!-- /traycer-orchestration-prelude -->";

/**
 * Returns the message with the prelude span removed. Fail-open everywhere:
 * no markers, an unterminated marker, or a message that would become empty
 * (prelude-only) all return the input unchanged.
 */
export function stripOrchestrationPrelude(content: string): string {
  const start = content.indexOf(ORCHESTRATION_PRELUDE_START);
  if (start === -1) return content;
  const end = content.indexOf(
    ORCHESTRATION_PRELUDE_END,
    start + ORCHESTRATION_PRELUDE_START.length,
  );
  if (end === -1) return content;
  const after = end + ORCHESTRATION_PRELUDE_END.length;
  const before = content.slice(0, start).trimEnd();
  const following = content.slice(after).replace(/^\s+/, "");
  const joined = (before.length > 0 ? `${before}\n\n` : "") + following;
  if (joined.trim().length === 0) return content;
  return joined;
}

/**
 * Structured-doc variant of {@link stripOrchestrationPrelude}. The create-time
 * injection prepends the prelude as whole paragraphs (one block per line), so
 * in stored messages both markers own their entire top-level block. Removes
 * the block span from the START-marker block through the END-marker block
 * (inclusive), then drops empty paragraphs left at the seam. Fail-open like
 * the string variant: missing/unterminated markers, markers sharing a block
 * with other text (the injector never emits those), or a doc that would
 * become empty all return the input unchanged. Presentation-only — callers
 * must never persist the result.
 */
export function stripOrchestrationPreludeFromDoc(
  doc: JsonContent,
): JsonContent {
  const blocks = doc.content;
  if (!Array.isArray(blocks)) return doc;
  const startIdx = blocks.findIndex((block) =>
    blockText(block).includes(ORCHESTRATION_PRELUDE_START),
  );
  if (startIdx === -1) return doc;
  const endIdx = blocks.findIndex(
    (block, index) =>
      index > startIdx && blockText(block).includes(ORCHESTRATION_PRELUDE_END),
  );
  if (endIdx === -1) return doc;
  const startOwnsBlock =
    blockText(blocks[startIdx]).trim() === ORCHESTRATION_PRELUDE_START;
  const endOwnsBlock =
    blockText(blocks[endIdx]).trim() === ORCHESTRATION_PRELUDE_END;
  if (!startOwnsBlock || !endOwnsBlock) return doc;
  const kept = [...blocks.slice(0, startIdx), ...blocks.slice(endIdx + 1)];
  // Drop the empty paragraphs the injector left right after the END marker —
  // they now sit at the removal seam (index startIdx), mid-doc or at the head.
  let seamEnd = startIdx;
  while (seamEnd < kept.length && isEmptyParagraph(kept[seamEnd])) seamEnd += 1;
  const next = [...kept.slice(0, startIdx), ...kept.slice(seamEnd)];
  if (next.every(isEmptyParagraph)) return doc;
  return { ...doc, content: next };
}

function blockText(node: JsonContent): string {
  const parts: string[] = [];
  const walk = (current: JsonContent): void => {
    if (current.type === "text" && typeof current.text === "string") {
      parts.push(current.text);
    }
    (current.content ?? []).forEach(walk);
  };
  walk(node);
  return parts.join("");
}

function isEmptyParagraph(node: JsonContent): boolean {
  return node.type === "paragraph" && blockText(node).trim().length === 0;
}
