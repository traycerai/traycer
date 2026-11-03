/** A message the person sent to an agent, as the share nudge sees it. */
export interface SentChatMessage {
  /** The message's plain text. Read on the device only; never logged or sent. */
  readonly text: string;
  readonly epicId: string;
  /** The host the chat runs on, for reading this task's usage. */
  readonly hostId: string | null;
}

type SentChatMessageListener = (message: SentChatMessage) => void;

const listeners = new Set<SentChatMessageListener>();

/** Follow accepted sends; returns the unsubscribe. */
export function subscribeSentChatMessages(
  listener: SentChatMessageListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Tell the share nudge about a send once it is accepted, and hand the
 * acceptance back unchanged, so a send path can wrap its result in this
 * without changing what it returns. A send held behind a dialog resolves
 * later; it is reported when (and only if) it resolves accepted.
 */
export function reportSentChatMessage(
  accepted: boolean | Promise<boolean>,
  message: SentChatMessage,
): boolean | Promise<boolean> {
  if (typeof accepted === "boolean") {
    if (accepted) notify(message);
    return accepted;
  }
  return accepted.then((value) => {
    if (value) notify(message);
    return value;
  });
}

function notify(message: SentChatMessage): void {
  for (const listener of listeners) listener(message);
}
