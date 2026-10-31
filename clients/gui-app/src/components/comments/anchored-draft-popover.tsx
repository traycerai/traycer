import { FrameCommentPortalContext } from "./frame-comment-surface-context";
import { readNegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";
import type { CommentAnchor } from "@traycer/protocol/host/epic/unary-schemas";
import {
  useContext,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
} from "@floating-ui/dom";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import {
  usePaneFocused,
  usePanePortalContainer,
} from "@/components/epic-tabs/pane-visibility-context";
import { useCreateCommentThreadForClient } from "@/hooks/comments/use-comment-thread-mutations";
import { useArtboardEdit } from "@/components/canvas-artifact/use-artboard-edit";
import {
  useAnchoredDraftStore,
  type AnchoredCommentDraft,
} from "@/stores/comments/anchored-draft-store";
import {
  CommentComposer,
  type CommentComposerHandle,
} from "./comment-composer";
import {
  AnchoredDraftSendToChatSlot,
  type AnchoredDraftSendToChatSurface,
} from "./anchored-draft-send-to-chat";

export interface AnchoredDraftTidInsertion {
  readonly boardPath: string;
  readonly marker: number;
  readonly tagName: string;
  readonly tid: string;
  readonly sha256Before: string;
  readonly sha256After: string;
  /** The insertion's splices, for shifting the live document's markers. */
  readonly splices: readonly {
    readonly start: number;
    readonly end: number;
    readonly replacement: string;
  }[];
}

export function AnchoredDraftPopover(props: {
  readonly epicId: string;
  readonly artifactId: string;
  readonly tileId: string;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly onCreated: (threadId: string) => void;
  readonly onClosed: () => void;
  /** Lets the surface adopt a first comment's tid without reloading the board. */
  readonly onTidInserted?: (
    insertion: AnchoredDraftTidInsertion,
  ) => Promise<void>;
  /**
   * Lets the box send its element and text to a chat instead of posting a
   * thread; `null` on a surface that cannot capture elements.
   */
  readonly sendToChat: AnchoredDraftSendToChatSurface | null;
}) {
  const { epicId, artifactId, tileId, hostClient, onCreated, onClosed } = props;
  const stored = useAnchoredDraftStore((state) => state.byEpicId[epicId]);
  const draft =
    stored?.artifactId === artifactId && stored.tileId === tileId
      ? stored
      : null;
  const createThread = useCreateCommentThreadForClient(hostClient);
  const edit = useArtboardEdit(artifactId);
  const [failure, setFailure] = useState<{
    draftId: string;
    text: string;
  } | null>(null);
  const composer = useRef<CommentComposerHandle | null>(null);
  const floatingRef = useRef<HTMLDialogElement | null>(null);
  const paneContainer = usePanePortalContainer();
  const commentContainer = useContext(FrameCommentPortalContext);
  const focused = usePaneFocused();
  const pending = createThread.isPending || edit.isPending;
  const dismiss = useCallback((): boolean => {
    if (draft === null || pending) return false;
    if (
      composer.current?.isDirty() &&
      !window.confirm("Discard this comment draft? Unsaved text will be lost.")
    )
      return false;
    useAnchoredDraftStore.getState().clearDraft(epicId, draft.draftId);
    onClosed();
    return true;
  }, [draft, epicId, onClosed, pending]);
  const keyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    dismiss();
  });
  // The Send to chat picker is a Radix menu portalled to the body, so a click
  // in it lands outside the dialog element. It belongs to the box when its
  // trigger does: dismissing on that click would both prompt to discard the
  // draft and break Radix's pointer tracking, which then selects the item
  // twice.
  const insideOwnMenu = (target: Node): boolean => {
    if (!(target instanceof Element)) return false;
    const triggerId = target
      .closest("[data-slot=dropdown-menu-content]")
      ?.getAttribute("aria-labelledby");
    const trigger =
      triggerId === null || triggerId === undefined
        ? null
        : document.getElementById(triggerId);
    return (
      trigger !== null && (floatingRef.current?.contains(trigger) ?? false)
    );
  };
  const outside = useEffectEvent((event: PointerEvent) => {
    if (
      !(event.target instanceof Node) ||
      floatingRef.current?.contains(event.target) ||
      insideOwnMenu(event.target) ||
      event
        .composedPath()
        .some(
          (target) =>
            target instanceof Element &&
            target.getAttribute("data-slot") === "mention-suggestion",
        )
    )
      return;
    if (!dismiss()) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  });
  const hasDraft = draft !== null;
  useEffect(() => {
    if (!hasDraft || !focused) return;
    window.addEventListener("keydown", keyDown);
    window.addEventListener("pointerdown", outside, true);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("pointerdown", outside, true);
    };
  }, [hasDraft, focused]);
  useLayoutEffect(() => {
    const floating = floatingRef.current;
    if (floating === null || draft === null) return;
    const reference = {
      getBoundingClientRect: () =>
        new DOMRect(
          draft.rect.x,
          draft.rect.y,
          draft.rect.width,
          draft.rect.height,
        ),
    };
    let active = true;
    const reposition = (): void => {
      void computePosition(reference, floating, {
        strategy: "fixed",
        placement: "bottom-start",
        middleware: [offset(8), flip(), shift({ padding: 8 })],
      }).then(({ x, y }) => {
        if (active) {
          floating.style.left = `${x}px`;
          floating.style.top = `${y}px`;
        }
      });
    };
    const stop = autoUpdate(reference, floating, reposition);
    return () => {
      active = false;
      stop();
    };
  }, [draft, paneContainer]);
  const prepareAnchor = async (
    target: AnchoredCommentDraft,
  ): Promise<CommentAnchor | null> => {
    const anchor = target.anchor;
    if (anchor.kind === "artifact" || anchor.kind === "canvas-point")
      return anchor;
    if (anchor.elementId !== null)
      return { ...anchor, elementId: anchor.elementId };
    if (target.selection === null || target.selection.element.generated) {
      setFailure({
        draftId: target.draftId,
        text: "Select an element in the page to comment on it.",
      });
      return null;
    }
    const result = await edit.mutateAsync({
      selection: target.selection,
      edit: { kind: "insert-tid-only" },
    });
    if (!result.ok) {
      setFailure({ draftId: target.draftId, text: result.detail });
      return null;
    }
    if (result.tid === null) {
      setFailure({
        draftId: target.draftId,
        text: "The comment could not be attached. Select the element again.",
      });
      return null;
    }
    if (
      props.onTidInserted !== undefined &&
      target.selection.element.marker !== null
    )
      await props.onTidInserted({
        boardPath: target.selection.boardPath,
        marker: target.selection.element.marker,
        tagName: target.selection.element.tagName,
        tid: result.tid,
        sha256Before: target.selection.servedSha256,
        sha256After: result.sha256After,
        splices: result.splices,
      });
    const resolved: CommentAnchor = { ...anchor, elementId: result.tid };
    useAnchoredDraftStore
      .getState()
      .updateDraft(epicId, target.draftId, { anchor: resolved });
    return resolved;
  };
  const submit = async (content: JsonContent): Promise<void> => {
    if (draft === null) return;
    setFailure(null);
    const hostId = hostClient?.getActiveHostId() ?? null;
    const version =
      hostId === null
        ? null
        : readNegotiatedMethodVersion(hostId, "epic.createCommentThread");
    // Anchored threads negotiate at 1.2; the canvas-point anchor is 1.3's
    // request growth, so an older host must refuse it here rather than
    // reject the wire call.
    const neededMinor = draft.anchor.kind === "canvas-point" ? 3 : 2;
    if (
      version === null ||
      version === false ||
      version.major !== 1 ||
      version.minor < neededMinor
    ) {
      setFailure({
        draftId: draft.draftId,
        text: "Update the host to comment on this artifact.",
      });
      return;
    }
    useAnchoredDraftStore
      .getState()
      .updateDraft(epicId, draft.draftId, { submitting: true });
    await prepareAnchor(draft)
      .then(async (anchor) => {
        if (anchor === null) return;
        const result = await createThread.mutateAsync({
          epicId,
          artifactId,
          artifactType: draft.artifactType,
          content,
          quotedText: draft.quotedText,
          anchor,
        });
        useAnchoredDraftStore.getState().clearDraft(epicId, draft.draftId);
        onCreated(result.threadId);
        onClosed();
      })
      .catch((error: unknown) => {
        setFailure({
          draftId: draft.draftId,
          text:
            error instanceof Error
              ? error.message
              : "The comment could not be saved. Try again.",
        });
      })
      .finally(() => {
        useAnchoredDraftStore
          .getState()
          .updateDraft(epicId, draft.draftId, { submitting: false });
      });
  };
  if (draft === null) return null;
  let label = draft.artifactType === "canvas" ? "Whole canvas" : "Whole page";
  if (draft.anchor.kind !== "artifact") label = draft.anchor.label;
  return createPortal(
    <dialog
      ref={floatingRef}
      open
      aria-label="New comment"
      data-slot="anchored-draft-popover"
      className="fixed z-50 m-0 w-[min(90vw,24rem)] max-w-safe-dvw rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-lg outline-none"
    >
      <p className="mb-2 truncate text-ui-xs text-muted-foreground">{label}</p>
      {draft.generatedText ? (
        <p className="mb-2 text-ui-xs text-muted-foreground">
          This text was built by a script; commenting on its container.
        </p>
      ) : null}
      {draft.retargeted && !draft.generatedText ? (
        <p className="mb-2 text-ui-xs text-muted-foreground">
          Built by a script; commenting on its container
        </p>
      ) : null}
      {failure?.draftId === draft.draftId ? (
        <p role="alert" className="mb-2 text-ui-xs text-destructive">
          {failure.text}
        </p>
      ) : null}
      <CommentComposer
        key={draft.draftId}
        ref={composer}
        epicId={epicId}
        hostClient={hostClient}
        initialContent={null}
        placeholder="Start a thread…"
        focusOnMount
        submitLabel="Comment"
        isPending={pending}
        onSubmit={submit}
        onCancel={() => {
          dismiss();
        }}
        leadingActions={
          <AnchoredDraftSendToChatSlot
            key={draft.draftId}
            surface={props.sendToChat}
            selection={draft.selection}
            readDraft={() =>
              composer.current?.getContent() ?? { type: "doc", content: [] }
            }
            disabled={pending}
            onSent={() => {
              // Sent, not saved: the box closes without the discard prompt,
              // because the text now lives in the chat composer.
              useAnchoredDraftStore
                .getState()
                .clearDraft(epicId, draft.draftId);
              onClosed();
            }}
            onFailure={(text) => setFailure({ draftId: draft.draftId, text })}
          />
        }
        className={undefined}
      />
    </dialog>,
    commentContainer ?? paneContainer ?? document.body,
  );
}
