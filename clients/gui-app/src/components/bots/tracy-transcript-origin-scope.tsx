import { useMemo, type ReactNode } from "react";
import { TracyTranscriptOriginContext } from "@/components/bots/tracy-transcript-origin-context";
import type { TracyTranscriptOrigin } from "@/lib/tab-navigation/intents";

/**
 * Marks what it wraps as the transcript of `botId`'s channel, one of its
 * threads, or one of its sessions: a link in it that opens a task leaves the
 * task a way back to that channel. Only transcript content is wrapped; a list
 * of the bot's tasks or its activity opens a task the way any list does.
 */
export function TracyTranscriptOriginScope(props: {
  readonly botId: string;
  readonly children: ReactNode;
}): ReactNode {
  const { botId, children } = props;
  const origin = useMemo((): TracyTranscriptOrigin => ({ botId }), [botId]);
  return (
    <TracyTranscriptOriginContext value={origin}>
      {children}
    </TracyTranscriptOriginContext>
  );
}
