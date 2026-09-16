import { useCallback, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ChatSearchPanel } from "@/components/chat-search/chat-search-panel";
import { registerDynamicActionHandler } from "@/lib/keybindings/dispatch";
import { useChatSearchStore } from "@/stores/chat-search/chat-search-store";

/**
 * Global host for the chat search dialog. Owns `app.chat-search.open`, which
 * both the keyboard chord and the command palette's action row dispatch, and
 * mounts the panel only while the dialog is open so its host queries never run
 * behind a closed dialog.
 *
 * Mounted beside `SystemTabModalHost`, inside the router (opening a result
 * navigates) and behind the host-readiness gate (searching needs a host).
 */
export function ChatSearchDialogHost() {
  const open = useChatSearchStore((state) => state.open);
  const setOpen = useChatSearchStore((state) => state.setOpen);
  // The clock is read at the gesture, not in the store, and only an OPEN uses
  // it - see `dateAnchorMs`.
  const changeOpen = useCallback(
    (next: boolean) => setOpen(next, Date.now()),
    [setOpen],
  );
  const close = useCallback(() => setOpen(false, Date.now()), [setOpen]);

  useEffect(
    () =>
      registerDynamicActionHandler("app.chat-search.open", () => {
        useChatSearchStore.getState().toggleOpen(Date.now());
      }),
    [],
  );

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        // Anchored high like the command palette, so the list grows downward
        // instead of re-centring on every page. The width stays a viewport cap:
        // the unmodified class keeps the safe-area term, the `sm:` one displaces
        // the primitive's `sm:max-w-sm`.
        className="top-[15vh] w-full max-w-[min(calc(100%_-_2rem),44rem,var(--safe-area-width))] translate-y-0 gap-0 overflow-hidden rounded-xl p-0 sm:max-w-[min(calc(100%_-_2rem),44rem,var(--safe-area-width))]"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Search chats</DialogTitle>
          <DialogDescription>
            Search chat titles and messages on this host.
          </DialogDescription>
        </DialogHeader>
        {open ? <ChatSearchPanel onClose={close} /> : null}
      </DialogContent>
    </Dialog>
  );
}
