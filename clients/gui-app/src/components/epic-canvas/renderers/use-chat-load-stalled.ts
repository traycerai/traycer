import { useState } from "react";
import { useDeadlineReached } from "@/hooks/use-deadline-reached";
import type { PreSnapshotRetryEvidence } from "@/stores/chats/chat-session-store";

/**
 * How many failed attempts before the tile stops presenting the load as
 * ordinary.
 *
 * Three, because two is one retry - the shape of a host restart or a
 * sleep-wake redial, both of which recover on their own - and telling the
 * reader something is wrong there would be wrong more often than right. The
 * third failure is the first one that is a pattern.
 */
export const STALLED_CHAT_LOAD_ATTEMPTS = 3;

/**
 * ...and how long the wait itself may run before the same verdict is reached
 * anyway, counted from when the wait began rather than from any failure.
 *
 * The count alone is not enough, for two different reasons. The reconnect
 * ladder backs off, so a host that refuses slowly - or a dial that hangs
 * before failing - can spend a long time on attempt one. And a host that acks
 * `chat.subscribe` and then goes silent never produces an attempt to count at
 * all, which is the case that would otherwise spin forever.
 *
 * 20s is deliberately more patient than `TILE_CONTENT_BUDGET_MS` (15s): the
 * pane this drives is not terminal and the load may still land on its own, so
 * the cost of waiting slightly longer is a few more seconds of spinner where
 * it was about to succeed.
 */
export const STALLED_CHAT_LOAD_ELAPSED_MS = 20_000;

/**
 * Whether this chat's pre-snapshot wait has gone on long enough to stop
 * presenting as ordinary.
 *
 * ONE verdict with two consumers, and that is the whole reason it is a hook of
 * its own rather than three lines inside the gate. The pane says "still
 * opening" on it, and the refusal recorder infers a store refusal from it
 * (`useRecordHostOlderThanDataRefusal`) - and those two must not be able to
 * disagree about when the budget ran out. Two copies would each carry their
 * own `Date.now()` anchor and their own timer.
 *
 * Call it from the component that IS the chat, so the anchor is scoped to one
 * chat by construction: the wait is anchored at first render, and an instance
 * carried over to a different chat would inherit the first one's start and
 * declare a fresh load stalled on sight.
 */
export function useChatLoadStalled(input: {
  readonly retries: PreSnapshotRetryEvidence | null;
  readonly snapshotLoaded: boolean;
}): boolean {
  // The wait starts at this component's first render, NOT at the first
  // failure - that distinction is the whole deadline. A host can ack
  // `chat.subscribe` and then send neither a snapshot nor a close, with
  // heartbeat pongs keeping the socket alive underneath; nothing ever
  // transitions to `reconnecting`, so `retries` stays null forever and a
  // budget anchored on the first failure never arms at all.
  const [waitStartedAt] = useState(() => Date.now());
  // The streak's own start still wins where it is EARLIER, so a tile mounting
  // into a stall that is already old inherits it instead of restarting the
  // budget. `Math.min` rather than a preference for one or the other:
  // whichever came first is when this wait actually began, and a failure that
  // lands after the first render does not restart it.
  const waitBeganAt =
    input.retries === null
      ? waitStartedAt
      : Math.min(input.retries.firstAt, waitStartedAt);
  // A loaded chat is not waiting, and passing `null` also disarms the timer
  // rather than leaving one armed behind every open transcript.
  const stalledLongEnough = useDeadlineReached(
    input.snapshotLoaded ? null : waitBeganAt + STALLED_CHAT_LOAD_ELAPSED_MS,
  );
  if (input.snapshotLoaded) return false;
  // Either arm alone is enough, and the elapsed one does not require a failure
  // to have happened: a wait long enough to give up presenting as ordinary is
  // a wait long enough whether the host refused three times or said nothing.
  return (
    stalledLongEnough ||
    (input.retries !== null &&
      input.retries.count >= STALLED_CHAT_LOAD_ATTEMPTS)
  );
}
