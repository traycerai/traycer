import type { JsonContent } from "@traycer/protocol/common/registry";

/**
 * What a plain-text projection of composer content LOSES.
 *
 * The question this answers is narrow and deliberate: *can the user rebuild
 * this by retyping what they see?* Markdown structure - a heading's `#`, a
 * list's `-`, a code fence - is visible in its absence and trivially retyped,
 * so it is not a loss worth warning about; warning about it would fire on
 * ordinary prose and bury the cases that matter. What cannot be rebuilt is
 * data that is INVISIBLE in the projected text: attachment bytes, a mention's
 * workspace/host/entity binding, a quote's provenance. Those are the losses.
 */
export type ContentRecoveryLoss =
  /** Attachment bytes. Not in the text at all, not retypeable. */
  | "attachment"
  /** A mention's binding. `@path` survives; what it points at does not. */
  | "mention"
  /** A sourced quote's `sourceType` / `sourceId` / `sourceEpicId`. */
  | "quote"
  /** A node kind nothing has classified - see the fail-closed rule below. */
  | "unknown";

/**
 * Node kinds whose meaning survives as text, so copying the projection back
 * into the composer reproduces the request.
 *
 * `slashCommand` belongs here: it projects to the canonical `/name`, which is
 * exactly the string the composer's raw-text converter turns back into a chip
 * (`parseLeadingSlashCommand` / `buildSubmittedChatJSONContent`).
 */
const TEXT_COMPLETE_NODE_TYPES: ReadonlySet<string> = new Set([
  "doc",
  "paragraph",
  "text",
  "hardBreak",
  "heading",
  "bulletList",
  "orderedList",
  "listItem",
  "codeBlock",
  "mermaidBlock",
  "uiPreviewBlock",
  "blockquote",
  "table",
  "slashCommand",
]);

/** Node kinds that carry something the projection drops, and what it is. */
const LOSSY_NODE_TYPES: ReadonlyMap<string, ContentRecoveryLoss> = new Map([
  ["image", "attachment"],
  ["imageAttachment", "attachment"],
  ["attachmentGroup", "attachment"],
  ["mention", "mention"],
  ["sourcedQuote", "quote"],
]);

export type ContentRecoveryReport = ReadonlyMap<ContentRecoveryLoss, number>;

/**
 * Count what a plain-text projection of `content` would lose, by kind.
 *
 * TOTAL by construction. Every node kind is either listed as text-complete or
 * listed as lossy; anything else counts as `"unknown"` and earns a generic
 * qualification. That is the point: a node kind added to the editor - or to
 * `json-content-serializer`'s switch, which is the authoritative enumeration -
 * without anyone classifying it here must fail CLOSED. Two members of this
 * class shipped as silent losses already (attachments, then mentions, then
 * sourced quotes); the fail-closed default is what stops there being a fourth.
 *
 * `content-recovery-classification.test.ts` reads the serializer's switch and
 * fails if it names a kind neither set here covers, so the two enumerations
 * cannot drift apart unnoticed.
 */
export function classifyContentRecovery(
  content: JsonContent,
): ContentRecoveryReport {
  const counts = new Map<ContentRecoveryLoss, number>();
  visit(content, counts);
  return counts;
}

function visit(
  node: JsonContent,
  counts: Map<ContentRecoveryLoss, number>,
): void {
  const loss = lossForNodeType(node.type);
  if (loss !== null) {
    counts.set(loss, (counts.get(loss) ?? 0) + 1);
  }
  // Recurse regardless: a sourced quote can wrap a mention, and both losses
  // are real. Only the node's OWN kind decides its own classification.
  for (const child of node.content ?? []) {
    visit(child, counts);
  }
}

function lossForNodeType(type: string | undefined): ContentRecoveryLoss | null {
  if (type === undefined) return null;
  if (TEXT_COMPLETE_NODE_TYPES.has(type)) return null;
  return LOSSY_NODE_TYPES.get(type) ?? "unknown";
}

/** Exposed for the classification guard test only. */
export const CLASSIFIED_NODE_TYPES_FOR_TESTS: ReadonlySet<string> = new Set([
  ...TEXT_COMPLETE_NODE_TYPES,
  ...LOSSY_NODE_TYPES.keys(),
]);
