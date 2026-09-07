import { create } from "zustand";

/**
 * A one-shot intent for Settings › Browser, the same shape as `providers-focus-store`: an entry
 * point elsewhere in the app arms it, and the row that can honour it consumes it the next time it
 */
interface BrowserFocusState {
  readonly openImportLogins: boolean;
  readonly requestImportLogins: () => void;
  readonly consumeImportLogins: () => void;
}

export const useBrowserFocusStore = create<BrowserFocusState>((set) => ({
  openImportLogins: false,
  requestImportLogins: () => set({ openImportLogins: true }),
  consumeImportLogins: () => set({ openImportLogins: false }),
}));
