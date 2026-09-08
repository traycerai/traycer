import type { EditorState } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { buildQuoteBlockquote } from "@/components/chat/quote/append-quote-to-draft";

export interface ArtifactQuoteSnapshot {
  /** Document range at the moment of capture - for anchoring the picker only. */
  readonly from: number;
  readonly to: number;
  /**
   * The excerpt as composer blocks, frozen at capture. Positioning may follow
   * later edits; the content never does - the user chose THIS text.
   */
  readonly blocks: ReadonlyArray<JsonContent>;
}

/**
 * Freezes the editor's current selection into composer-shaped quote blocks.
 *
 * Shaping mirrors the transcript quote (`buildQuoteBlockquote`): a selection
 * wholly inside one code block becomes a single `codeBlock` carrying that
 * block's language (empty string when unlabelled), everything else becomes
 * one paragraph per line. The composer cannot hold headings, tables or the
 * artifact atoms, and the host flattens the quote to text anyway, so the
 * artifact's own structure is deliberately not carried over.
 *
 * Line structure IS carried: `textBetween` puts a separator between every
 * textblock (paragraphs, list items, table cells) and a hard break is turned
 * into a newline, so the excerpt reads the way it looked rather than as one
 * run-on line. The serializer only inserts newlines between direct children
 * of the quote, which is why this has to happen here.
 *
 * Returns `null` for a collapsed selection and for a table `CellSelection`,
 * whose selected cells are not the `from..to` interval.
 */
export function snapshotArtifactQuote(
  state: EditorState,
): ArtifactQuoteSnapshot | null {
  const { selection } = state;
  if (selection instanceof CellSelection) return null;
  const { from, to } = selection;
  if (from >= to) return null;

  const $from = state.doc.resolve(from);
  const $to = state.doc.resolve(to);
  const singleCodeBlock =
    $from.parent.type.name === "codeBlock" && $from.sameParent($to);

  if (singleCodeBlock) {
    return {
      from,
      to,
      blocks: quoteContent(
        buildQuoteBlockquote({
          text: state.doc.textBetween(from, to, "\n"),
          fenceLanguage: codeBlockLanguage($from.parent.attrs),
        }),
      ),
    };
  }

  const text = state.doc.textBetween(from, to, "\n", (leaf) =>
    leaf.type.name === "hardBreak" ? "\n" : "",
  );
  return {
    from,
    to,
    blocks: quoteContent(buildQuoteBlockquote({ text, fenceLanguage: null })),
  };
}

function quoteContent(blockquote: JsonContent): ReadonlyArray<JsonContent> {
  return blockquote.content ?? [];
}

/**
 * A code block's language, or the empty string for an unlabelled one - which
 * is what `buildQuoteBlockquote` reads as "a code block with no language",
 * matching the transcript quote. ProseMirror types every attribute as `any`,
 * so the read is narrowed here rather than trusted.
 */
function codeBlockLanguage(attrs: Record<string, unknown>): string {
  const language = attrs.language;
  return typeof language === "string" ? language : "";
}
