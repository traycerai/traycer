import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
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
import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { useStore } from "zustand";

import { ChatTargetMenu } from "@/components/epic-canvas/renderers/chat-target-menu/chat-target-menu";
import { resolveQuoteChatTargets } from "@/components/epic-canvas/renderers/chat-target-menu/quote-chat-targets";
import { useSidebarChatOrder } from "@/components/epic-canvas/sidebar/epic-sidebar-selection";
import { usePanePortalContainer } from "@/components/epic-tabs/pane-visibility-context";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { useLastFocusedChatStore } from "@/stores/chat/last-focused-chat-store";
import { useOpenTileContentIds } from "@/stores/epics/canvas/store";

import type { ArtifactQuoteSnapshot } from "./artifact-quote-snapshot";

export interface ArtifactQuotePopoverProps {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly editor: Editor;
  /** The frozen excerpt this picker is deciding a destination for. */
  readonly snapshot: ArtifactQuoteSnapshot;
  readonly onSendToChat: (
    chatId: string,
    snapshot: ArtifactQuoteSnapshot,
  ) => void;
  readonly onSendToNewChat: (snapshot: ArtifactQuoteSnapshot) => void;
  /** Every exit: a pick, Escape, or a click outside the menu. */
  readonly onDone: () => void;
}

/**
 * The chat picker over an artifact selection.
 *
 * Mounted only while a snapshot exists, so the chat roster's subscriptions -
 * which churn on every streaming tick of every chat - are paid by exactly one
 * tile, for exactly as long as the user is choosing. That is the same rule the
 * terminal overlay follows.
 *
 * A separate floating surface rather than a menu inside the bubble toolbar:
 * the bubble plugin hides itself when focus leaves the editor for anything
 * outside its own parent, and a Radix menu portals to `<body>`. The comment
 * draft already solved this with "suppress the bubble, float your own", and
 * this is the same shape - Floating UI against the frozen range, `autoUpdate`
 * to ride scroll and edits. The range is remapped through editor transactions
 * for POSITIONING only; the excerpt itself was frozen at capture.
 *
 * Radix owns dismissal: Escape and a pointer-down outside the menu both come
 * back as `onOpenChange(false)`, which is the one exit path.
 */
export function ArtifactQuotePopover(props: ArtifactQuotePopoverProps) {
  const { editor, snapshot, onDone, onSendToChat, onSendToNewChat } = props;
  const floatingRef = useRef<HTMLDivElement | null>(null);
  const [range, setRange] = useState({ from: snapshot.from, to: snapshot.to });
  const paneContainer = usePanePortalContainer();

  // Follow local and remote edits so the picker stays over the text it was
  // opened for; drop it when that text is gone - the excerpt the user froze
  // would otherwise be sent from nowhere in particular. Re-subscribed per
  // remap so the handler always maps from the range it last produced.
  useEffect(() => {
    const handleTransaction = (event: { transaction: Transaction }) => {
      if (!event.transaction.docChanged) return;
      const from = event.transaction.mapping.map(range.from, 1);
      const to = event.transaction.mapping.map(range.to, -1);
      if (from >= to) {
        onDone();
        return;
      }
      if (from === range.from && to === range.to) return;
      setRange({ from, to });
    };
    editor.on("transaction", handleTransaction);
    return () => {
      editor.off("transaction", handleTransaction);
    };
  }, [editor, onDone, range]);

  useLayoutEffect(() => {
    const floating = floatingRef.current;
    if (floating === null) return;
    const virtualReference = {
      getBoundingClientRect: () => coordsRectFor(editor, range.from, range.to),
    };
    const reposition = () => {
      void computePosition(virtualReference, floating, {
        placement: "bottom-start",
        middleware: [offset(4), flip(), shift({ padding: 8 })],
      }).then(({ x, y }) => {
        floating.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
      });
    };
    reposition();
    return autoUpdate(virtualReference, floating, reposition);
    // `paneContainer` is a dependency for the same reason as in the comment
    // draft: when the portal host settles, createPortal remounts the floating
    // node and `autoUpdate` has to bind to the live one.
  }, [editor, range, paneContainer]);

  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open) onDone();
    },
    [onDone],
  );
  const selectChat = useCallback(
    (chatId: string) => {
      onSendToChat(chatId, snapshot);
      onDone();
    },
    [onDone, onSendToChat, snapshot],
  );
  const selectNewChat = useCallback(() => {
    onSendToNewChat(snapshot);
    onDone();
  }, [onDone, onSendToNewChat, snapshot]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={floatingRef}
      data-slot="artifact-quote-popover"
      data-browser-overlay="artifact-quote-popover"
      className="absolute top-0 left-0 z-50"
    >
      <ArtifactQuoteTargets
        epicId={props.epicId}
        viewTabId={props.viewTabId}
        onSelectChat={selectChat}
        onSelectNewChat={selectNewChat}
        onOpenChange={onOpenChange}
      />
    </div>,
    paneContainer ?? document.body,
  );
}

/**
 * The roster, subscribed to the Task's chats only while mounted. The trigger
 * is a one-pixel anchor: the menu opens immediately and the bubble toolbar's
 * labeled button was the thing the user pressed, so a second visible pill
 * here would only repeat it.
 */
function ArtifactQuoteTargets(props: {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly onSelectChat: (chatId: string) => void;
  readonly onSelectNewChat: () => void;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const handle = useOpenEpicHandle();
  const chats = useStore(handle.store, (state) => state.chats);
  // Both borrowed rather than derived: the roster has to agree with the chats
  // sidebar about order, and with the canvas about what is already on screen.
  const orderedChatIds = useSidebarChatOrder(props.epicId);
  const openChatIds = useOpenTileContentIds(props.viewTabId);
  const lastFocusedChatId = useLastFocusedChatStore(
    (state) => state.chatIdByEpicId[props.epicId] ?? null,
  );
  const targets = useMemo(
    () =>
      resolveQuoteChatTargets({
        orderedChatIds,
        chats,
        openChatIds,
        lastFocusedChatId,
        // An artifact is projected onto every host serving the epic, so no
        // chat is out of reach for host reasons.
        sourceHostId: null,
      }),
    [chats, lastFocusedChatId, openChatIds, orderedChatIds],
  );

  return (
    <ChatTargetMenu
      targets={targets}
      onSelectChat={props.onSelectChat}
      onSelectNewChat={props.onSelectNewChat}
      open
      onOpenChange={props.onOpenChange}
      trigger={
        <button
          type="button"
          aria-label="Send to chat"
          tabIndex={-1}
          className="block size-px overflow-hidden opacity-0"
        />
      }
    />
  );
}

/**
 * Screen-space rect spanning `from`→`to`, so Floating UI can anchor against
 * the live selection without a real DOM ref. Falls back to the editor's box if
 * the positions are not currently paintable.
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
    return editor.view.dom.getBoundingClientRect();
  }
}
