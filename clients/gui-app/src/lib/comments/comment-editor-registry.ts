import type { Editor } from "@tiptap/core";
import { useCommentThreadsStore } from "@/stores/comments/comment-threads-store";

interface RegisteredCommentEditor {
  readonly reveal: (threadId: string) => boolean;
  readonly isActive: boolean;
}

const editorsByArtifact = new Map<
  string,
  Map<string, RegisteredCommentEditor>
>();

const pendingReveals = new Map<
  string,
  { readonly artifactId: string; readonly threadId: string }
>();
let unsubscribePending: (() => void) | null = null;

function retirePending(epicId: string): void {
  pendingReveals.delete(epicId);
  if (pendingReveals.size === 0) {
    unsubscribePending?.();
    unsubscribePending = null;
  }
}

function retryPendingReveal(epicId: string): void {
  const pending = pendingReveals.get(epicId);
  if (pending === undefined) return;
  if (
    useCommentThreadsStore.getState().activeByEpicId[epicId] !==
    pending.threadId
  ) {
    retirePending(epicId);
    return;
  }
  if (
    revealCommentThreadAnchor(epicId, pending.artifactId, pending.threadId) &&
    pendingReveals.get(epicId) === pending
  )
    retirePending(epicId);
}

/** Frame deep links can precede their tile, thread data, or ready bridge. */
export function requestCommentThreadAnchorReveal(
  epicId: string,
  artifactId: string,
  threadId: string,
): void {
  pendingReveals.set(epicId, { artifactId, threadId });
  unsubscribePending ??= useCommentThreadsStore.subscribe((state) => {
    for (const [pendingEpicId, pending] of pendingReveals) {
      if (state.activeByEpicId[pendingEpicId] !== pending.threadId)
        retirePending(pendingEpicId);
    }
  });
  retryPendingReveal(epicId);
}

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

interface CommentEditorScope {
  readonly epicId: string;
  readonly artifactId: string;
  readonly tileId: string;
  readonly isActive: boolean;
}

export type RegisterCommentEditorArgs = CommentEditorScope &
  (
    | { readonly editor: Editor; readonly reveal?: never }
    | {
        readonly reveal: (threadId: string) => boolean;
        readonly editor?: never;
      }
  );

export function registerCommentEditor(
  args: RegisterCommentEditorArgs,
): () => void {
  const { epicId, artifactId, tileId, isActive } = args;
  const reveal =
    args.reveal ??
    ((threadId: string): boolean => {
      const editor = args.editor;
      if (editor.isDestroyed) return false;
      const range = findThreadAnchorRange(editor, threadId);
      if (range === null) return false;
      scrollRangeIntoView(editor, range);
      return true;
    });
  const key = registryKey(epicId, artifactId);
  const editors =
    editorsByArtifact.get(key) ?? new Map<string, RegisteredCommentEditor>();
  editors.set(tileId, { reveal, isActive });
  editorsByArtifact.set(key, editors);
  retryPendingReveal(epicId);

  return () => {
    const currentEditors = editorsByArtifact.get(key);
    if (currentEditors === undefined) return;
    if (currentEditors.get(tileId)?.reveal !== reveal) return;
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
  return preferredEditors.some((entry) => entry.reveal(threadId));
}

export function clearCommentEditorRegistryForTests(): void {
  editorsByArtifact.clear();
  pendingReveals.clear();
  unsubscribePending?.();
  unsubscribePending = null;
}
