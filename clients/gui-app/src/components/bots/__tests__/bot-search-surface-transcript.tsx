import { useRef, type ReactNode } from "react";
import { mocks } from "./bot-search-surface-support";
import type { BotTranscriptLanding } from "@/components/bots/bot-chat-transcript";
import { useBotSearchWordMarks } from "@/hooks/bots/use-bot-search-word-marks";

/**
 * Stands for the channel's transcript: shows what the view hands it (the
 * chat, the message it lands on) and draws the rows a case sets, whose words
 * the REAL `useBotSearchWordMarks` marks with the REAL `RangeHighlighter`.
 */
export function TranscriptStub(props: {
  readonly chatId: string;
  readonly surface: { readonly kind: string } | null;
  readonly header: ReactNode;
  readonly landOn: BotTranscriptLanding | null;
}): ReactNode {
  const transcript = useRef<HTMLDivElement | null>(null);
  useBotSearchWordMarks(transcript, props.chatId, (messageId) => messageId);
  const rows = mocks.state.rows.get(props.chatId) ?? [];
  return (
    <div
      ref={transcript}
      data-testid={`stub-transcript-${props.surface === null ? "session" : props.surface.kind}`}
      data-chat-id={props.chatId}
      data-land-on={props.landOn?.messageId ?? "none"}
    >
      {props.header}
      {rows.map((row) => (
        <p key={row.messageId} data-message-id={row.messageId}>
          {row.text}
        </p>
      ))}
    </div>
  );
}
