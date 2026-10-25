import { useCallback, useMemo, useState } from "react";

/**
 * Whether the person's last send in one channel or thread failed before the
 * host acknowledged it: the message box's own send, or an option they
 * clicked, which is their next message. The box says it once, with the text
 * kept, until they edit or send again.
 */
export interface BotSendFailure {
  readonly failed: boolean;
  readonly fail: () => void;
  readonly clear: () => void;
}

export function useBotSendFailure(): BotSendFailure {
  const [failed, setFailed] = useState(false);
  const fail = useCallback(() => setFailed(true), []);
  const clear = useCallback(() => setFailed(false), []);
  return useMemo(() => ({ failed, fail, clear }), [clear, fail, failed]);
}
