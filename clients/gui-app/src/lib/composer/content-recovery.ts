import type { JsonContent } from "@traycer/protocol/common/registry";
import { serializeTextRun } from "@traycer/protocol/common/json-content-serializer";
import {
  extractPlainTextFromComposerJSONContent,
  isTransparentToLeadingScan,
} from "@/lib/composer/tiptap-json-content";

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
  /**
   * A blockquote's QUOTE-NESS. The text survives; the fact that it was quoted
   * does not, because neither paste path can rebuild the node.
   */
  | "quotedBlock"
  /** A table's grid. The cells survive as markdown; the node does not. */
  | "table"
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
 * `heading` is here on the TEXT claim, not on the node: the projection emits
 * the `#` markers `serializeHeading` sends, so the recovery copy is what the
 * agent received. Pasting it back yields a bold paragraph rather than a
 * heading - `markdown-paste` demotes every heading tag - which is the same
 * residual `codeBlock` carries and for the same reason.
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
  // Table PARTS are scaffolding for the grid their container emits.
  "tableRow",
  "tableHeader",
  "tableCell",
  // `blockquote` and `table` are NOT here - see `LOSSY_NODE_TYPES`. Their text
  // survives but their structure does not, because no paste path can rebuild
  // either node.
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

/**
 * Node kinds that carry something the projection drops, and what it is.
 *
 * `blockquote` is here on CONVERTIBILITY, which is the same criterion
 * {@link lostSlashChip} applies: the seam emits `> ...` faithfully, but both
 * paste paths deliberately dissolve a quote on the way back in -
 * `normalizeComposerMarkdownNode` hoists a parsed blockquote's children into
 * the doc, and `sanitizeMarkdownHtml` unwraps `<blockquote>` through
 * STRIP_TAGS. So a resend never rebuilds the node and so never reaches
 * `serializeBlockquote`'s `<user_quoted_section>`: the agent stops being told
 * which part was quoted.
 *
 * This is not in tension with marks being text-complete. For a mark the paste
 * path REBUILDS the structure from the delimiters, so parity and
 * convertibility agree; for a quote it cannot, and where the two diverge the
 * classification fails closed.
 */
const LOSSY_NODE_TYPES: ReadonlyMap<string, ContentRecoveryLoss> = new Map([
  ["image", "attachment"],
  ["imageAttachment", "attachment"],
  ["mention", "mention"],
  ["sourcedQuote", "quote"],
  ["blockquote", "quotedBlock"],
  // Same criterion as `blockquote`, and the composer settles it outright:
  // `buildComposerExtensions` has NO table extension (`@tiptap/extension-table`
  // is in the ARTIFACT bundle only), so the composer schema cannot hold a
  // table node and no paste can rebuild one from markdown table text. The
  // grid comes back as rows of prose.
  ["table", "table"],
]);

/**
 * Marks are invisible to a `node.type` walk, and these are not losses - but
 * the REASON changed, and the old one was wrong.
 *
 * Round 5 called them text-complete because the styling is visible in its
 * absence and the user can retype it. That was answering the wrong question:
 * the serializer emits `**` / `*` / `` ` `` / `~~` on the wire, so those
 * delimiters are what the agent actually receives, and a recovery copy
 * without them is a different request - `Use **not** production` recovered as
 * `Use not production`.
 *
 * They are non-losses now because {@link renderMarkedRuns} EMITS them, the
 * same way `link` has always been a non-loss via the seam rather than by
 * retypeability. Every entry here is a claim about what the seam produces,
 * which is the same rule the atom block types are held to.
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
  visitSiblings([content], counts, firstConvertibleInlineNode(content));
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
  // ONE rule for both kinds, because the thing that decides is the same for
  // both: can the raw converter rebuild the chip from where the recovery text
  // puts it.
  //
  // The native exemption used to be unconditional on the grounds that the
  // editor holds a native command at the leading position anyway. It does -
  // but `isLegalSlashChip` asks `leadingTokenBefore`, which is DOCUMENT-WIDE,
  // so a native command as the first token inside a leading blockquote or
  // ordered item is perfectly legal. The editor's "leading" and the
  // converter's are different questions, and only the converter's decides
  // whether the chip survives a copy-back.
  if (kind === "slash-command" || kind === "skill") {
    return node !== leadingNode;
  }
  // FAIL CLOSED. An unrecognised or missing kind gets no assumption of
  // round-tripping: the same rule the node and mark classifications follow,
  // and the one that would have caught `"command"` - a kind this module once
  // tested against and the protocol never had.
  return true;
}

/**
 * The serializer's list shape, mirrored so the recovery copy IS the markdown
 * the agent received: `serializeListItem` uses `options.bulletMarker ?? "-"`
 * and `options.listIndent ?? 2`, and this seam is only ever driven with the
 * defaults.
 */
const BULLET_MARKER = "-";
const LIST_INDENT = 2;

/**
 * Blocks the serializer indents by DEPTH even inside a list item.
 *
 * `getIndent` is `listDepth * listIndent`, and the three fence serializers
 * apply it to every line - the opening fence, the body, and the closing fence.
 * `serializeParagraph` deliberately does NOT (`inListItem` collapses its indent
 * to ""), so this is fence-specific rather than a property of block children in
 * general. Our seam emits fences at column zero, so the depth indent has to be
 * put back here or a continuation fence goes out two columns short of what the
 * agent received.
 */
const FENCE_NODE_TYPES: ReadonlySet<string> = new Set([
  "codeBlock",
  "mermaidBlock",
  "uiPreviewBlock",
]);

/**
 * Blocks whose own line prefix pushes their first child off column zero in the
 * RECOVERY TEXT.
 *
 * `LEADING_SLASH_COMMAND_REGEX` anchors at the start of the whole prompt and
 * accepts only spaces and tabs before the trigger, so anything else in front of
 * a `/name` - `> ` from a quote, `1. ` from an ordered item, `## ` from a
 * heading - stops the converter rebuilding it.
 *
 * MEMBERSHIP IS DECIDED BY THIS MODULE'S OWN EMISSION, and the two move
 * together: whoever teaches `prepareForProjection` to emit a new prefix owes
 * this set an entry in the same change. Both drifts so far were exactly that
 * omission - `bulletList` when bullets started emitting `- `, then `heading`
 * when headings started emitting `#` - and both shipped as a chip reported
 * SAFE that the converter would not rebuild, the quiet direction of the
 * failure. `content-recovery-classification.test.ts` now derives the expected
 * answer from `recoveryTextFromContent` and the converter's own parser rather
 * than from this list, so a third omission fails there instead of shipping.
 */
const LINE_PREFIXING_NODE_TYPES: ReadonlySet<string> = new Set([
  "blockquote",
  "sourcedQuote",
  "orderedList",
  "bulletList",
  "heading",
]);

/**
 * The one position a slash chip round-trips from: the leading token of the
 * recovery text, reached without passing through anything that prefixes its
 * line.
 *
 * Node position alone was the wrong question. A skill chip inside a leading
 * blockquote IS the document's first inline node, yet it recovers as
 * `> /review` and pastes back as prose. What decides it is the position the
 * CONVERTER parses, so the walk stops at any wrapper the seam prefixes -
 * matching what this module actually emits rather than what the tree looks
 * like.
 *
 * Two authorities meet here, and each owns its half:
 *
 * - what lands at column zero is a fact about THIS module's emission, so
 *   {@link LINE_PREFIXING_NODE_TYPES} is local and pinned to the seam by
 *   `content-recovery-classification.test.ts`;
 * - what counts as leading GIVEN column zero is the converter's, so
 *   {@link isTransparentToLeadingScan} is imported rather than restated.
 *
 * Hard-selecting `children[0]` restated the second half and got it wrong: an
 * indent-only text node became the "leading position", so `  /review` - which
 * `LEADING_SLASH_COMMAND_REGEX` rebuilds, spaces and all - was reported as a
 * chip the user had to re-pick.
 */
function firstConvertibleInlineNode(content: JsonContent): JsonContent | null {
  for (const child of content.content ?? []) {
    if (isTransparentToLeadingScan(child)) continue;
    if (LINE_PREFIXING_NODE_TYPES.has(child.type ?? "")) return null;
    return (child.content ?? []).length === 0
      ? child
      : firstConvertibleInlineNode(child);
  }
  return null;
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
  //
  // Separated the way `serializeDocument` separates them - `\n\n` between
  // TOP-LEVEL blocks - because the shared projection joins every surviving
  // node with a single `\n`, which makes a paragraph break indistinguishable
  // from a hard break in the copy. The optimistic row is gone by the time this
  // is read, so a blank line lost here cannot be reconstructed from anywhere.
  //
  // The grouping is by ORIGINAL block, not by prepared node: `prepareForProjection`
  // dissolves a list into one paragraph per item, and those are lines WITHIN
  // one block - `\n\n` between them would space out a list the serializer
  // keeps tight. Empty blocks drop out, matching `serializeDocument`'s own
  // `if (serialized)` guard.
  return (content.content ?? [])
    .map((block) =>
      extractPlainTextFromComposerJSONContent({
        ...content,
        content: [...prepareForProjection([block])],
      }),
    )
    .filter((text) => text.length > 0)
    .join("\n\n");
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
  return renderMarkedRuns(nodes).flatMap((node) => {
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
    if (node.type === "table") {
      return tableLines(node);
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
    // `serializeHeading` sends `${"#".repeat(level)} ${content}`, so a heading
    // recovered as its bare text is a DIFFERENT request - `## Title` came back
    // as `Title` and the level was gone the moment the optimistic row went.
    // Same shape and the same default as the wire (`readNumberAttr(..., 1)`).
    //
    // RESIDUAL, on the `codeBlock` precedent above: the TEXT is byte-exact,
    // but the NODE does not come back. `markdown-paste` actively DEMOTES
    // headings - `demoteHeadingsToBoldParagraphs` rewrites every `h1`-`h6`
    // into a bold paragraph - so a copy-back is prose whichever paste path it
    // takes. Text-complete is a claim about the TEXT, and it holds; the level
    // reaches the agent, which is what the send was asking for.
    if (node.type === "heading") {
      const rawLevel = node.attrs?.level;
      const level = typeof rawLevel === "number" ? rawLevel : 1;
      return [
        {
          type: "paragraph",
          content: [
            { type: "text", text: `${"#".repeat(level)} ` },
            ...prepareForProjection(node.content ?? []),
          ],
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
  return listItemLines(list, 1).map((line) => ({
    type: "paragraph",
    content: [{ type: "text", text: line }],
  }));
}

/**
 * One line per item, mirroring `serializeListItem` exactly - marker, indent
 * and continuation indent.
 *
 * A nested list or a continuation paragraph used to contribute only its
 * parent's first line, so `1. parent` / `1. child` came back with the depth
 * and the association gone - two steps reading as siblings. Numbering is
 * computed per level, so a nested list restarts from its own `start`.
 *
 * Bullets used to emit an EMPTY marker, on the reasoning that the structure is
 * visible in the indentation. Parity says otherwise: the serializer sends
 * `- item`, so a recovery copy without the dash is not the markdown the agent
 * received, and a nested bullet followed by a continuation paragraph came back
 * as two identically-indented lines with no way to tell which was which.
 *
 * The two indents are DIFFERENT and both come from the serializer. A
 * continuation paragraph is indented past its own marker
 * (`baseIndent + marker + 1`), but a NESTED LIST is indented by DEPTH alone -
 * `serializeListItem` pushes a nested list's lines unchanged, and the nested
 * level computes its own `baseIndent` from `listDepth`. Accumulating marker
 * widths instead put a sub-list under `1. ` at three columns where the
 * serializer puts it at two.
 */
function listItemLines(
  list: JsonContent,
  depth: number,
): ReadonlyArray<string> {
  const rawStart = list.attrs?.start;
  const ordered = list.type === "orderedList";
  const start = typeof rawStart === "number" ? rawStart : 1;
  const baseIndent = " ".repeat((depth - 1) * LIST_INDENT);
  return (list.content ?? []).flatMap((item, index) => {
    const marker = ordered ? `${start + index}.` : BULLET_MARKER;
    const continuationIndent = " ".repeat(
      baseIndent.length + marker.length + 1,
    );
    // `serializeListItem`'s loop, mirrored literally. Walked in DOCUMENT ORDER
    // - partitioning the blocks (prose first, nested lists appended after)
    // reordered an item whose sub-list is followed by a continuation
    // paragraph, so the trailing prose jumped above the steps it was written
    // to follow. Child order is content, not layout.
    //
    // The FIRST block goes in whole, behind the marker, with its own newlines
    // untouched: a `hardBreak` in the first paragraph is a bare "\n" on the
    // wire, so the serializer emits `- foo\nbar` with the second line at
    // column zero. Indenting every line and then stripping the first gave
    // `- foo\n  bar` - a continuation indent the agent never received.
    // Continuation indent belongs to LATER blocks only, per line, and a nested
    // list passes through unchanged because it already carries its own depth.
    // Applied BEFORE the first-child/continuation split, because the
    // serializer bakes it into the block's own text: a fence is already
    // indented when `serializeListItem` sees it, and the continuation indent
    // then goes on top of that.
    const fenceIndent = " ".repeat(depth * LIST_INDENT);
    const lines: string[] = [];
    let firstBlock = true;
    for (const block of item.content ?? []) {
      const nested = isListNode(block);
      const projected = nested
        ? listItemLines(block, depth + 1).join("\n")
        : extractPlainTextFromComposerJSONContent({
            type: "doc",
            content: [...prepareForProjection([block])],
          });
      const serialized = FENCE_NODE_TYPES.has(block.type ?? "")
        ? projected
            .split("\n")
            .map((line) => `${fenceIndent}${line}`)
            .join("\n")
        : projected;
      if (firstBlock) {
        lines.push(`${baseIndent}${marker} ${serialized}`);
        firstBlock = false;
        continue;
      }
      for (const line of serialized.split("\n")) {
        lines.push(nested ? line : `${continuationIndent}${line}`);
      }
    }
    if (lines.length === 0) return [`${baseIndent}${marker}`];
    return lines;
  });
}

function isListNode(node: JsonContent): boolean {
  return node.type === "bulletList" || node.type === "orderedList";
}

/**
 * A table as the markdown grid its serializer emits, one paragraph per line.
 *
 * The default container walk joins children with `""`, so a two-by-two table
 * projected to `envurlproda.test` - the `foobar` list mangling one level up,
 * and a quote of something the user never wrote. The grid is what makes the
 * cells mean anything, so the copy keeps it even though the NODE cannot be
 * rebuilt by pasting.
 *
 * The row shape mirrors `serializeTable`, escaping included, so the copy is
 * the markdown the agent actually received. Cell CONTENT deliberately routes
 * back through this module rather than the serializer: a mention inside a cell
 * has to read the same way as a mention anywhere else in the same quote, and
 * `jsonContentToMarkdown` would render it under its own `mentionFormat`.
 */
function tableLines(table: JsonContent): ReadonlyArray<JsonContent> {
  const header: string[] = [];
  const body: string[][] = [];
  for (const row of table.content ?? []) {
    if (row.type !== "tableRow") continue;
    const cells = (row.content ?? []).map((cell) =>
      // Block children of a CELL join with "", not with a newline:
      // `serializeTable` builds cell text through `serializeChildren`, whose
      // `parts.join("")` runs the two paragraphs of a multi-block cell
      // together. Projecting the cell as one doc instead put a newline between
      // them - a separator the agent never saw.
      (cell.content ?? [])
        .map((block) =>
          extractPlainTextFromComposerJSONContent({
            type: "doc",
            content: [...prepareForProjection([block])],
          }),
        )
        .join("")
        // A literal trailing `\` would otherwise escape the `\|` below and
        // merge two cells - the serializer escapes in this order for the same
        // reason.
        .replace(/\\/g, "\\\\")
        .replace(/\|/g, "\\|"),
    );
    const isHeader = (row.content ?? []).some(
      (cell) => cell.type === "tableHeader",
    );
    if (isHeader && header.length === 0) {
      header.push(...cells);
      continue;
    }
    body.push(cells);
  }
  const lines =
    header.length === 0
      ? []
      : [
          `| ${header.join(" | ")} |`,
          `| ${header.map(() => "---").join(" | ")} |`,
        ];
  for (const row of body) lines.push(`| ${row.join(" | ")} |`);
  return lines.map((line) => ({
    type: "paragraph",
    content: [{ type: "text", text: line }],
  }));
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
 * Render every inline mark the way the wire serializer renders it.
 *
 * PARITY, not retypeability. The earlier reasoning held bold/italic/inline-
 * code/strike to be text-complete because the user can see the styling is
 * missing and retype it - but `**` is what the agent actually receives, so a
 * recovery copy without it changes the request. `Use **not** production`
 * came back as `Use not production`, and once the optimistic row is gone
 * nothing else records which span was marked.
 *
 * It calls the serializer's own `serializeTextRun` rather than imitating it.
 * The run discipline is the subtle part - a mark stays open across a node
 * boundary, `code` is forced innermost, newly opened marks nest by
 * continuation length - and a second implementation would drift from the
 * thing it is supposed to match. Links come along for free: they are just
 * another entry in the serializer's delimiter table, so this subsumes the
 * fold-consecutive-hrefs pass it replaces, adjacency rule included.
 *
 * Runs are segmented exactly as `serializeChildren` segments them: consecutive
 * `text` nodes form a run, and any other inline node (a mention, a hardBreak)
 * ends it.
 */
function renderMarkedRuns(
  nodes: ReadonlyArray<JsonContent>,
): ReadonlyArray<JsonContent> {
  const out: JsonContent[] = [];
  let run: JsonContent[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    out.push({ type: "text", text: serializeTextRun(run) });
    run = [];
  };
  for (const node of nodes) {
    if (node.type === "text") {
      run.push(node);
      continue;
    }
    flush();
    out.push(node);
  }
  flush();
  return out;
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

/**
 * `null` means "not an atom" - never "an atom with nothing in it".
 *
 * Both editor nodes allow an empty source, and both serializers emit the
 * labeled fence regardless (`readStringAttr` yields `""` for a missing attr,
 * and the fence is built around it unconditionally). Treating empty as absent
 * dropped the block entirely, so an atom-only draft was reported as having no
 * recoverable content at all - the atom inversion again, one level down. The
 * block KIND is the content: a ` ```mermaid ` fence tells its author what they
 * had, and an empty one is what the agent would have received.
 */
function atomSource(node: JsonContent): string | null {
  const attrName =
    node.type === undefined ? undefined : ATOM_SOURCE_ATTRS.get(node.type);
  if (attrName === undefined) return null;
  const attr = node.attrs?.[attrName];
  return typeof attr === "string" ? attr : "";
}
