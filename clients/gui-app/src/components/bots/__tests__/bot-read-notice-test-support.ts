import type { BotReadNotice } from "@/components/bots/bot-read-failure";

/** When the rows a stale notice keeps loaded. */
const LOADED_AT = 1_700_000_000_000;

/** A failing read of the thread list that keeps the replies it last returned. */
export function staleNotice(retry: () => void): BotReadNotice {
  return {
    view: { kind: "stale", failure: "server", loadedAt: LOADED_AT },
    retry,
    retrying: false,
  };
}

/** A failing read of the thread list with no replies to keep. */
export function failedNotice(retry: () => void): BotReadNotice {
  return {
    view: { kind: "failed", failure: "server", rowsWithheld: false },
    retry,
    retrying: false,
  };
}
