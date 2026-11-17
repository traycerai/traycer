// A leaf: imports no hook and nothing of `@/lib/host`, whose mutation sends through it.
import { HostRequestAbortedError } from "@traycer-clients/shared/host-transport/host-messenger";

export type PendingSettingsSave =
  | {
      readonly kind: "send";
      readonly answered: () => void;
      readonly failed: () => void;
    }
  /** Ends as an aborted request, which no notice reports. */
  | { readonly kind: "abandoned"; readonly method: string };

/** An answer that proposes nothing settles the save as not proposed, so nothing is applied. */
export async function sendFollowedSave<T>(
  pending: PendingSettingsSave,
  send: () => Promise<T>,
  proposes: (answer: T) => boolean,
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
  if (proposes(answer)) pending.answered();
  else pending.failed();
  return answer;
}

export function everyAnswerProposes(): boolean {
  return true;
}

/** Null for a request abandoned before it was sent: nothing went out, so the screen says nothing. */
export function reportedSaveFailure<E>(error: E): E | null {
  return error instanceof HostRequestAbortedError && !error.mayHaveDispatched
    ? null
    : error;
}
