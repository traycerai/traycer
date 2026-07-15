import type { Editor, Range } from "@tiptap/core";

export function isSingleTextblockLinkRange(
  editor: Editor,
  range: Range,
): boolean {
  const from = editor.state.doc.resolve(range.from);
  const to = editor.state.doc.resolve(range.to);
  return (
    from.sameParent(to) &&
    from.parent.isTextblock &&
    from.parent.type.allowsMarkType(editor.schema.marks.link)
  );
}

export function canUseArtifactLinkControl(editor: Editor): boolean {
  const { from, to } = editor.state.selection;
  if (from === to) return editor.isActive("link");
  return isSingleTextblockLinkRange(editor, { from, to });
}
