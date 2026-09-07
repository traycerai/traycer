import { create } from "zustand";

import type { ExplicitTilePlacement } from "@/lib/canvas/tile-open/intent";

export interface NewConversationModalOpenRequest {
  readonly epicId: string;
  readonly tabId: string;
  /**
   * Explicit placement for the tile the modal creates, or `null` to let the conversation
   * tile-placement setting decide (C3, C8).
   */
  readonly placement: ExplicitTilePlacement | null;
  /**
   * Parent conversation id when the modal was opened to create a CHILD chat (the per-row `+` in the
   * chats tree). `null` for a top-level chat (sidebar panel `+`, ⌘K palette, in-pane PaneOpener).
   */
  readonly parentId: string | null;
  /** Host the conversation must be created on, for a trigger that already belongs to one. */
  readonly hostId: string | null;
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
