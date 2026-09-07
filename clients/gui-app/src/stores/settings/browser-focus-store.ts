import { create } from "zustand";

/**
 * A one-shot intent for Settings › Browser, the same shape as
 * `providers-focus-store`: an entry point elsewhere in the app arms it, and
 * the row that can honour it consumes it the next time it mounts.
 *
 * It exists because `ImportLoginsRow` owns its dialog's `open` in local state,
 * so nothing outside Settings can open the import directly. The login-import
 * announcement toast's primary action navigates to the General section and
 * arms this; the row derives `open` from its own state OR the intent, and
 * closing consumes it - so a second Settings open does not reopen the dialog.
 *
 * Session-local on purpose: an intent is about the click that armed it, and a
 * relaunch should never find a dialog waiting to open.
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
