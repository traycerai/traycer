import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import {
  publicationStateFromResponse,
  type ChatForkPublicationState,
} from "@/components/chat/chat-fork-target";

const UNKNOWN: ChatForkPublicationState = { kind: "unknown" };

/**
 * Whether the SOURCE chat's cloud publication covers a chosen fork boundary.
 *
 * Asked of the host that OWNS the chat, which for the fork dialog is the tab's
 * host by construction — the dialog lives inside the source chat's tile, so the
 * tab client addresses the owning host without any lookup, and the answer is
 * always fresh rather than replicated.
 *
 * ## Every failure resolves to `unknown`, on purpose
 *
 * The method rides the optional-capabilities channel, so a source host that
 * predates it answers `E_HOST_UNSUPPORTED` for this call alone. That refusal,
 * an unreachable host, and an in-flight read are all the same thing to the
 * gate: *nothing is known*. They must never collapse to "unpublished", which
 * would block a fork on a fact this client never learned — the same tri-state
 * discipline the negotiated-version read follows, and the reason Layer 2's
 * typed host-side refusal exists as the backstop.
 *
 * Gated on `useHostSupportsMethod` rather than fired-and-caught: against an old
 * host the capability gate means no request is issued at all, so the common
 * mixed-fleet case costs nothing and produces no error noise.
 *
 * Its unknown -> false collapse is safe HERE, and for a reason that does not
 * depend on any claim about traffic elsewhere: an unresolved capability
 * disables the query, the gate reads `unknown`, and `unknown` is PERMISSIVE.
 * Nothing parks on it — the fork proceeds and Layer 2 remains the authority —
 * so the worst case of never learning the answer is exactly the post-A4
 * behaviour, not a deadlock. That is what distinguishes this from a surface
 * that gates its affordances on a `false` and thereby switches off the reads
 * that would refresh it.
 */
export function useChatPublicationState(args: {
  /** The SOURCE host's client — the tab client in the fork dialog. */
  readonly client: HostClient<HostRpcRegistry> | null;
  /** The SOURCE host's id, which is what the capability gate is keyed by. */
  readonly hostId: string | null;
  readonly epicId: string;
  /** `null` closes the read down entirely (no chat in hand). */
  readonly chatId: string | null;
  /**
   * The fork boundary. `null` asks the coarser "is this chat backed up at all?"
   * question, which the host answers with `boundaryCovered: null` — NOT ASKED,
   * never "not covered".
   */
  readonly boundaryMessageId: string | null;
  /** The surface is showing this question right now. */
  readonly enabled: boolean;
}): ChatForkPublicationState {
  const supportsMethod = useHostSupportsMethod(
    args.hostId,
    "epic.chatPublicationState",
  );
  // Hoisted, and the gate the RESULT is read through as well as the one the
  // request is issued under. TanStack retains cached data across both a
  // disabled observer and a failed refetch, so reading `query.data` alone would
  // let a stale answer outlive the conditions that made it askable: a cached
  // `published: false` would keep every remote row inert after the chat has
  // since published and the source host has gone unreachable — a state the gate
  // table expressly calls unknown-allowed, and one where Layer 2 could now
  // succeed. Same leak if method support flips, or a multi-host account becomes
  // single-host.
  const isEnabled =
    args.enabled &&
    args.chatId !== null &&
    args.client !== null &&
    supportsMethod;
  const query = useHostQuery<HostRpcRegistry, "epic.chatPublicationState">({
    cacheKeyIdentity: [args.chatId, args.boundaryMessageId],
    client: args.client,
    method: "epic.chatPublicationState",
    params: {
      epicId: args.epicId,
      chatId: args.chatId ?? "",
      boundaryMessageId: args.boundaryMessageId,
    },
    options: {
      enabled: isEnabled,
      // Short, not zero: a boundary that is merely not-yet-covered clears
      // within a publish sweep, and reopening the dialog re-reads. A long
      // window would keep telling the user to retry after it had resolved.
      staleTime: 5_000,
      // The waiting answers re-ask on their own, via the CONDITION LANE this
      // method carries in `host-method-policy-table.ts` — cadence lives there,
      // never here (`refetchInterval` is `Omit`ted from these options precisely
      // so it cannot be set per call site). `staleTime` alone only marks the
      // cache stale and issues nothing for a mounted, idle observer, so without
      // that lane an open dialog would sit forever on copy that promises the
      // wait resolves itself.
    },
  });
  // Not asking, asking and failing, and asking again are ALL "nothing is known"
  // — never a retained older answer. Same tri-state discipline as the
  // negotiated-version read, applied to the CACHE rather than to the wire.
  //
  // `isFetching` is the third of these and the least obvious: TanStack keeps the
  // previous successful `data` while a stale query REFETCHES, so a hung or
  // in-flight refresh reads `isEnabled: true, isError: false, data: <the old
  // answer>`. Trusting it would keep every remote row inert on a `published:
  // false` the chat has since outgrown — and this hook's own contract calls an
  // in-flight read unknown, so honouring the cache there would contradict it.
  //
  // The dialog CAN see this mid-session, and that is intended rather than
  // tolerated. `useHostQuery` refetches whenever the client announces a
  // host/auth/availability transition (`use-host-query.ts`, and
  // `query-invalidator.ts` on host bind and availability recovery), so a
  // recovery while this dialog is open does re-read and does briefly return
  // unknown here. That is the RIGHT answer: the retained publication fact is
  // exactly what such a refetch is revalidating, so continuing to gate rows on
  // it across a trust-boundary change would be trusting the very thing under
  // re-examination. On the ordinary path the only refetch is on mount - the
  // dialog opening - where "unknown until answered" is the intended state.
  if (!isEnabled) return UNKNOWN;
  if (query.isError) return UNKNOWN;
  if (query.isFetching) return UNKNOWN;
  const data = query.data;
  if (data === undefined) return UNKNOWN;
  return publicationStateFromResponse(data);
}
