import { useMemo } from "react";
import { useBotLifetime } from "@/lib/bots/bot-lifetime";
import { retainedReadableBy } from "@/lib/bots/bot-read-readability";
import { botReadView, type BotReadView } from "@/lib/bots/bot-read-view";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * What a bot read draws (`botReadView`) for the person reading now, kept
 * while the read's state, that person and the bot lifetime are. The lifetime
 * is a dependency of its own: an account change away and back in one batch
 * leaves the person the same and moves only the lifetime.
 */
export function useBotReadView(read: {
  readonly isError: boolean;
  readonly data: unknown;
  readonly error: unknown;
  readonly dataUpdatedAt: number;
}): BotReadView {
  const { isError, data, error, dataUpdatedAt } = read;
  const viewer = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  const lifetime = useBotLifetime();
  return useMemo(
    () =>
      botReadView(
        { isError, data, error, dataUpdatedAt },
        retainedReadableBy(data, viewer, lifetime),
      ),
    [data, dataUpdatedAt, error, isError, lifetime, viewer],
  );
}
