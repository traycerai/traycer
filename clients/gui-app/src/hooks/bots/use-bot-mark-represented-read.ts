import { useRef, useState } from "react";
import type { BotReadCursorAdvanceRequest } from "@traycer/protocol/host/bot/schemas";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useBotReadCursorAdvanceMutation } from "@/hooks/bots/use-bot-read-cursor";

/** A retry finishes the captured batch; newer arrivals belong to the next action. */
export function useBotMarkRepresentedRead(
  targets: readonly BotReadCursorAdvanceRequest[],
): {
  readonly markRead: () => void;
  readonly pending: boolean;
  readonly failed: boolean;
} {
  const mutation = useBotReadCursorAdvanceMutation(useTabHostClient());
  const [remaining, setRemaining] = useState<
    readonly BotReadCursorAdvanceRequest[]
  >([]);
  const running = useRef(false);
  const markRead = (): void => {
    if (running.current) return;
    const captured = remaining.length > 0 ? remaining : targets;
    if (captured.length === 0) return;
    running.current = true;
    const run = async (): Promise<void> => {
      const failed: BotReadCursorAdvanceRequest[] = [];
      for (const target of captured) {
        try {
          await mutation.mutateAsync(target);
        } catch {
          failed.push(target);
        }
      }
      setRemaining(failed);
      running.current = false;
    };
    void run();
  };
  return {
    markRead,
    pending: mutation.isPending,
    failed: remaining.length > 0,
  };
}
