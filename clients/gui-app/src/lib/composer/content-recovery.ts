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
  /** A slash chip whose `/name` will not round-trip from where it sits. */
  | "command"
  /** A node kind nothing has classified - see the fail-closed rule below. */
  | "unknown";

/**
 * Node kinds whose meaning survives as text, so copying the projection back
 * into the composer reproduces the request.
 *
 * `mermaidBlock` / `uiPreviewBlock` belong here only because
 * {@link recoveryTextFromContent} carries their source. They are ATOMS
 * (`atom: true`) whose text lives in `attrs.code` / `attrs.htmlContent`, so
 * the shared projection - which walks children - emits nothing for them.
 * "Text-complete" means complete IN THE RECOVERY TEXT, so an entry here is a
 * claim about what that seam produces, not about the shared projection; the
 * two must agree, and `content-recovery-classification.test.ts` asserts it.
 *
 * `slashCommand` is deliberately ABSENT. An earlier note claimed it was
 * text-complete because the editor only permits a chip at the leading
 * position, where `parseLeadingSlashCommand` rebuilds it - but
 * `isLegalSlashChip` EXEMPTS `kind === "skill"`, which is legal anywhere. A
 * non-leading skill chip projects to a `/name` the converter will not rebuild,
 * so it is a real loss and the claim was false for half the chips. Whether it
 * survives depends on kind AND position, which no type-only set can express.
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
  // `slashCommand` is NOT here: whether it survives depends on its kind and
  // its position, which a type-only set cannot express. See `lostSlashChip`.
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
 * Marks are invisible to a `node.type` walk. These are visible formatting the
 * user can see is missing and retype. `link` is not listed here but is not a
 * loss either - {@link linkedTextNode} emits its target into the text, so it
 * is text-complete via the seam.
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
  visitSiblings([content], counts, firstInlineNode(content));
  return counts;
}

/**
 * Walk one parent's children together, so a link split across several `text`
 * nodes counts ONCE.
 *
 * Tiptap breaks a marked run wherever another mark, a `hardBreak` or an inline
 * node interrupts it, so a single link across a bold word arrives as three
 * text nodes carrying the same `link` mark - and counting per node reported
 * "Its 3 links". The rule: CONSECUTIVE siblings carrying the same `href` are
 * one link. A non-adjacent occurrence counts again even with an identical
 * href, because a second link somewhere else is a second thing to re-add.
 */
function visitSiblings(
  nodes: ReadonlyArray<JsonContent>,
  counts: Map<ContentRecoveryLoss, number>,
  leadingNode: JsonContent | null,
): void {
  for (const node of nodes) {
    const loss = lossForNodeType(node.type);
    if (loss !== null) {
      counts.set(loss, (counts.get(loss) ?? 0) + 1);
    }
    if (lostSlashChip(node, leadingNode)) {
      counts.set("command", (counts.get("command") ?? 0) + 1);
    }
    for (const mark of node.marks ?? []) {
      if (mark.type === "link") continue;
      if (TEXT_COMPLETE_MARK_TYPES.has(mark.type)) continue;
      counts.set("unknown", (counts.get("unknown") ?? 0) + 1);
    }
    // Recurse regardless: a sourced quote can wrap a mention, and both losses
    // are real. Only the node's OWN kind decides its own classification.
    visitSiblings(node.content ?? [], counts, leadingNode);
  }
}

/**
 * Whether this slash chip will fail to come back.
 *
 * The raw-text converter only rebuilds a LEADING `/name`, so a chip anywhere
 * else pastes as prose. Native commands cannot BE anywhere else - the editor's
 * guard holds them to the leading position - but skills are exempt from that
 * guard and legal mid-sentence, which is exactly the case the old
 * text-complete claim got wrong.
 */
function lostSlashChip(
  node: JsonContent,
  leadingNode: JsonContent | null,
): boolean {
  if (node.type !== "slashCommand") return false;
  const kind = node.attrs?.kind;
  // A native command cannot BE anywhere but leading - the editor's guard holds
  // it there - so its `/name` always round-trips.
  if (kind === "slash-command") return false;
  // A skill is legal anywhere (`isLegalSlashChip` exempts it), and only a
  // LEADING one is rebuilt by `parseLeadingSlashCommand`.
  if (kind === "skill") return node !== leadingNode;
  // FAIL CLOSED. An unrecognised or missing kind gets no assumption of
  // round-tripping: the same rule the node and mark classifications follow,
  // and the one that would have caught `"command"` - a kind this module once
  // tested against and the protocol never had.
  return true;
}

/** The document's first inline node - the only position that round-trips. */
function firstInlineNode(content: JsonContent): JsonContent | null {
  const children = content.content ?? [];
  if (children.length === 0) return null;
  const first = children[0];
  return (first.content ?? []).length === 0 ? first : firstInlineNode(first);
}

function lossForNodeType(type: string | undefined): ContentRecoveryLoss | null {
  if (type === undefined) return null;
  // Classified per NODE by `lostSlashChip` - kind and position decide it, so
  // the type-level walk must not also count it as unclassified.
  if (type === "slashCommand") return null;
  if (TEXT_COMPLETE_NODE_TYPES.has(type)) return null;
  if (TRANSPARENT_NODE_TYPES.has(type)) return null;
  return LOSSY_NODE_TYPES.get(type) ?? "unknown";
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
  // Text-complete VIA THE SEAM, like the atoms: `linkedTextNode` emits the
  // serializer's `[label](href)`, so nothing about a link is lost.
  "link",
  // Classified per node by `lostSlashChip` rather than by type.
  "slashCommand",
]);

/**
 * The text a recovery statement quotes back.
 *
 * `plainTextFromNode` joins a container's children with `""`, so a two-item
 * list projects to `foobar` - a mangling, not merely an unstyled rendering,
 * and quoting it would hand the user something they never wrote. Hoisting
 * list items out of their container routes them through a newline-joining
 * parent (`plainTextFromNodes` at the top, `blockquotePlainText` inside a
 * quote), and the walk rebuilds every OTHER container around processed
 * children so a nested list is reached wherever it sits.
 *
 * Done HERE rather than in the shared projection deliberately: that function
 * has seven other call sites (transcript rows, a length threshold, draft tab
 * names) and changing its join semantics under them is not an RC-week change.
 * The bullet markers are not reinstated - by this module's own criterion they
 * are visible in their absence and retypeable; the corruption is the bug.
 */
export function recoveryTextFromContent(content: JsonContent): string {
  // NO post-projection line stripping. The strip this replaced could not tell
  // an editor-contributed blank line from one the user typed - a shell script
  // starting with a blank line above `#!/bin/sh` lost it - because by then
  // both are just a newline.
  //
  // Nothing replaces it, and that is the point: `plainTextFromNodes` already
  // drops nodes that project to nothing, so empty wrapper paragraphs never
  // reach the output. Re-stripping at the node level would have been a no-op
  // dressed as a safeguard.
  return extractPlainTextFromComposerJSONContent({
    ...content,
    content: [...prepareForProjection(content.content ?? [])],
  });
}

/**
 * Reshape the tree so the shared projection can see everything the recovery
 * text owes the user: list items hoisted (above), and atom sources lifted into
 * text nodes.
 */
function prepareForProjection(
  nodes: ReadonlyArray<JsonContent>,
): ReadonlyArray<JsonContent> {
  // Links fold across SIBLINGS, so that pass runs over the list rather than
  // per node - see `foldLinkRuns`.
  return foldLinkRuns(nodes).flatMap((node) => {
    // A list container contributes nothing itself; its items become siblings
    // so the newline-joining entry point separates them.
    // Both list kinds go through one walk: bullets keep no marker but DO keep
    // their nesting, which is structure rather than decoration.
    if (isListNode(node)) {
      return numberedListItems(node);
    }
    if (node.type === "listItem") {
      return prepareForProjection(node.content ?? []);
    }
    const source = atomSource(node);
    if (source !== null) {
      return [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              // The atom serializers preserve a terminal newline, so this
              // does too: `attrs.code` / `attrs.htmlContent` are byte-exact
              // user data, and the agent received them unchanged.
              text: fenced(atomFenceLabel(node), source, false),
            },
          ],
        },
      ];
    }
    // A code block's fence and `language` live in the serializer's output and
    // in `attrs`, never in the child text - so copy-back dropped the language
    // entirely. Emitted here instead. RESIDUAL: the composer's paste path does
    // not re-promote fences (`FencePromotionExtension` is in the ARTIFACT
    // bundle only), so this restores the code and its language as readable
    // markdown, not the code-block node itself. That is the honest best.
    if (node.type === "codeBlock") {
      return [
        {
          type: "paragraph",
          content: [{ type: "text", text: fencedCodeBlock(node) }],
        },
      ];
    }
    // Rebuild ANY other container around processed children. Hoisting only at
    // the top level left a list nested in a blockquote untouched, so it still
    // joined as `foobar` - the round-5 fix reached one level and stopped.
    if (node.content === undefined) return [node];
    return [{ ...node, content: [...prepareForProjection(node.content)] }];
  });
}

/**
 * Ordered items keep their NUMBER; bullets deliberately do not keep their `-`.
 *
 * Both are markers, but they fail the module's criterion differently. A `- `
 * is visible in its absence - the reader sees a plain line and retypes the
 * dash. A number is not: the composer preserves a non-default `attrs.start`,
 * so dissolving `2. / 3.` into bare lines silently renumbers the user's steps
 * from 1 with nothing on screen saying so. That is invisible loss, which is
 * exactly what this module counts as a loss.
 */
function numberedListItems(list: JsonContent): ReadonlyArray<JsonContent> {
  return listItemLines(list, "").map((line) => ({
    type: "paragraph",
    content: [{ type: "text", text: line }],
  }));
}

/**
 * One line per item, with children INDENTED under their parent's marker.
 *
 * A nested list or a continuation paragraph used to contribute only its
 * parent's first line, so `1. parent` / `1. child` came back with the depth
 * and the association gone - two steps reading as siblings. Numbering is
 * computed per level, so a nested list restarts from its own `start`.
 */
function listItemLines(
  list: JsonContent,
  indent: string,
): ReadonlyArray<string> {
  const rawStart = list.attrs?.start;
  const ordered = list.type === "orderedList";
  const start = typeof rawStart === "number" ? rawStart : 1;
  return (list.content ?? []).flatMap((item, index) => {
    const marker = ordered ? `${start + index}. ` : "";
    const childIndent = `${indent}${" ".repeat(marker.length > 0 ? marker.length : 2)}`;
    // Walked in DOCUMENT ORDER. Partitioning the blocks - prose first, nested
    // lists appended after - reordered an item whose sub-list is followed by a
    // continuation paragraph, so the trailing prose jumped above the steps it
    // was written to follow. Child order is content, not layout.
    const lines = (item.content ?? []).flatMap((block) => {
      if (isListNode(block)) return listItemLines(block, childIndent);
      const text = extractPlainTextFromComposerJSONContent({
        type: "doc",
        content: [...prepareForProjection([block])],
      });
      return text.length === 0
        ? []
        : text.split("\n").map((line) => `${childIndent}${line}`);
    });
    // The marker belongs on the item's first line, whatever kind of block
    // that turned out to be.
    if (lines.length === 0) return [`${indent}${marker}`.trimEnd()];
    const [first, ...rest] = lines;
    return [`${indent}${marker}${first.slice(childIndent.length)}`, ...rest];
  });
}

function isListNode(node: JsonContent): boolean {
  return node.type === "bulletList" || node.type === "orderedList";
}

function fencedCodeBlock(node: JsonContent): string {
  const language = node.attrs?.language;
  const info = typeof language === "string" ? language : "";
  const projected = extractPlainTextFromComposerJSONContent({
    type: "doc",
    content: [...(node.content ?? [])],
  });
  // `serializeCodeBlock` drops one terminal newline before the closing fence,
  // so this does too - parity, not preference.
  return fenced(info, projected, true);
}

/**
 * Fence a block the way its own serializer does.
 *
 * The label matches `json-content-serializer`'s (`mermaid`, `wireframe`, or a
 * code block's `language`), so the recovered text says what the block was -
 * raw HTML with no fence reads as pasted prose.
 *
 * PARITY is the rule for the terminal newline, and it differs per block
 * because the serializers differ: `serializeCodeBlock` drops one before the
 * closing fence, so we drop one; the atom arms do NOT, so we keep it. An
 * earlier version stripped everywhere on the grounds that a trailing blank
 * line is untidy for someone copying - but the source attrs are byte-exact
 * user data the agent actually received, and trimming them for tidiness is
 * mutating content to improve its looks. Parity says what the agent got;
 * cosmetics were never the standard this text is held to.
 */
function fenced(
  label: string,
  body: string,
  stripTerminalNewline: boolean,
): string {
  const inner =
    stripTerminalNewline && body.endsWith("\n") ? body.slice(0, -1) : body;
  return ["```" + label, inner, "```"].join("\n");
}

/**
 * Fold consecutive same-href text nodes into ONE `[label](href)`.
 *
 * The same adjacency rule counting uses: Tiptap splits a marked run wherever
 * another mark interrupts it, so one link across a bold word arrives as three
 * text nodes. Wrapping each independently emitted three links where the user
 * wrote one - the identical mistake counting made before `-4IH`, so it takes
 * the identical rule rather than a second one that could drift from it.
 *
 * Non-adjacent runs stay separate, because those are genuinely two links.
 */
function foldLinkRuns(
  nodes: ReadonlyArray<JsonContent>,
): ReadonlyArray<JsonContent> {
  const out: JsonContent[] = [];
  let runHref: string | null = null;
  let runText = "";
  const flush = (): void => {
    if (runHref === null) return;
    out.push({ type: "text", text: `[${runText}](${runHref})` });
    runHref = null;
    runText = "";
  };
  for (const node of nodes) {
    const href = linkHrefOf(node);
    if (href === null) {
      flush();
      out.push(node);
      continue;
    }
    if (href !== runHref) flush();
    runHref = href;
    runText += node.text ?? "";
  }
  flush();
  return out;
}

/** The `href` this text node is linked with, if any. */
function linkHrefOf(node: JsonContent): string | null {
  if (node.type !== "text") return null;
  for (const mark of node.marks ?? []) {
    if (mark.type !== "link") continue;
    const href = mark.attrs?.href;
    if (typeof href !== "string" || href.length === 0) return null;
    return href;
  }
  return null;
}

function atomFenceLabel(node: JsonContent): string {
  return node.type === "mermaidBlock" ? "mermaid" : "wireframe";
}

/**
 * The text an ATOM node carries in its attrs. These blocks have no children,
 * so the shared projection emits nothing for them - but their source IS text,
 * and the notice can hand it back rather than telling someone their diagram is
 * gone when it did not have to be.
 */
const ATOM_SOURCE_ATTRS: ReadonlyMap<string, string> = new Map([
  ["mermaidBlock", "code"],
  ["uiPreviewBlock", "htmlContent"],
]);

function atomSource(node: JsonContent): string | null {
  const attrName =
    node.type === undefined ? undefined : ATOM_SOURCE_ATTRS.get(node.type);
  if (attrName === undefined) return null;
  const attr = node.attrs?.[attrName];
  return typeof attr === "string" && attr.length > 0 ? attr : null;
}
