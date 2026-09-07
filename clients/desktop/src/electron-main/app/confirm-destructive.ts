import { dialog, type MessageBoxOptions } from "electron";

/** The renderer may ASK; a native dialog it cannot draw over or dismiss is what turns the ask into a decision. */
export interface MainConfirmation {
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  readonly confirmLabel: string;
}

/**
 * ASYNC, and awaited before the first mutation it authorises.
 * Nothing runs between the answer and the action because the caller awaits it and mutates next, not because the loop was frozen.
 */
export async function confirmDestructiveInMain(
  confirmation: MainConfirmation,
): Promise<boolean> {
  const answer = await dialog.showMessageBox(messageBoxOptions(confirmation));
  return answer.response === 1;
}

/**
 * The same dialog for the one caller that cannot await: Electron requires `DownloadItem.setSavePath` in the same turn as `will-download`, so a download confirmed asynchronously.
 * It blocks main for the length of the dialog, which is why every other caller uses the async form.
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
