import type { JsonContent } from "@traycer/protocol/common/registry";

interface InsertImagesResult {
  readonly content: JsonContent[];
  readonly inserted: boolean;
}

export interface ComposerContentSelection {
  readonly from: number;
  readonly to: number;
}

export interface NormalizedComposerContent {
  readonly content: JsonContent;
  readonly selection: ComposerContentSelection | null;
  readonly changed: boolean;
}

interface NormalizeContentResult {
  readonly content: JsonContent;
  readonly changed: boolean;
  readonly removedLeadingSize: number;
  readonly insertedLeadingSize: number;
}

/**
 * Canonicalize composer JSON at app/editor boundaries.
 *
 * Legacy composers stored all images in a hidden leading `attachmentGroup`
 * block. New composer content keeps `imageAttachment` atoms inline where the
 * user inserted them, while the visible strip remains a projection over those
 * atoms. This rewrites only the legacy leading group shape; non-leading groups
 * are left readable for compatibility.
 */
export function normalizeComposerContent(content: JsonContent): JsonContent {
  return normalizeComposerContentResult(content).content;
}

export function normalizeComposerContentWithSelection(
  content: JsonContent,
  selection: ComposerContentSelection | null,
): NormalizedComposerContent {
  const normalized = normalizeComposerContentResult(content);
  const wrapped = wrapRootInlineNodes(normalized.content);
  return {
    content: wrapped,
    changed: normalized.changed || wrapped !== normalized.content,
    // Wrapping shifts every position after the first wrapped run, so a caret
    // saved against the unwrapped document names nothing.
    selection:
      wrapped === normalized.content
        ? normalizeSelection(selection, normalized)
        : null,
  };
}

const INLINE_NODE_TYPES: ReadonlySet<string> = new Set([
  "text",
  "hardBreak",
  "mention",
  "slashCommand",
  "imageAttachment",
  "fileAttachment",
]);

function isInlineNode(node: JsonContent): boolean {
  return node.type !== undefined && INLINE_NODE_TYPES.has(node.type);
}

/**
 * A `doc` holds blocks only. Content the editor builds from JSON is not
 * checked against that, and Tiptap's trailing-paragraph plugin then reads the
 * invalid doc on the next transaction and throws. A queued prompt carries its
 * browser-annotation crops as direct children of the doc
 * (`appendImageAttachmentAtoms`), so each run of such children is wrapped in a
 * paragraph here, where the editor takes the content.
 */
function wrapRootInlineNodes(content: JsonContent): JsonContent {
  if (content.type !== "doc") return content;
  const children = content.content ?? [];
  if (!children.some(isInlineNode)) return content;
  const wrapped: JsonContent[] = [];
  let run: JsonContent[] = [];
  const flushRun = (): void => {
    if (run.length === 0) return;
    wrapped.push({ type: "paragraph", content: run });
    run = [];
  };
  for (const child of children) {
    if (isInlineNode(child)) {
      run.push(child);
    } else {
      flushRun();
      wrapped.push(child);
    }
  }
  flushRun();
  return { ...content, content: wrapped };
}

function normalizeComposerContentResult(
  content: JsonContent,
): NormalizeContentResult {
  if (content.type !== "doc") return unchangedContent(content);
  const children = content.content ?? [];
  if (children.length === 0) return unchangedContent(content);

  const leading = collectLeadingAttachmentGroupImages(children);
  if (!leading.changed) return unchangedContent(content);

  if (leading.images.length === 0) {
    return {
      content: {
        ...content,
        content: leading.remaining,
      },
      changed: true,
      removedLeadingSize: leading.removedSize,
      insertedLeadingSize: 0,
    };
  }

  const inserted = prependImagesToFirstParagraph(
    leading.remaining,
    leading.images,
  );
  const imageSize = leading.images.reduce(
    (sum, image) => sum + jsonNodeSize(image),
    0,
  );
  const normalizedContent = {
    ...content,
    content: inserted.inserted
      ? inserted.content
      : [
          {
            type: "paragraph",
            content: leading.images,
          },
          ...leading.remaining,
        ],
  };
  return {
    content: normalizedContent,
    changed: true,
    removedLeadingSize: leading.removedSize,
    insertedLeadingSize: inserted.inserted ? imageSize : 2 + imageSize,
  };
}

function collectLeadingAttachmentGroupImages(
  children: ReadonlyArray<JsonContent>,
): {
  readonly changed: boolean;
  readonly images: JsonContent[];
  readonly remaining: JsonContent[];
  readonly removedSize: number;
} {
  const firstNonGroupIndex = children.findIndex(
    (child) => child.type !== "attachmentGroup",
  );
  const groupEnd =
    firstNonGroupIndex === -1 ? children.length : firstNonGroupIndex;
  if (groupEnd === 0) {
    return {
      changed: false,
      images: [],
      remaining: [...children],
      removedSize: 0,
    };
  }
  const groups = children.slice(0, groupEnd);
  return {
    changed: true,
    images: groups.flatMap((group) =>
      (group.content ?? []).filter((child) => child.type === "imageAttachment"),
    ),
    remaining: children.slice(groupEnd),
    removedSize: groups.reduce((sum, group) => sum + jsonNodeSize(group), 0),
  };
}

function prependImagesToFirstParagraph(
  children: ReadonlyArray<JsonContent>,
  images: ReadonlyArray<JsonContent>,
): InsertImagesResult {
  let inserted = false;
  const content = children.map((child) => {
    if (inserted) return child;
    const result = prependImagesToParagraphNode(child, images);
    inserted = result.inserted;
    return result.node;
  });
  return { content, inserted };
}

function prependImagesToParagraphNode(
  node: JsonContent,
  images: ReadonlyArray<JsonContent>,
): { readonly node: JsonContent; readonly inserted: boolean } {
  if (node.type === "paragraph") {
    return {
      node: {
        ...node,
        content: [...images, ...(node.content ?? [])],
      },
      inserted: true,
    };
  }

  const children = node.content;
  if (children === undefined) return { node, inserted: false };

  const result = prependImagesToFirstParagraph(children, images);
  if (!result.inserted) return { node, inserted: false };
  return {
    node: {
      ...node,
      content: result.content,
    },
    inserted: true,
  };
}

function normalizeSelection(
  selection: ComposerContentSelection | null,
  normalized: NormalizeContentResult,
): ComposerContentSelection | null {
  if (selection === null) return null;
  if (!normalized.changed) return selection;
  const from = normalizePosition(selection.from, normalized);
  const to = normalizePosition(selection.to, normalized);
  if (from === null || to === null) return null;
  return { from, to };
}

function normalizePosition(
  position: number,
  normalized: NormalizeContentResult,
): number | null {
  if (position <= normalized.removedLeadingSize) return null;
  const delta = normalized.removedLeadingSize - normalized.insertedLeadingSize;
  return clampPosition(position - delta, normalized.content);
}

function clampPosition(position: number, content: JsonContent): number {
  return Math.min(Math.max(0, position), jsonContentSize(content));
}

function jsonContentSize(node: JsonContent): number {
  return (node.content ?? []).reduce(
    (sum, child) => sum + jsonNodeSize(child),
    0,
  );
}

function jsonNodeSize(node: JsonContent): number {
  if (node.type === "text") return (node.text ?? "").length;
  const children = node.content;
  if (children === undefined) return 1;
  return 2 + children.reduce((sum, child) => sum + jsonNodeSize(child), 0);
}

function unchangedContent(content: JsonContent): NormalizeContentResult {
  return {
    content,
    changed: false,
    removedLeadingSize: 0,
    insertedLeadingSize: 0,
  };
}
