import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { TranscriptRowLocator } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

/**
 * The ordinal a cross-tile jump target sits at, when only the host can say.
 *
 * The client resolves most jump targets itself and reads the ordinal off the
 * skeleton it already holds. Two kinds it cannot: a `block` anchor and a
 * `sent-message` anchor are both found by walking RENDERED models, and a cold
 * row has none. Waiting for such a row is a deadlock rather than a delay - the
 * scroll drives hydration and the scroll is what the unresolved jump is holding
 * back - so the host is asked where the row is and the answer feeds the same
 * `requestTranscriptOrdinal` channel every other cold target uses.
 *
 * Disabled by passing `target: null`, which is the ordinary state: the query
 * exists only for the beat between an unresolved jump and the row landing.
 *
 * ## Not retried, and not an error surface
 *
 * `retry: false` and no `onError` toast. `found: false` is an ordinary answer -
 * the block may belong to a turn a checkpoint removed - and an older host
 * rejects the method outright with `E_HOST_UNSUPPORTED`, which is the correct
 * degrade rather than a fault: that host serves the whole transcript, so the
 * row is never cold and the jump resolves on its own. Both cases land on the
 * same behavior the jump already has for a target that never arrives, which is
 * to time out quietly.
 */
export function useChatLocateRow(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly chatId: string;
  readonly target: TranscriptRowLocator | null;
}): number | null {
  const { chatId, client, epicId, target } = args;
  const query = useHostQuery<HostRpcRegistry, "chat.locateRow">({
    client,
    method: "chat.locateRow",
    // The disabled shape still needs well-typed params. A `block` locator with
    // an empty id is never dispatched - `enabled` is false in exactly that
    // case - and it keeps the key stable while no jump is outstanding.
    params: {
      epicId,
      chatId,
      target: target ?? { kind: "block", blockId: "" },
    },
    // The params ARE the identity - a locator names exactly one row - so there
    // is no newer content revision for the key to vary by.
    cacheKeyIdentity: undefined,
    options: {
      enabled: target !== null,
      // A row's ordinal is not immutable - an earlier row appearing shifts it -
      // but the answer is consumed within the same jump, and a jump re-issued
      // later advances `requestId` and asks again. Caching across the tile's
      // life would hand a stale position to a much later jump.
      staleTime: 0,
      gcTime: 0,
      retry: false,
    },
  });
  if (target === null) return null;
  const data = query.data;
  if (data === undefined || !data.found) return null;
  return data.ordinal;
}
