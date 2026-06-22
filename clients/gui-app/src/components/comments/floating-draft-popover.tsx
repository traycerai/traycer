import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
} from "@floating-ui/dom";
import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { type EpicArtifactKind } from "@traycer/protocol/common/registry";
import type { CreateCommentThreadResponse } from "@traycer/protocol/host/epic/unary-schemas";
import { cn } from "@/lib/utils";
import {
  useCommentThreadsStore,
  useDraftRange,
} from "@/stores/comments/comment-threads-store";
import { useCreateCommentThread } from "@/hooks/comments/use-comment-thread-mutations";
import { CommentComposer } from "./comment-composer";

export interface FloatingDraftPopoverProps {
  readonly epicId: string;
  readonly artifactType: EpicArtifactKind;
  readonly artifactId: string;
  readonly tileId: string;
  /** Tiptap editor backing the active tile. The popover anchors to its
   *  selection coords and writes the `threadAnchor` mark on submit. */
  readonly editor: Editor;
  /** Triggered after the host ack so the parent can swap its sidebar to
   *  comments view + focus the freshly-created thread. */
  readonly onCreated: (threadId: string) => void;
}

/**
 * Selection-anchored floating draft surface.
 *
 * Lifecycle is store-driven: when `useDraftRange(epicId)` returns a non-null
 * range the popover renders, hosts a `<CommentComposer>`, and on submit fires
 * `epic.createCommentThread`. After the host ack we paint the
 * `threadAnchor` mark over the saved range, clear the draft, and bubble the
 * new threadId up so the sidebar can switch into comments view.
 *
 * Positioning uses `@floating-ui/dom`'s virtual reference pattern: the
 * editor's `coordsAtPos` produces the bounding rect, and `autoUpdate` keeps
 * the popover pinned while the user types or scrolls. Pointer-down on the
 * editor outside the saved range cancels the draft (with a confirm prompt
 * if the composer has content).
 */
export function FloatingDraftPopover(props: FloatingDraftPopoverProps) {
  const { epicId, artifactType, artifactId, tileId, editor, onCreated } = props;

  const draft = useDraftRange(epicId);
  const ownedDraft =
    draft !== null && draft.tileId === tileId && draft.artifactId === artifactId
      ? draft
      : null;
  const setDraft = useCommentThreadsStore((s) => s.setDraft);
  const createThread = useCreateCommentThread();
  const floatingRef = useRef<HTMLDialogElement | null>(null);
  const isDirtyRef = useRef(false);

  const dismiss = useCallback(
    (force: boolean) => {
      if (!force && isDirtyRef.current) {
        const confirmed = window.confirm(
          "Discard this comment draft? Unsaved text will be lost.",
        );
        if (!confirmed) return;
      }
      isDirtyRef.current = false;
      setDraft(epicId, null);
    },
    [epicId, setDraft],
  );
  const draftActive = ownedDraft !== null;
  const handleDocumentKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      dismiss(false);
    }
  });

  // Pin the popover to the saved doc range using the editor's coordsAtPos.
  // Floating UI's autoUpdate handles re-flow on edits, scroll, and resize.
  useLayoutEffect(() => {
    const floating = floatingRef.current;
    if (floating === null || ownedDraft === null) return;
    const virtualReference = {
      getBoundingClientRect: () =>
        coordsRectFor(editor, ownedDraft.from, ownedDraft.to),
    };
    const reposition = () => {
      void computePosition(virtualReference, floating, {
        placement: "bottom-start",
        middleware: [offset(8), flip(), shift({ padding: 8 })],
      }).then(({ x, y }) => {
        floating.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
      });
    };
    reposition();
    return autoUpdate(virtualReference, floating, reposition);
  }, [editor, ownedDraft]);

  // Esc cancels (with dirty-confirm) at the document level so the editor
  // doesn't have to forward keystrokes. The Tiptap editor's own Escape
  // handler already lets unhandled keys bubble.
  useEffect(() => {
    if (!draftActive) return;
    window.addEventListener("keydown", handleDocumentKeyDown, {
      capture: true,
    });
    return () => {
      window.removeEventListener("keydown", handleDocumentKeyDown, {
        capture: true,
      });
    };
  }, [draftActive]);

  // Re-map the saved draft range through every editor transaction so local
  // and remote edits keep the from/to offsets aligned with the original
  // text. Without this, submitting after any intervening edit would write
  // the threadAnchor mark over the wrong characters (or fail outright when
  // the offsets fall outside the doc). When the entire range collapses
  // (the quoted text was deleted) we drop the draft so the user notices
  // and re-selects.
  useEffect(() => {
    if (!draftActive) return;
    const handleTransaction = (props: { transaction: Transaction }) => {
      if (!props.transaction.docChanged) return;
      const current =
        useCommentThreadsStore.getState().draftByEpicId[epicId] ?? null;
      if (current === null) return;
      const from = props.transaction.mapping.map(current.from, 1);
      const to = props.transaction.mapping.map(current.to, -1);
      if (from === current.from && to === current.to) return;
      if (from >= to) {
        setDraft(epicId, null);
        return;
      }
      setDraft(epicId, { ...current, from, to });
    };
    editor.on("transaction", handleTransaction);
    return () => {
      editor.off("transaction", handleTransaction);
    };
  }, [draftActive, editor, epicId, setDraft]);

  const handleSubmit = useCallback(
    (content: JsonContent) => {
      if (ownedDraft === null) return;
      createThread.mutate(
        {
          epicId,
          artifactType,
          artifactId,
          content,
          quotedText: ownedDraft.quotedText,
        },
        {
          onSuccess: (data: CreateCommentThreadResponse) => {
            applyThreadAnchorMark(
              editor,
              ownedDraft.from,
              ownedDraft.to,
              data.threadId,
            );
            isDirtyRef.current = false;
            setDraft(epicId, null);
            onCreated(data.threadId);
          },
        },
      );
    },
    [
      ownedDraft,
      createThread,
      epicId,
      artifactType,
      artifactId,
      editor,
      setDraft,
      onCreated,
    ],
  );

  if (ownedDraft === null) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <dialog
      ref={floatingRef}
      open
      aria-label="New comment"
      data-slot="floating-draft-popover"
      className={cn(
        "absolute top-0 left-0 z-50 m-0 w-[min(90vw,22rem)] rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-lg outline-none",
      )}
    >
      <CommentComposer
        epicId={epicId}
        initialContent={null}
        placeholder="Start a thread…"
        focusOnMount
        submitLabel="Comment"
        onSubmit={handleSubmit}
        onCancel={(isDirty) => {
          isDirtyRef.current = isDirty;
          dismiss(false);
        }}
        className={undefined}
      />
    </dialog>,
    document.body,
  );
}

/**
 * Compute a screen-space DOMRect spanning the editor's `from`→`to` range so
 * Floating UI can anchor against the live selection without a real DOM ref.
 * Falls back to the editor wrapper's box if the positions aren't currently
 * paintable (e.g. the range was destroyed by a remote edit).
 */
function coordsRectFor(editor: Editor, from: number, to: number): DOMRect {
  try {
    const start = editor.view.coordsAtPos(from);
    const end = editor.view.coordsAtPos(to);
    const left = Math.min(start.left, end.left);
    const right = Math.max(start.right, end.right);
    const top = Math.min(start.top, end.top);
    const bottom = Math.max(start.bottom, end.bottom);
    return new DOMRect(left, top, right - left, bottom - top);
  } catch {
    const fallback = editor.view.dom.getBoundingClientRect();
    return fallback;
  }
}

function applyThreadAnchorMark(
  editor: Editor,
  from: number,
  to: number,
  threadId: string,
): void {
  if (from >= to) return;
  const markType = editor.schema.marks.threadAnchor;
  const tr = editor.state.tr.addMark(from, to, markType.create({ threadId }));
  editor.view.dispatch(tr);
}
