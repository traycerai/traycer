import { useCallback, useMemo, useState } from "react";

/**
 * Whether the person's last send in one channel or thread failed before the
 * host acknowledged it: the message box's own send, or an option they
 * clicked, which is their next message. The box says it once, until they
 * edit or send again.
 *
 * A box's send that failed after the person began a newer draft keeps what
 * it sent here (`unsent`), for the failure line to put back, and says it
 * until they put it back or send again.
 */
export interface BotSendFailure {
  readonly failed: boolean;
  /** The box's failed send, kept while the box holds a newer draft; `null` otherwise. */
  readonly unsent: BotUnsentMessage | null;
  readonly fail: (unsent: BotUnsentMessage | null) => void;
  readonly clear: () => void;
}

/** A message the box sent that never reached the conversation. */
export interface BotUnsentMessage {
  /** As the box showed it. */
  readonly text: string;
  /** As it was sent: each mention as its member's token. */
  readonly wire: string;
  /** The failed message it was to replace; `null` for a new message. */
  readonly supersedes: string | null;
}

const NOT_FAILED = { failed: false, unsent: null } as const;

export function useBotSendFailure(): BotSendFailure {
  const [state, setState] = useState<{
    readonly failed: boolean;
    readonly unsent: BotUnsentMessage | null;
  }>(NOT_FAILED);
  const fail = useCallback(
    (unsent: BotUnsentMessage | null) => setState({ failed: true, unsent }),
    [],
  );
  const clear = useCallback(() => setState(NOT_FAILED), []);
  return useMemo(
    () => ({ failed: state.failed, unsent: state.unsent, fail, clear }),
    [clear, fail, state],
  );
}
