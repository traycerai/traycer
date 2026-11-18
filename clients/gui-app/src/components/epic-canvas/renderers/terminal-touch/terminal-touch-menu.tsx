import { useCallback, useEffect, useRef, type RefObject } from "react";
import { ClipboardPaste, Copy, TextCursor, TextSelect } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

import type {
  TerminalSelectionSpan,
  TerminalTouchTarget,
} from "./terminal-touch-selection";

const COPY_FEEDBACK_RESET_MS = 2000;

/**
 * What a long press captured, read once as the finger lifted: where it was
 * (pane-relative, so the menu can be anchored there) and what the grid held
 * under it. Snapshotted rather than read at render, because the engine is a
 * ref and the menu's items are decided from this record alone.
 */
export interface TerminalTouchMenuState {
  readonly left: number;
  readonly top: number;
  /** The word under the press, or `null` over a blank cell. */
  readonly word: TerminalSelectionSpan | null;
  /** The selection at press time, or `null` with nothing selected. */
  readonly selectionText: string | null;
  /**
   * Whether the terminal held focus when the press landed. The menu takes
   * focus while open (the primitive insists), which drops a phone's keyboard;
   * on close, focus goes back to the terminal so the keyboard the person had
   * up returns, and stays down if it was down.
   */
  readonly restoreFocus: boolean;
}

export interface TerminalTouchMenuProps {
  readonly state: TerminalTouchMenuState | null;
  readonly termRef: RefObject<TerminalTouchTarget | null>;
  readonly onClose: () => void;
}

function reportCopyFailure(): void {
  reportableErrorToast("Couldn't copy the selection.", undefined, {
    title: "Could not copy",
    message: null,
    code: null,
    source: "Terminal",
  });
}

function reportPasteFailure(): void {
  reportableErrorToast("Couldn't read the clipboard.", undefined, {
    title: "Could not paste",
    message: null,
    code: null,
    source: "Terminal",
  });
}

/**
 * The long-press menu over a terminal on a phone: the edit verbs a text view's
 * own callout offers, for a grid that has no callout of its own.
 *
 * A dropdown on a zero-size anchor placed at the press point, not a context
 * menu: the context-menu primitive opens itself on a 700ms hold while the
 * finger is still down, and the two recognizers would each open a menu under
 * the other's finger. Owning the anchor also lets the host decide WHEN it
 * opens (on release - see `useTerminalTouchGestures`).
 *
 * The menu takes focus while it is open - the primitive offers no way to keep
 * it on xterm's hidden textarea - so the phone keyboard drops with it. On
 * close, focus returns to the terminal if that is where it came from
 * (`restoreFocus`), and Paste refocuses regardless, because typing is what
 * comes after a paste.
 */
export function TerminalTouchMenu(props: TerminalTouchMenuProps) {
  const { state, termRef, onClose } = props;
  const { copy } = useClipboardCopy({
    resetMs: COPY_FEEDBACK_RESET_MS,
    onSuccess: null,
    onError: reportCopyFailure,
  });
  // Read when the content unmounts, by which time `state` is already null:
  // the host clears it on the open-change that unmounts the content.
  const restoreFocusRef = useRef(false);
  useEffect(() => {
    if (state !== null) restoreFocusRef.current = state.restoreFocus;
  }, [state]);

  const handleOpenChange = useCallback(
    (open: boolean): void => {
      if (!open) onClose();
    },
    [onClose],
  );

  const handleCloseAutoFocus = useCallback(
    (event: Event): void => {
      // The primitive would hand focus to the anchor, an inert span.
      event.preventDefault();
      if (!restoreFocusRef.current) return;
      termRef.current?.focus();
    },
    [termRef],
  );

  const selectWord = useCallback((): void => {
    const word = state?.word ?? null;
    const term = termRef.current;
    if (word === null || term === null) return;
    term.select(word.column, word.row, word.length);
  }, [state, termRef]);

  const selectAll = useCallback((): void => {
    termRef.current?.selectAll();
  }, [termRef]);

  const copySelection = useCallback((): void => {
    const text = state?.selectionText ?? null;
    if (text === null) return;
    copy(text);
  }, [copy, state]);

  const paste = useCallback((): void => {
    const term = termRef.current;
    if (term === null) return;
    // `navigator.clipboard` is absent in insecure contexts, where reading
    // `.readText` throws synchronously; a rejected read is the permission
    // refusal. Both are the same failure to the person.
    let read: Promise<string>;
    try {
      read = navigator.clipboard.readText();
    } catch {
      reportPasteFailure();
      return;
    }
    read.then(
      (text) => {
        if (text.length === 0) return;
        // Through xterm's paste, not `input`: bracketed-paste mode and the
        // newline translation a program asked for apply.
        term.paste(text);
        term.focus();
      },
      () => reportPasteFailure(),
    );
  }, [termRef]);

  return (
    <DropdownMenu open={state !== null} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          tabIndex={-1}
          className="pointer-events-none absolute size-0"
          style={{ left: state?.left ?? 0, top: state?.top ?? 0 }}
        />
      </DropdownMenuTrigger>
      {state === null ? null : (
        <DropdownMenuContent
          data-testid="terminal-touch-menu"
          onCloseAutoFocus={handleCloseAutoFocus}
        >
          <DropdownMenuItem
            data-testid="terminal-touch-menu-select"
            disabled={state.word === null}
            onSelect={selectWord}
          >
            <TextCursor className="size-3.5" aria-hidden />
            <span>Select</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="terminal-touch-menu-select-all"
            onSelect={selectAll}
          >
            <TextSelect className="size-3.5" aria-hidden />
            <span>Select all</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="terminal-touch-menu-copy"
            disabled={state.selectionText === null}
            onSelect={copySelection}
          >
            <Copy className="size-3.5" aria-hidden />
            <span>Copy</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="terminal-touch-menu-paste"
            onSelect={paste}
          >
            <ClipboardPaste className="size-3.5" aria-hidden />
            <span>Paste</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  );
}
