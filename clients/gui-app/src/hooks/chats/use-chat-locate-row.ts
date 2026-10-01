import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { TranscriptRowLocator } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

/**
 * The ordinal a cross-tile jump target sits at, when only the host can say.
 *
 * The client resolves some jump targets itself and reads the ordinal off the
 * skeleton it already holds. Five kinds it cannot. A `block` anchor, a
 * `sent-message` anchor, a `receipt` anchor and an `approval` anchor (the
 * inline plan card) are all found by walking RENDERED models, and a cold
 * row has none. A `message` anchor naming an ASSISTANT record has no row
 * id to look up either way: those rows are turn-keyed, and the durable id
 * survives only as the rendered model's `persistentMessageId` - so the
 * skeleton read misses and the rendered read needs the very hydration
 * being waited on.
 *
 * Waiting for such a row is a deadlock rather than a delay - the scroll drives
 * hydration and the scroll is what the unresolved jump is holding back - so the
 * host is asked where the row is and the answer feeds the same
 * `requestTranscriptOrdinal` channel every other cold target uses.
 *
 * Disabled by passing `target: null`, which is the ordinary state: the query
 * exists only for the beat between an unresolved jump and the row landing.
 *
 * ## The answer is a coordinate, so it is checked against the space
 *
 * This is a unary RPC on a different connection from the stream. Between the
 * host numbering the row and this hook returning the number the transcript can
 * be re-based - a restore, a checkpoint, a compaction - and an ordinal from a
 * superseded epoch is in-range, fetchable, and points at the wrong row. So the
 * caller passes the epoch its window is holding, the answer is discarded unless
 * the two agree, and the epoch is part of the cache key so a re-base re-asks
 * rather than re-serving. It is the same rule a `loadRange` response is subject
 * to, deliberately: one coordinate, one notion of when it is usable.
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
export function useChatLocateRow(args: ChatLocateRowArgs): number | null {
  const answer = useChatLocateRowAnswer(args);
  return answer.status === "found" ? answer.ordinal : null;
}

export interface ChatLocateRowArgs {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly chatId: string;
  readonly target: TranscriptRowLocator | null;
  /**
   * The transcript epoch this caller's window is in. An answer numbered in any
   * other one is discarded.
   */
  readonly epoch: number;
}

/**
 * What the host has said about the row so far.
 *
 * - `waiting`: nothing usable yet - disabled, in flight, or answered in an
 *   epoch this window has left (the key change re-asks).
 * - `found`: the ordinal, in this window's epoch.
 * - `missing`: settled without a row - `found: false`, or the RPC rejected
 *   (`E_HOST_UNSUPPORTED` included). Final for this target and epoch.
 */
export type ChatLocateRowAnswer =
  | { readonly status: "waiting" }
  | { readonly status: "found"; readonly ordinal: number }
  | { readonly status: "missing" };

const WAITING: ChatLocateRowAnswer = { status: "waiting" };
const MISSING: ChatLocateRowAnswer = { status: "missing" };

/**
 * {@link useChatLocateRow}, keeping the difference between "not answered yet"
 * and "answered: no row". A jump does not need it - both time out quietly - but
 * a caller that must give up on a target the moment the host does (chat find's
 * index read) does.
 */
export function useChatLocateRowAnswer(
  args: ChatLocateRowArgs,
): ChatLocateRowAnswer {
  const { chatId, client, epicId, epoch, target } = args;
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
    // The locator names one row, but the ANSWER is an ordinal, and an ordinal
    // is only meaningful inside one coordinate space. So the epoch is part of
    // the identity: a re-base has to re-ask rather than be served the position
    // the previous space put the row at.
    cacheKeyIdentity: [epoch],
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
  if (target === null) return WAITING;
  const data = query.data;
  if (data === undefined) return query.isError ? MISSING : WAITING;
  if (!data.found) return MISSING;
  // The epoch check, and it is load-bearing rather than belt-and-braces: the
  // cache key above stops a SUPERSEDED answer being re-served, and this stops an
  // in-flight one landing after the re-base that voided it. Falling back to
  // `waiting` puts the jump exactly where an unanswered one already is -
  // waiting, and re-asked under the new epoch by the key change.
  if (data.epoch !== epoch) return WAITING;
  return { status: "found", ordinal: data.ordinal };
}
