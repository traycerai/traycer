import { create } from "zustand";

import type { ConversationTilePlacement } from "@/lib/canvas/conversation-tile-placement";

/**
 * Transient "open the New Conversation modal here" request. Set from the
 * creation triggers (sidebar `+`, in-pane PaneOpener, ⌘K palette) - including
 * non-React command `run()`s via `getState()` - and consumed by the per-tab
 * `NewConversationModalHost`. One modal at a time; the host clears the request
 * on close / submit.
 *
 * Kept separate from the per-epic draft store (`new-conversation-modal-store`,
 * which owns content / settings / composer mode) because placement is
 * tab-scoped and lives only for the duration of a single open.
 */
export interface NewConversationModalOpenRequest {
  readonly epicId: string;
  readonly tabId: string;
  readonly placement: ConversationTilePlacement;
  /**
   * Parent conversation id when the modal was opened to create a CHILD chat
   * (the per-row `+` in the chats tree). `null` for a top-level chat (sidebar
   * panel `+`, ⌘K palette, in-pane PaneOpener). The body threads this into
   * `epic.createChat` and seeds the workspace from the parent's binding so a
   * child inherits the parent's worktree.
   */
  readonly parentId: string | null;
}

interface NewConversationModalOpenStore {
  readonly request: NewConversationModalOpenRequest | null;
  readonly open: (request: NewConversationModalOpenRequest) => void;
  readonly close: () => void;
}

export const useNewConversationModalOpenStore =
  create<NewConversationModalOpenStore>()((set) => ({
    request: null,
    open: (request) => set({ request }),
    close: () => set({ request: null }),
  }));
