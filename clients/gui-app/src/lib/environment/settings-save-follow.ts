/**
 * A settings save as the coordinator follows it, and its send. A leaf: it
 * imports no hook and nothing of `@/lib/host`, because `useHostMutation`
 * sends through it and sits inside that barrel's own import graph.
 */
import { HostRequestAbortedError } from "@traycer-clients/shared/host-transport/host-messenger";

/** One save about to be sent to a host, as the coordinator follows it. */
export type PendingSettingsSave =
  | {
      readonly kind: "send";
      /** The host answered the save. */
      readonly answered: () => void;
      /** The save failed, or nothing answered it. */
      readonly failed: () => void;
    }
  /**
   * The sign-in the save was pressed on ended, or its account changed, while
   * it was prepared: it is not sent, and ends as an aborted request, which no
   * notice reports.
   */
  | { readonly kind: "abandoned"; readonly method: string };

/** Sends a followed save and tells `pending` whether the host answered it. */
export async function sendFollowedSave<T>(
  pending: PendingSettingsSave,
  send: () => Promise<T>,
): Promise<T> {
  if (pending.kind === "abandoned") {
    throw new HostRequestAbortedError({
      message: "The account changed before the save was sent",
      requestId: crypto.randomUUID(),
      method: pending.method,
      mayHaveDispatched: false,
    });
  }
  let answer: T;
  try {
    answer = await send();
  } catch (cause) {
    pending.failed();
    throw cause;
  }
  pending.answered();
  return answer;
}
