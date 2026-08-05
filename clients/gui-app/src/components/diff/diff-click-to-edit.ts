import type { Editor } from "@pierre/diffs/edit";

export interface DiffEditCaret {
  readonly lineNumber: number;
  readonly character: number;
}

const attachedEditors = new Map<string, Editor<undefined>>();

export function registerDiffEditor(
  surfaceId: string,
  editor: Editor<undefined>,
): () => void {
  attachedEditors.set(surfaceId, editor);
  return () => {
    if (attachedEditors.get(surfaceId) === editor) {
      attachedEditors.delete(surfaceId);
    }
  };
}

/** Test-only accessor for the real editor a surface's adapter registered - lets a regression test drive it the same way `focusRegisteredDiffEditor` does internally, without duplicating the registry. */
export function getRegisteredDiffEditor(
  surfaceId: string,
): Editor<undefined> | undefined {
  return attachedEditors.get(surfaceId);
}

export function focusRegisteredDiffEditor(
  surfaceId: string,
  caret: DiffEditCaret | null,
): boolean {
  const editor = attachedEditors.get(surfaceId);
  if (editor === undefined) return false;
  editor.focus(
    caret === null
      ? { lineNumber: "first-visible", preventScroll: true }
      : {
          lineNumber: caret.lineNumber,
          character: caret.character,
          preventScroll: true,
        },
  );
  return true;
}

export function isDiffEditActivationGesture(
  event: MouseEvent | PointerEvent,
): boolean {
  if (
    event.button !== 0 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  ) {
    return false;
  }

  const pathTarget = event.composedPath()[0];
  if (!(pathTarget instanceof Node)) return true;
  const selection = pathTarget.ownerDocument?.getSelection();
  if (
    selection === undefined ||
    selection === null ||
    selection.isCollapsed ||
    selection.anchorNode === null ||
    selection.focusNode === null
  ) {
    return true;
  }

  const targetRoot = pathTarget.getRootNode();
  return (
    selection.anchorNode.getRootNode() !== targetRoot ||
    selection.focusNode.getRootNode() !== targetRoot
  );
}

export function resolveTokenCaretCharacter(input: {
  readonly lineCharStart: number;
  readonly lineCharEnd: number;
  readonly tokenElement: HTMLElement;
  readonly clientX: number;
}): number {
  const { lineCharEnd, lineCharStart, tokenElement } = input;
  const characterCount = Math.max(0, lineCharEnd - lineCharStart);
  if (characterCount === 0) return lineCharStart;

  const bounds = tokenElement.getBoundingClientRect();
  if (bounds.width <= 0) return lineCharStart;
  const relativeX = Math.min(
    Math.max(input.clientX - bounds.left, 0),
    bounds.width,
  );
  const characterOffset = Math.round(
    (relativeX / bounds.width) * characterCount,
  );
  return Math.min(lineCharStart + characterOffset, lineCharEnd);
}

/**
 * Diffs emits a line callback without token metadata while its first
 * highlighted AST is still being prepared. Measure the rendered text nodes so
 * that path still restores the clicked UTF-16 character instead of column 0.
 */
export function resolveLineCaretCharacter(input: {
  readonly lineElement: HTMLElement;
  readonly clientX: number;
}): number {
  const { lineElement, clientX } = input;
  const walker = lineElement.ownerDocument.createTreeWalker(lineElement, 4);
  const range = lineElement.ownerDocument.createRange();
  let character = 0;
  let textNode = walker.nextNode();

  while (textNode !== null) {
    const text = textNode.nodeValue ?? "";
    if (
      text.length > 0 &&
      !isNodeEntirelyLeftOfClick(range, textNode, text, clientX)
    ) {
      const offset = resolveOffsetWithinNode(range, textNode, text, clientX);
      if (offset !== null) return character + offset;
    }
    character += text.length;
    textNode = walker.nextNode();
  }

  return character;
}

// Measures the whole node before walking it one UTF-16 code unit at a time -
// a long line (a minified bundle, say) can carry thousands of characters
// across many highlighted-token text nodes, and most of them sit entirely
// left of the click. Skip those in one measurement instead of one Range +
// getBoundingClientRect per character.
function isNodeEntirelyLeftOfClick(
  range: Range,
  textNode: Node,
  text: string,
  clientX: number,
): boolean {
  range.setStart(textNode, 0);
  range.setEnd(textNode, text.length);
  const bounds = range.getBoundingClientRect();
  return (bounds.width > 0 || bounds.height > 0) && clientX > bounds.right;
}

function resolveOffsetWithinNode(
  range: Range,
  textNode: Node,
  text: string,
  clientX: number,
): number | null {
  for (let offset = 0; offset < text.length; offset += 1) {
    range.setStart(textNode, offset);
    range.setEnd(textNode, offset + 1);
    const bounds = range.getBoundingClientRect();
    if (bounds.width > 0 || bounds.height > 0) {
      const midpoint = bounds.left + bounds.width / 2;
      if (clientX <= midpoint) return offset;
    }
  }
  return null;
}
