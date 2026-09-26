import type { MessageBoxOptions, MessageBoxReturnValue } from "electron";
import type { HostQuitDecision } from "../../ipc-contracts/host-quit-types";
import { log } from "../app/logger";
import type { HostQuitPrompt } from "../ipc/runner-ipc-bridge";

/** `dialog.showMessageBox` without a parent window, injectable for tests. */
export type ShowMessageBox = (
  options: MessageBoxOptions,
) => Promise<MessageBoxReturnValue>;

const KEEP = 0;
const STOP = 1;
const CANCEL = 2;

interface NativeQuitCopy {
  readonly message: string;
  readonly detail: string;
  readonly stopLabel: string;
}

/**
 * One copy per round. Only `busy-retry` says something started meanwhile:
 * `busy` is Stop-if-idle's first ask, after a stop nobody was shown was
 * refused, so there was no earlier moment for the work to have started after.
 */
function nativeQuitCopy(round: HostQuitPrompt["round"]): NativeQuitCopy {
  switch (round) {
    case "busy":
      return {
        message: "The host is still working",
        detail:
          "Keep it running so that work carries on, or stop it now, which ends it.",
        stopLabel: "Stop Host and Quit",
      };
    case "busy-retry":
      return {
        message: "The host is still working",
        detail:
          "Something started on the host while it was being stopped. Keep it running so that work carries on, or stop it now, which ends it.",
        stopLabel: "Stop Host and Quit",
      };
    case "initial":
      return {
        message: "Can't tell what's running on the host",
        detail:
          "Traycer can't check the host right now. Keep it running so any agents, terminals and shells carry on, or stop it, which ends anything still running.",
        stopLabel: "Stop Host Anyway and Quit",
      };
  }
}

/**
 * The quit prompt when no renderer can answer it: no window is open (a tray
 * quit on macOS), or the MRU window is not listening, never acknowledged, or
 * closed mid-question. Same three choices as the modal, but main cannot see
 * what the host is running, so the copy says so and - like the modal's
 * "can't tell" state - Keep is the default and Stop is the force, its label
 * carrying the consequence. No list, no Remember.
 *
 * Resolves, never rejects: a dialog that cannot be shown answers Keep, the
 * choice that never loses work.
 */
export async function askHostQuitNatively(
  prompt: HostQuitPrompt,
  signal: AbortSignal,
  showMessageBox: ShowMessageBox,
): Promise<HostQuitDecision> {
  const copy = nativeQuitCopy(prompt.round);
  let response: number;
  try {
    ({ response } = await showMessageBox({
      type: "question",
      title: "Quit Traycer",
      message: copy.message,
      detail: copy.detail,
      buttons: ["Keep Running and Quit", copy.stopLabel, "Cancel"],
      defaultId: KEEP,
      cancelId: CANCEL,
      noLink: true,
      signal,
    }));
  } catch (error) {
    log.warn("[host-quit] native prompt failed", {
      mode: prompt.mode,
      reason: "dialog-failed",
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return { kind: "keep", remember: false };
  }
  switch (response) {
    case STOP:
      return { kind: "stop", force: true, remember: false };
    case CANCEL:
      return { kind: "cancel" };
    default:
      return { kind: "keep", remember: false };
  }
}

export interface QuitAndStopHostConfirmation {
  readonly confirmed: boolean;
  /** "Always stop the host when I quit": the mode becomes Linked. */
  readonly remember: boolean;
}

/**
 * The tray's "Quit and Stop Host" confirm. It bypasses the quit modal, so the
 * force is disclosed here: everything running on the host ends, with no
 * second question. Cancel is the default and the escape key's answer.
 */
export async function confirmQuitAndStopHost(
  showMessageBox: ShowMessageBox,
): Promise<QuitAndStopHostConfirmation> {
  try {
    const answer = await showMessageBox({
      type: "warning",
      title: "Quit and Stop Host",
      message: "Stop the host and quit Traycer?",
      detail:
        "Everything running on the host ends now - agents, terminals and shells - without asking again.",
      buttons: ["Cancel", "Stop Host and Quit"],
      defaultId: 0,
      cancelId: 0,
      checkboxLabel:
        "Always stop the host when I quit (change this in Settings → General)",
      checkboxChecked: false,
      noLink: true,
    });
    return {
      confirmed: answer.response === 1,
      remember: answer.response === 1 && answer.checkboxChecked,
    };
  } catch (error) {
    log.warn("[host-quit] quit and stop host confirm failed", {
      reason: "dialog-failed",
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return { confirmed: false, remember: false };
  }
}
