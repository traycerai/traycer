import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { TranscriptRowLocator } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

/** Host ordinal for jump targets the client cannot locate. Discard answers from a different epoch. retry false. */
export function useChatLocateRow(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly chatId: string;
  readonly target: TranscriptRowLocator | null;
  /** Discard an answer numbered in any other epoch. */
  readonly epoch: number;
}): number | null {
  const { chatId, client, epicId, epoch, target } = args;
  const query = useHostQuery<HostRpcRegistry, "chat.locateRow">({
    client,
    method: "chat.locateRow",
    params: {
      epicId,
      chatId,
      target: target ?? { kind: "block", blockId: "" },
    },
    cacheKeyIdentity: [epoch],
    options: {
      enabled: target !== null,
      staleTime: 0,
      gcTime: 0,
      retry: false,
    },
  });
  if (target === null) return null;
  const data = query.data;
  if (data === undefined || !data.found) return null;
  // In-flight answer from a superseded epoch is discarded; the jump waits and re-asks.
  if (data.epoch !== epoch) return null;
  return data.ordinal;
}
