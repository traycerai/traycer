import { useCallback, useMemo, useState, type RefObject } from "react";
import { useStore } from "zustand";
import type { Terminal } from "@xterm/xterm";

import { useSidebarChatOrder } from "@/components/epic-canvas/sidebar/epic-sidebar-selection";
import {
  useMaybeOpenEpicHandle,
  useOpenEpicHandle,
} from "@/providers/use-open-epic-handle";
import { useLastFocusedChatStore } from "@/stores/chat/last-focused-chat-store";
import { useOpenTileContentIds } from "@/stores/epics/canvas/store";

import { TerminalQuoteControl } from "./terminal-quote-control";
import { resolveTerminalQuoteChatTargets } from "./terminal-quote-targets";
import type { TerminalSelectionAnchor } from "./terminal-selection-anchor";
import {
  useTerminalQuoteActions,
  type TerminalQuoteActions,
} from "./use-terminal-quote-actions";
import { useTerminalQuoteSelection } from "./use-terminal-quote-selection";

interface TerminalQuoteOverlayProps {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly terminalId: string;
  /**
   * The host this tile is bound to. The terminal is local to it, so a chat
   * bound elsewhere cannot be sent the selection.
   */
  readonly terminalHostId: string;
  readonly terminalTitle: string;
  /** The shell's launch directory; `null` until the host's row is available. */
  readonly terminalCwd: string | null;
  /** This pane's live xterm engine; `null` until the tile has one. */
  readonly term: Terminal | null;
  /** The `position: relative` pane box the control positions itself within. */
  readonly paneRef: RefObject<HTMLElement | null>;
}

/**
 * Quoting targets the open Task's chats, so a terminal outside one has nowhere
 * to send a selection. Gate on the session rather than assuming it: the epic
 * canvas always has one, but the same pane chrome backs terminals that do not
 * (the landing panel), and those should get no affordance rather than a crash.
 */
export function TerminalQuoteOverlay(props: TerminalQuoteOverlayProps) {
  const handle = useMaybeOpenEpicHandle();
  if (handle === null) return null;
  return <TerminalQuoteOverlayLive {...props} />;
}

/**
 * Watches this pane for a selection, and owns the quote actions.
 *
 * The one thing deliberately NOT here is the Task's chat list: that lives in
 * the child below, which only mounts once there IS a selection. A Task can have
 * many terminal tiles open at once and a chat record's `updatedAt` bumps on
 * every streaming tick, so subscribing each idle tile to the chat slice would
 * re-render every one of them several times a second to decide nothing.
 *
 * The actions stay HERE, above the selection, because quoting into a new chat
 * outlives the selection that started it: it waits for the host's create to
 * land in the projection before opening the tile, and that wait is cancelled
 * when its owner unmounts. Owned by the child, dismissing the control - which
 * every action does - would cancel the open it just asked for.
 */
function TerminalQuoteOverlayLive(props: TerminalQuoteOverlayProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { selection, dismiss } = useTerminalQuoteSelection({
    term: props.term,
    paneRef: props.paneRef,
    menuOpen,
  });
  const actions = useTerminalQuoteActions({
    epicId: props.epicId,
    viewTabId: props.viewTabId,
    terminalId: props.terminalId,
    terminalTitle: props.terminalTitle,
    terminalCwd: props.terminalCwd,
  });

  if (selection === null) return null;

  return (
    <TerminalQuoteAction
      actions={actions}
      epicId={props.epicId}
      viewTabId={props.viewTabId}
      terminalHostId={props.terminalHostId}
      selectedText={selection.text}
      anchor={selection.anchor}
      menuOpen={menuOpen}
      onMenuOpenChange={setMenuOpen}
      onDone={dismiss}
    />
  );
}

function TerminalQuoteAction(props: {
  readonly actions: TerminalQuoteActions;
  readonly epicId: string;
  readonly viewTabId: string;
  readonly terminalHostId: string;
  readonly selectedText: string;
  readonly anchor: TerminalSelectionAnchor;
  readonly menuOpen: boolean;
  readonly onMenuOpenChange: (open: boolean) => void;
  readonly onDone: () => void;
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
  const { actions, onDone, onMenuOpenChange, selectedText, terminalHostId } =
    props;
  const sendToChat = useCallback(
    (chatId: string) => {
      actions.quoteToChat(chatId, selectedText);
      onMenuOpenChange(false);
      onDone();
    },
    [actions, onDone, onMenuOpenChange, selectedText],
  );
  const sendToNewChat = useCallback(() => {
    actions.quoteToNewChat(selectedText);
    onMenuOpenChange(false);
    onDone();
  }, [actions, onDone, onMenuOpenChange, selectedText]);
  const targets = useMemo(
    () =>
      resolveTerminalQuoteChatTargets({
        orderedChatIds,
        chats,
        openChatIds,
        lastFocusedChatId,
        terminalHostId,
      }),
    [chats, lastFocusedChatId, openChatIds, orderedChatIds, terminalHostId],
  );

  return (
    <TerminalQuoteControl
      anchor={props.anchor}
      targets={targets}
      onSendToChat={sendToChat}
      onSendToNewChat={sendToNewChat}
      menuOpen={props.menuOpen}
      onMenuOpenChange={props.onMenuOpenChange}
    />
  );
}
