import { dialog, type MessageBoxOptions } from "electron";

/**
 * A destructive or trust-changing action confirmed by the process that owns
 * the data.
 *
 * Main decides, not the renderer (browser security review, root cause C): a
 * forget-all, a per-site clear and a durable certificate trust were all
 * reachable from any code running in a renderer. The renderer may ASK; a native
 * dialog it cannot draw over or dismiss is what turns the ask into a decision.
 *
 * Cancel is both the default and the escape key's answer, so a dialog raced or
 * dismissed refuses.
 */
export interface MainConfirmation {
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  readonly confirmLabel: string;
}

/**
 * ASYNC, and awaited before the first mutation it authorises.
 *
 * Main owns every `browser.sessions` socket now (H10), including their ping and
 * pong: a modal `showMessageBoxSync` blocks this process's event loop for as
 * long as the dialog is open, and a dialog left up past the 60 s pong timeout
 * dropped every jar stream on the machine. Nothing runs between the answer and
 * the action because the caller awaits it and mutates next, not because the
 * loop was frozen.
 */
export async function confirmDestructiveInMain(
  confirmation: MainConfirmation,
): Promise<boolean> {
  const answer = await dialog.showMessageBox(messageBoxOptions(confirmation));
  return answer.response === 1;
}

/**
 * The same dialog for the one caller that cannot await: Electron requires
 * `DownloadItem.setSavePath` in the same turn as `will-download`, so a download
 * confirmed asynchronously would already be on Electron's own save path by the
 * time the answer arrived. It blocks main for the length of the dialog, which
 * is why every other caller uses the async form.
 */
export function confirmDestructiveInMainSync(
  confirmation: MainConfirmation,
): boolean {
  return dialog.showMessageBoxSync(messageBoxOptions(confirmation)) === 1;
}

function messageBoxOptions(confirmation: MainConfirmation): MessageBoxOptions {
  return {
    type: "warning",
    buttons: ["Cancel", confirmation.confirmLabel],
    defaultId: 0,
    cancelId: 0,
    title: confirmation.title,
    message: confirmation.message,
    detail: confirmation.detail,
    noLink: true,
  };
}
