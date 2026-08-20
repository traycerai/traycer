import type { JsonContent } from "@traycer/protocol/common/registry";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";

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
  /** A link mark whose label is not its `href`, so the target is nowhere. */
  | "link"
  /** A node kind nothing has classified - see the fail-closed rule below. */
  | "unknown";

/**
 * Node kinds whose meaning survives as text, so copying the projection back
 * into the composer reproduces the request.
 *
 * `slashCommand` belongs here: it projects to the canonical `/name`, which is
 * exactly the string the composer's raw-text converter turns back into a chip
 * (`parseLeadingSlashCommand` / `buildSubmittedChatJSONContent`). That leans
 * on the editor's LEADING-ONLY invariant - `chat-paste-handler` guards chip
 * insertion to the leading position, so a non-leading `slashCommand`, which
 * would not round-trip, is unconstructible in submitted content. If that
 * invariant ever relaxes, this entry moves to a counted clause.
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

/**
 * Pure scaffolding: carries nothing itself, so only its children are
 * classified. Counting the container too reports a two-image group as three
 * attachments and tells the user to re-add something that never existed - and
 * an EMPTY group as one, a loss that does not exist at all.
 */
const TRANSPARENT_NODE_TYPES: ReadonlySet<string> = new Set([
  "attachmentGroup",
]);

/** Node kinds that carry something the projection drops, and what it is. */
const LOSSY_NODE_TYPES: ReadonlyMap<string, ContentRecoveryLoss> = new Map([
  ["image", "attachment"],
  ["imageAttachment", "attachment"],
  ["mention", "mention"],
  ["sourcedQuote", "quote"],
]);

/**
 * Marks are invisible to a `node.type` walk, and one of them carries data.
 * A `link`'s `href` survives only when the label already IS the href; any
 * other label pastes back as prose with the target gone. The rest are visible
 * formatting the user can see is missing and retype.
 */
const TEXT_COMPLETE_MARK_TYPES: ReadonlySet<string> = new Set([
  "bold",
  "italic",
  "code",
  "strike",
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
  for (const mark of node.marks ?? []) {
    const markLoss = lossForMark(mark, node.text ?? "");
    if (markLoss !== null) {
      counts.set(markLoss, (counts.get(markLoss) ?? 0) + 1);
    }
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
  if (TRANSPARENT_NODE_TYPES.has(type)) return null;
  return LOSSY_NODE_TYPES.get(type) ?? "unknown";
}

function lossForMark(
  mark: { readonly type: string; readonly attrs?: Record<string, unknown> },
  text: string,
): ContentRecoveryLoss | null {
  if (TEXT_COMPLETE_MARK_TYPES.has(mark.type)) return null;
  if (mark.type !== "link") return "unknown";
  const href = mark.attrs?.href;
  if (typeof href !== "string" || href.length === 0) return null;
  return href === text ? null : "link";
}

/**
 * Every label the guard test must find classified - node kinds and marks
 * together, because the serializer enumerates both in `case` form and the
 * guard reads that enumeration rather than any brace-delimited slice of it.
 */
export const CLASSIFIED_LABELS_FOR_TESTS: ReadonlySet<string> = new Set([
  ...TEXT_COMPLETE_NODE_TYPES,
  ...TRANSPARENT_NODE_TYPES,
  ...LOSSY_NODE_TYPES.keys(),
  ...TEXT_COMPLETE_MARK_TYPES,
  "link",
]);

/**
 * The text a recovery statement quotes back.
 *
 * `plainTextFromNode` joins a container's children with `""`, so a two-item
 * list projects to `foobar` - a mangling, not merely an unstyled rendering,
 * and quoting it would hand the user something they never wrote. Hoisting
 * list items to top level routes them through `plainTextFromNodes`, which
 * joins with a newline.
 *
 * Done HERE rather than in the shared projection deliberately: that function
 * has seven other call sites (transcript rows, a length threshold, draft tab
 * names) and changing its join semantics under them is not an RC-week change.
 * The bullet markers are not reinstated - by this module's own criterion they
 * are visible in their absence and retypeable; the corruption is the bug.
 */
export function recoveryTextFromContent(content: JsonContent): string {
  return extractPlainTextFromComposerJSONContent({
    ...content,
    content: [...hoistListItems(content.content ?? [])],
  }).trim();
}

function hoistListItems(
  nodes: ReadonlyArray<JsonContent>,
): ReadonlyArray<JsonContent> {
  return nodes.flatMap((node) => {
    if (node.type === "bulletList" || node.type === "orderedList") {
      return hoistListItems(node.content ?? []);
    }
    if (node.type === "listItem") {
      return hoistListItems(node.content ?? []);
    }
    return [node];
  });
}
