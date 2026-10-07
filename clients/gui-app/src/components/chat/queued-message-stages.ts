import { createContext } from "react";
import type { QueueItemInFlight } from "@/stores/chats/queue-edit-custody";

/**
 * What this client knows about its own unanswered frames, for the queue rows
 * and the status line beside the composer.
 *
 * Kept apart from the queue itself on purpose. The queue is the HOST's account
 * of each row; these are local facts about frames still in flight, and a row
 * that mixed the two could no longer say which of them a label came from.
 */
export interface QueuedMessageStages {
  /** Rows with a mutation the host has not answered, by `queueItemId`. */
  readonly inFlight: ReadonlyMap<string, QueueItemInFlight>;
  /**
   * `clientActionId`s of sends that have passed the display deadline on an open
   * stream with no ack. Never evidence that a send failed.
   */
  readonly unconfirmedSendActionIds: ReadonlySet<string>;
  /** Asks the host what became of those sends; `null` where nothing can ask. */
  readonly onCheckDelivery: (() => void) | null;
  /**
   * This chat's own stream is not open after its snapshot had loaded, so every
   * action is refused until it reconnects. The stream's status, not host
   * reachability: a host can be reachable while this chat's stream is down.
   */
  readonly streamReconnecting: boolean;
}

export const NO_QUEUED_MESSAGE_STAGES: QueuedMessageStages = {
  inFlight: new Map(),
  unconfirmedSendActionIds: new Set(),
  onCheckDelivery: null,
  streamReconnecting: false,
};

/**
 * Provided by the chat tile, which owns the session store. A context rather
 * than a prop through the dock: the dock and its panels are also drawn by
 * surfaces with no session at all (the layout editor's sample workspace), and
 * for those the default - nothing in flight - is simply true.
 */
export const QueuedMessageStagesContext = createContext<QueuedMessageStages>(
  NO_QUEUED_MESSAGE_STAGES,
);
