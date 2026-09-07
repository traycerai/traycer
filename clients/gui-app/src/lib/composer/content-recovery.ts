import type { JsonContent } from "@traycer/protocol/common/registry";
import { serializeTextRun } from "@traycer/protocol/common/json-content-serializer";
import {
  extractPlainTextFromComposerJSONContent,
  isTransparentToLeadingScan,
} from "@/lib/composer/tiptap-json-content";

/** What a plain-text projection of composer content LOSES. */
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
   * A blockquote's QUOTE-NESS.
   * The text survives; the fact that it was quoted does not, because neither paste path can rebuild the node.
   */
  | "quotedBlock"
  /** A table's grid. The cells survive as markdown; the node does not. */
  | "table"
  /** A node kind nothing has classified - see the fail-closed rule below. */
  | "unknown";

/**
 * Node kinds whose meaning survives as text, so copying the projection back into the composer reproduces the request.
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
  // `blockquote` and `table` are NOT here - see `LOSSY_NODE_TYPES`.
  // Their text survives but their structure does not, because no paste path can rebuild either node.
]);

/**
 * Pure scaffolding: carries nothing itself, so only its children are classified.
 * Counting the container too reports a two-image group as three attachments and tells the user to re-add something that never existed - and an EMPTY group as one, a loss that does not exist at all.
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
  ["blockquote", "quotedBlock"],
  // Same criterion as `blockquote`, and the composer settles it outright: `buildComposerExtensions` has NO table extension (`@tiptap/extension-table` is in the ARTIFACT bundle only), so the composer schema cannot hold a table node and no paste can rebuild one.
  ["table", "table"],
]);

/**
 * Marks are invisible to a `node.type` walk, and these are not losses - but the REASON changed, and the old one was wrong.
 */
const TEXT_COMPLETE_MARK_TYPES: ReadonlySet<string> = new Set([
  "bold",
  "italic",
  "code",
  "strike",
]);

export type ContentRecoveryReport = ReadonlyMap<ContentRecoveryLoss, number>;

/** Count what a plain-text projection of `content` would lose, by kind. */
export function classifyContentRecovery(
  content: JsonContent,
): ContentRecoveryReport {
  const counts = new Map<ContentRecoveryLoss, number>();
  visitSiblings([content], counts, firstConvertibleInlineNode(content));
  return counts;
}

/** Walk one parent's children together, so a link split across several `text` nodes counts ONCE. */
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

/** Whether this slash chip will fail to come back. */
function lostSlashChip(
  node: JsonContent,
  leadingNode: JsonContent | null,
): boolean {
  if (node.type !== "slashCommand") return false;
  const kind = node.attrs?.kind;
  // ONE rule for both kinds, because the thing that decides is the same for both: can the raw converter rebuild the chip from where the recovery text puts it.
  if (kind === "slash-command" || kind === "skill") {
    return node !== leadingNode;
  }
  // FAIL CLOSED.
  // An unrecognised or missing kind gets no assumption of round-tripping: the same rule the node and mark classifications follow, and the one that would have caught `"command"` - a kind this module once tested against and the protocol never had.
  return true;
}

/**
 * The serializer's list shape, mirrored so the recovery copy IS the markdown the agent received: `serializeListItem` uses `options.bulletMarker ??
 * "-"` and `options.listIndent ?? 2`, and this seam is only ever driven with the defaults.
 */
const BULLET_MARKER = "-";
const LIST_INDENT = 2;

/** Blocks the serializer indents by DEPTH even inside a list item. */
const FENCE_NODE_TYPES: ReadonlySet<string> = new Set([
  "codeBlock",
  "mermaidBlock",
  "uiPreviewBlock",
]);

/** Blocks whose own line prefix pushes their first child off column zero in the RECOVERY TEXT. */
const LINE_PREFIXING_NODE_TYPES: ReadonlySet<string> = new Set([
  "blockquote",
  "sourcedQuote",
  "orderedList",
  "bulletList",
  "heading",
]);

/**
 * The one position a slash chip round-trips from: the leading token of the recovery text, reached without passing through anything that prefixes its line.
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
 * Every label the guard test must find classified - node kinds and marks together, because the serializer enumerates both in `case` form and the guard reads that enumeration rather than any brace-delimited slice of it.
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

/** The text a recovery statement quotes back. */
export function recoveryTextFromContent(content: JsonContent): string {
  // NO post-projection line stripping.
  // The strip this replaced could not tell an editor-contributed blank line from one the user typed - a shell script starting with a blank line above `#!/bin/sh` lost it - because by then both are just a newline.
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
 * Reshape the tree so the shared projection can see everything the recovery text owes the user: list items hoisted (above), and atom sources lifted into text nodes.
 */
function prepareForProjection(
  nodes: ReadonlyArray<JsonContent>,
): ReadonlyArray<JsonContent> {
  // Links fold across SIBLINGS, so that pass runs over the list rather than
  // per node - see `foldLinkRuns`.
  return renderMarkedRuns(nodes).flatMap((node) => {
    // A list container contributes nothing itself; its items become siblings so the newline-joining entry point separates them.
    // Both list kinds go through one walk: bullets keep no marker but DO keep their nesting, which is structure rather than decoration.
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
              // The atom serializers preserve a terminal newline, so this does too: `attrs.code` / `attrs.htmlContent` are byte-exact user data, and the agent received them unchanged.
              text: fenced(atomFenceLabel(node), source, false),
            },
          ],
        },
      ];
    }
    // A code block's fence and `language` live in the serializer's output and in `attrs`, never in the child text - so copy-back dropped the language entirely.
    // Emitted here instead.
    if (node.type === "codeBlock") {
      return [
        {
          type: "paragraph",
          content: [{ type: "text", text: fencedCodeBlock(node) }],
        },
      ];
    }
    // `serializeHeading` sends `${"#".repeat(level)} ${content}`, so a heading recovered as its bare text is a DIFFERENT request - `## Title` came back as `Title` and the level was gone the moment the optimistic row went.
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
    // Rebuild ANY other container around processed children.
    // Hoisting only at the top level left a list nested in a blockquote untouched, so it still joined as `foobar` - the round-5 fix reached one level and stopped.
    if (node.content === undefined) return [node];
    return [{ ...node, content: [...prepareForProjection(node.content)] }];
  });
}

/** Ordered items keep their NUMBER; bullets deliberately do not keep their `-`. */
function numberedListItems(list: JsonContent): ReadonlyArray<JsonContent> {
  return listItemLines(list, 1).map((line) => ({
    type: "paragraph",
    content: [{ type: "text", text: line }],
  }));
}

/** One line per item, mirroring `serializeListItem` exactly - marker, indent and continuation indent. */
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
    // `serializeListItem`'s loop, mirrored literally.
    // Walked in DOCUMENT ORDER
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

/** A table as the markdown grid its serializer emits, one paragraph per line. */
function tableLines(table: JsonContent): ReadonlyArray<JsonContent> {
  const header: string[] = [];
  const body: string[][] = [];
  for (const row of table.content ?? []) {
    if (row.type !== "tableRow") continue;
    const cells = (row.content ?? []).map((cell) =>
      // Block children of a CELL join with "", not with a newline: `serializeTable` builds cell text through `serializeChildren`, whose `parts.join("")` runs the two paragraphs of a multi-block cell together.
      (cell.content ?? [])
        .map((block) =>
          extractPlainTextFromComposerJSONContent({
            type: "doc",
            content: [...prepareForProjection([block])],
          }),
        )
        .join("")
        // A literal trailing `\` would otherwise escape the `\|` below and merge two cells - the serializer escapes in this order for the same reason.
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

/** Fence a block the way its own serializer does. */
function fenced(
  label: string,
  body: string,
  stripTerminalNewline: boolean,
): string {
  const inner =
    stripTerminalNewline && body.endsWith("\n") ? body.slice(0, -1) : body;
  return ["```" + label, inner, "```"].join("\n");
}

/** Render every inline mark the way the wire serializer renders it. */
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
 * The text an ATOM node carries in its attrs.
 * These blocks have no children, so the shared projection emits nothing for them - but their source IS text, and the notice can hand it back rather than telling someone their diagram is gone when it did not have to be.
 */
const ATOM_SOURCE_ATTRS: ReadonlyMap<string, string> = new Map([
  ["mermaidBlock", "code"],
  ["uiPreviewBlock", "htmlContent"],
]);

/** `null` means "not an atom" - never "an atom with nothing in it". */
function atomSource(node: JsonContent): string | null {
  const attrName =
    node.type === undefined ? undefined : ATOM_SOURCE_ATTRS.get(node.type);
  if (attrName === undefined) return null;
  const attr = node.attrs?.[attrName];
  return typeof attr === "string" ? attr : "";
}
