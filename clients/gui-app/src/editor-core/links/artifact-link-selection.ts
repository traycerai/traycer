import type { Editor, Range } from "@tiptap/core";

export function isSingleTextblockLinkRange(
  editor: Editor,
  range: Range,
): boolean {
  const from = editor.state.doc.resolve(range.from);
  const to = editor.state.doc.resolve(range.to);
  const linkType = editor.schema.marks.link;
  if (
    !from.sameParent(to) ||
    !from.parent.isTextblock ||
    !from.parent.type.allowsMarkType(linkType)
  ) {
    return false;
  }
  let excludesLink = false;
  editor.state.doc.nodesBetween(range.from, range.to, (node) => {
    if (
      node.marks.some(
        (mark) => mark.type !== linkType && mark.type.excludes(linkType),
      )
    ) {
      excludesLink = true;
    }
  });
  return !excludesLink;
}

export function canUseArtifactLinkControl(editor: Editor): boolean {
  const { from, to } = editor.state.selection;
  if (from === to) return editor.isActive("link");
  return isSingleTextblockLinkRange(editor, { from, to });
}
