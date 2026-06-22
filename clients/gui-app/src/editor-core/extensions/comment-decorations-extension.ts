import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

/**
 * Snapshot describing UI-only thread state the decorations layer needs to
 * paint over `threadAnchor` marks. Layered as ProseMirror inline decorations
 * (not stored on the mark) so the persisted Y.Doc never carries presentation
 * data.
 *
 * `resolvedThreadIds` removes anchors from the editor interaction surface.
 * The persisted mark remains in the document for history/round-trip parity,
 * but resolved threads should not paint active/hover/flash affordances.
 * `liveThreadIds` is the set of thread ids currently known to the comment
 * thread store. When non-null, anchors whose `threadId` is absent from this
 * set are treated as orphans (deleted thread, mark not yet stripped) and
 * suppressed from rendering. Pass `null` to disable filtering (e.g. before
 * the thread list has loaded - fall back to painting every mark so users
 * never lose visibility on slow networks).
 * `draftRange` is the editor doc range backing the floating draft popover;
 * absent when no draft is open.
 */
export interface CommentDecorationSnapshot {
  readonly activeThreadId: string | null;
  readonly hoverThreadId: string | null;
  readonly flashThreadId: string | null;
  readonly resolvedThreadIds: ReadonlySet<string>;
  readonly liveThreadIds: ReadonlySet<string> | null;
  readonly draftRange: { readonly from: number; readonly to: number } | null;
}
const EMPTY_COMMENT_DECORATION_SNAPSHOT: CommentDecorationSnapshot = {
  activeThreadId: null,
  hoverThreadId: null,
  flashThreadId: null,
  resolvedThreadIds: new Set(),
  liveThreadIds: null,
  draftRange: null,
};

export const commentDecorationsPluginKey = new PluginKey<PluginState>(
  "comment-decorations",
);

const SNAPSHOT_META_KEY = "comment-decorations:snapshot";

interface PluginState {
  readonly snapshot: CommentDecorationSnapshot;
  readonly decorations: DecorationSet;
}

function buildDecorations(
  doc: ProseMirrorNode,
  snapshot: CommentDecorationSnapshot,
): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (!node.isText) {
      return true;
    }
    const anchor = node.marks.find((mark) => mark.type.name === "threadAnchor");
    if (anchor === undefined) {
      return true;
    }
    const anchorAttrs = anchor.attrs as { threadId: unknown };
    const threadId = anchorAttrs.threadId;
    if (typeof threadId !== "string" || threadId.length === 0) {
      return true;
    }
    if (
      snapshot.liveThreadIds !== null &&
      !snapshot.liveThreadIds.has(threadId)
    ) {
      return true;
    }
    if (snapshot.resolvedThreadIds.has(threadId)) {
      decorations.push(
        Decoration.inline(
          pos,
          pos + node.nodeSize,
          { "data-resolved": "true" },
          {
            inclusiveStart: false,
            inclusiveEnd: false,
          },
        ),
      );
      return true;
    }
    const attrs: Record<string, string> = {
      "data-comment-anchor": "true",
    };
    if (snapshot.activeThreadId === threadId) {
      attrs["data-active"] = "true";
    }
    if (snapshot.hoverThreadId === threadId) {
      attrs["data-hover"] = "true";
    }
    if (snapshot.flashThreadId === threadId) {
      attrs["data-flash"] = "true";
    }
    decorations.push(
      Decoration.inline(pos, pos + node.nodeSize, attrs, {
        inclusiveStart: false,
        inclusiveEnd: false,
      }),
    );
    return true;
  });

  if (snapshot.draftRange !== null) {
    const { from, to } = snapshot.draftRange;
    if (from < to && from >= 0 && to <= doc.content.size) {
      decorations.push(
        Decoration.inline(
          from,
          to,
          { class: "thread-anchor-draft" },
          { inclusiveStart: false, inclusiveEnd: false },
        ),
      );
    }
  }

  return DecorationSet.create(doc, decorations);
}

function readSnapshotFromMeta(
  tr: Transaction,
): CommentDecorationSnapshot | null {
  const meta: unknown = tr.getMeta(commentDecorationsPluginKey);
  if (meta === undefined || meta === null) {
    return null;
  }
  if (typeof meta !== "object") {
    return null;
  }
  const candidate = meta as { readonly [k: string]: unknown };
  if (candidate[SNAPSHOT_META_KEY] === undefined) {
    return null;
  }
  return candidate[SNAPSHOT_META_KEY] as CommentDecorationSnapshot;
}

/**
 * Tiptap extension that paints thread-anchor visual state via ProseMirror
 * inline decorations. The React layer drives state by calling
 * `applyCommentDecorationSnapshot(editor, snapshot)` whenever the Zustand
 * comments store fires. The plugin recomputes decorations on every doc
 * change so newly-typed text inside an anchored range stays highlighted.
 */
export const CommentDecorationsExtension = Extension.create({
  name: "commentDecorations",

  addProseMirrorPlugins() {
    return [
      new Plugin<PluginState>({
        key: commentDecorationsPluginKey,
        state: {
          init: (_config, state: EditorState): PluginState => ({
            snapshot: EMPTY_COMMENT_DECORATION_SNAPSHOT,
            decorations: buildDecorations(
              state.doc,
              EMPTY_COMMENT_DECORATION_SNAPSHOT,
            ),
          }),
          apply: (tr, prev, _oldState, newState): PluginState => {
            const next = readSnapshotFromMeta(tr);
            if (next !== null) {
              return {
                snapshot: next,
                decorations: buildDecorations(newState.doc, next),
              };
            }
            if (tr.docChanged) {
              return {
                snapshot: prev.snapshot,
                decorations: buildDecorations(newState.doc, prev.snapshot),
              };
            }
            return prev;
          },
        },
        props: {
          decorations(state) {
            return commentDecorationsPluginKey.getState(state)?.decorations;
          },
        },
      }),
    ];
  },
});

/**
 * Push a new presentation snapshot into the decorations plugin. Implemented
 * as a free helper (not a Tiptap `addCommands` augmentation) so we don't
 * need to merge into Tiptap's `Commands<ReturnType>` interface.
 */
export function applyCommentDecorationSnapshot(
  editor: Editor,
  snapshot: CommentDecorationSnapshot,
): void {
  const tr = editor.state.tr.setMeta(commentDecorationsPluginKey, {
    [SNAPSHOT_META_KEY]: snapshot,
  });
  editor.view.dispatch(tr);
}
