import { createContext, use } from "react";

/**
 * The rendered transcript's own session's answer to
 * `ChatSessionState.queuePauseReasonProtocolSupported`, provided by the view
 * that mounts the transcript (`ChatTileSessionView`) from the handle it
 * renders.
 *
 * A context rather than a registry lookup, because the registry does not hold
 * every handle a transcript renders from: a published or replica copy's handle
 * is created locally and never registered, so a lookup answered `null` for
 * those views whatever their own store said. `null` outside any provider: no
 * session, so it cannot say.
 */
export const TranscriptQueuePauseReasonSupportContext = createContext<
  boolean | null
>(null);

/**
 * The value above, for the readers that must agree on which rows are hidden
 * (`hidden-transcript-notices.ts`): the timeline and chat find.
 */
export function useTranscriptQueuePauseReasonSupport(): boolean | null {
  return use(TranscriptQueuePauseReasonSupportContext);
}
