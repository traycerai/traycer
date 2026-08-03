import { create } from "zustand";

/**
 * Transient "open the Create-new-terminal dialog here" request - set from the
 * ⌘K palette's "Create new terminal" row (the sidebar "+" popover has its own
 * local open state and does not go through this store) and consumed by
 * `NewTerminalDialogHost`. Mirrors `new-conversation-modal-open-store`: one
 * dialog at a time, the host clears the request on close/launch.
 */
export interface NewTerminalModalOpenRequest {
  readonly epicId: string;
  readonly tabId: string;
  readonly groupId: string;
}

interface NewTerminalModalOpenStore {
  readonly request: NewTerminalModalOpenRequest | null;
  readonly open: (request: NewTerminalModalOpenRequest) => void;
  readonly close: () => void;
}

export const useNewTerminalModalOpenStore = create<NewTerminalModalOpenStore>()(
  (set) => ({
    request: null,
    open: (request) => set({ request }),
    close: () => set({ request: null }),
  }),
);
