import { useMemo } from "react";
import { retainedReadableBy } from "@/lib/bots/bot-read-readability";
import { botReadView, type BotReadView } from "@/lib/bots/bot-read-view";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * What a bot read draws (`botReadView`) for the person reading now, kept
 * while the read's state and that person are.
 */
export function useBotReadView(read: {
  readonly isError: boolean;
  readonly data: unknown;
  readonly error: unknown;
  readonly dataUpdatedAt: number;
}): BotReadView {
  const { isError, data, error, dataUpdatedAt } = read;
  const viewer = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  return useMemo(
    () =>
      botReadView(
        { isError, data, error, dataUpdatedAt },
        retainedReadableBy(data, viewer),
      ),
    [data, dataUpdatedAt, error, isError, viewer],
  );
}
