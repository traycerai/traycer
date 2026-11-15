import { useMemo } from "react";
import { botReadView, type BotReadView } from "@/lib/bots/bot-read-view";

/** What a bot read draws (`botReadView`), kept while the read's state is. */
export function useBotReadView(read: {
  readonly isError: boolean;
  readonly data: unknown;
  readonly error: unknown;
  readonly dataUpdatedAt: number;
}): BotReadView {
  const { isError, data, error, dataUpdatedAt } = read;
  return useMemo(
    () => botReadView({ isError, data, error, dataUpdatedAt }),
    [data, dataUpdatedAt, error, isError],
  );
}
