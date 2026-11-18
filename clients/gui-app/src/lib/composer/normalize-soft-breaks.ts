import {
  Fragment,
  Slice,
  type Node as ProseMirrorNode,
  type Schema,
} from "@tiptap/pm/model";

/**
 * Rewrites a pasted slice so every soft newline is a paragraph boundary instead
 * of an inline `hardBreak` (or a literal `\n` inside a text node). Each visual
 * line then becomes its own textblock, so the native list/heading input rules
 * fire on every line - the composer no longer needs a custom plugin to start a
 * list on a non-first visual line.
 *
 * Only paragraph content (and loose top-level inline content) is split. Code
 * blocks keep their literal `\n`, and lists pass through untouched. When the
 * slice carries no soft break, the original slice is returned verbatim so a
 * plain single-line paste keeps its inline-merge behavior.
 */
export function normalizeSliceSoftBreaks(slice: Slice, schema: Schema): Slice {
  if (!fragmentHasSoftBreak(slice.content)) return slice;

  const blocks = splitFragmentIntoParagraphs(slice.content, schema);
  const fragment = Fragment.fromArray(blocks);

  // Open the paragraph boundaries (depth 1) so the leading block merges into the
  // caret's left remainder and the trailing block into the right remainder - the
  // standard "paste paragraphs into mid-text" behavior. A non-paragraph boundary
  // (list / code block) stays closed so it is inserted as its own block.
  const openStart = fragment.firstChild?.type.name === "paragraph" ? 1 : 0;
  const openEnd = fragment.lastChild?.type.name === "paragraph" ? 1 : 0;
  return new Slice(fragment, openStart, openEnd);
}

function fragmentHasSoftBreak(fragment: Fragment): boolean {
  let found = false;
  fragment.forEach((child) => {
    if (found) return;
    if (inlineHasSoftBreak(child)) {
      found = true;
      return;
    }
    // Only paragraph content is eligible for splitting; code blocks keep their
    // literal newlines and lists are left intact.
    if (child.type.name === "paragraph") {
      child.content.forEach((inline) => {
        if (inlineHasSoftBreak(inline)) found = true;
      });
    }
  });
  return found;
}

function inlineHasSoftBreak(node: ProseMirrorNode): boolean {
  if (node.type.name === "hardBreak") return true;
  return node.isText && (node.text ?? "").includes("\n");
}

function splitFragmentIntoParagraphs(
  fragment: Fragment,
  schema: Schema,
): ProseMirrorNode[] {
  const out: ProseMirrorNode[] = [];
  let inlineBuffer: ProseMirrorNode[] = [];

  const flushInline = (): void => {
    if (inlineBuffer.length === 0) return;
    out.push(
      ...splitInlineIntoParagraphs(
        Fragment.fromArray(inlineBuffer),
        schema,
        null,
      ),
    );
    inlineBuffer = [];
  };

  fragment.forEach((child) => {
    if (!child.isBlock) {
      // Loose top-level inline (e.g. the markdown branch unwraps a single
      // paragraph to its inline content). Buffer it, then split on flush.
      inlineBuffer.push(child);
      return;
    }
    flushInline();
    if (child.type.name === "paragraph") {
      out.push(
        ...splitInlineIntoParagraphs(child.content, schema, child.attrs),
      );
      return;
    }
    // Code blocks, lists, and any other block node pass through unchanged.
    out.push(child);
  });

  flushInline();
  return out;
}

function splitInlineIntoParagraphs(
  inline: Fragment,
  schema: Schema,
  attrs: Record<string, unknown> | null,
): ProseMirrorNode[] {
  const runs: ProseMirrorNode[][] = [[]];

  inline.forEach((node) => {
    if (node.type.name === "hardBreak") {
      runs.push([]);
      return;
    }
    if (node.isText && (node.text ?? "").includes("\n")) {
      const segments = (node.text ?? "").split("\n");
      segments.forEach((segment, index) => {
        if (index > 0) runs.push([]);
        if (segment.length > 0) {
          runs[runs.length - 1].push(schema.text(segment, node.marks));
        }
      });
      return;
    }
    // Plain text without a newline, or an inline atom (mention / slashCommand /
    // image) - keep it in the current run, marks intact.
    runs[runs.length - 1].push(node);
  });

  return runs.map((run) =>
    schema.nodes.paragraph.create(attrs, Fragment.fromArray(run)),
  );
}
