import type { Editor } from "@tiptap/core";

interface RegisteredCommentEditor {
  readonly editor: Editor;
  readonly isActive: boolean;
}

const editorsByArtifact = new Map<
  string,
  Map<string, RegisteredCommentEditor>
>();

function registryKey(epicId: string, artifactId: string): string {
  return `${epicId}::${artifactId}`;
}

function findThreadAnchorRange(
  editor: Editor,
  threadId: string,
): { readonly from: number; readonly to: number } | null {
  let range: { readonly from: number; readonly to: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (range !== null) return false;
    if (!node.isText) return true;
    const anchor = node.marks.find(
      (mark) =>
        mark.type.name === "threadAnchor" && mark.attrs.threadId === threadId,
    );
    if (anchor === undefined) return true;
    range = { from: pos, to: pos + node.nodeSize };
    return false;
  });
  return range;
}

export interface RegisterCommentEditorArgs {
  readonly epicId: string;
  readonly artifactId: string;
  readonly tileId: string;
  readonly editor: Editor;
  readonly isActive: boolean;
}

export function registerCommentEditor(
  args: RegisterCommentEditorArgs,
): () => void {
  const { epicId, artifactId, tileId, editor, isActive } = args;
  const key = registryKey(epicId, artifactId);
  const editors =
    editorsByArtifact.get(key) ?? new Map<string, RegisteredCommentEditor>();
  editors.set(tileId, { editor, isActive });
  editorsByArtifact.set(key, editors);

  return () => {
    const currentEditors = editorsByArtifact.get(key);
    if (currentEditors === undefined) return;
    if (currentEditors.get(tileId)?.editor !== editor) return;
    currentEditors.delete(tileId);
    if (currentEditors.size === 0) {
      editorsByArtifact.delete(key);
    }
  };
}

function elementForDomNode(node: Node): HTMLElement | null {
  if (node.nodeType === 3) return node.parentElement;
  if (node instanceof HTMLElement) return node;
  return null;
}

function scrollRangeIntoView(
  editor: Editor,
  range: { readonly from: number; readonly to: number },
): void {
  const element = elementForDomNode(editor.view.domAtPos(range.from).node);
  element?.scrollIntoView({
    block: "center",
    inline: "nearest",
    behavior: "smooth",
  });
}

export function revealCommentThreadAnchor(
  epicId: string,
  artifactId: string,
  threadId: string,
): boolean {
  const editors = editorsByArtifact.get(registryKey(epicId, artifactId));
  if (editors === undefined) return false;
  const registeredEditors = Array.from(editors.values());
  const preferredEditors = [
    ...registeredEditors.filter((entry) => entry.isActive),
    ...registeredEditors.filter((entry) => !entry.isActive),
  ];
  const match = preferredEditors
    .map((entry) => ({
      editor: entry.editor,
      range: findThreadAnchorRange(entry.editor, threadId),
    }))
    .find((entry) => entry.range !== null);
  if (match === undefined || match.range === null) return false;
  scrollRangeIntoView(match.editor, match.range);
  return true;
}

export function clearCommentEditorRegistryForTests(): void {
  editorsByArtifact.clear();
}
