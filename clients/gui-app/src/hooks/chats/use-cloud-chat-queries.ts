import { useMemo } from "react";
import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  toHostRpcError,
  type HostRpcError,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  readCloudChat,
  type CloudChatRead,
} from "@traycer-clients/shared/cloud-chat/cloud-chat-reader";
import { webCryptoSha256Hex } from "@traycer-clients/shared/cloud-chat/bytes";
import {
  decodeCloudChatPayload,
  type CloudChatPayloadBytes,
} from "@/lib/chats/cloud-chat-payloads";
import type { CloudChatIdentity } from "@traycer/protocol/host/epic/cloud-chat";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { cloudChatListCacheKeyIdentity } from "@/lib/chats/cloud-chat-list-cache";
import { createHostCloudChatReadPort } from "@/lib/chats/cloud-chat-read-port";
import { activeChatPartCache } from "@/lib/chats/cloud-chat-part-cache";
import { cloudChatQueryKeys } from "@/lib/query-keys/cloud-chat-query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * The cloud-chat read hooks.
 *
 * Everything here is VIEWER-scoped, and that is a privacy requirement rather
 * than a caching nicety: these responses are the caller's ACL-filtered view and
 * include the caller's own private chats, so two viewers on one installation
 * have different correct answers. The signed-in user id therefore rides every
 * key (see `cloud-chat-query-keys.ts`), and every hook disables itself when no
 * viewer is resolved - there is no such thing as an unattributed cloud read.
 *
 * No hook here attaches a toast. Every consumer is an inline surface: a list
 * section that hides itself, a dialog that states its refusal in place. A toast
 * would announce an older host as an error, which is the one thing the
 * degrade-to-unsupported story exists to avoid.
 */

/**
 * The signed-in viewer's id, as the key component these reads must carry.
 *
 * `""` when no identity is resolved, which callers turn into a disabled query
 * rather than an unattributed request. Exported so anything invalidating these
 * slots derives the same value from the same place - a second spelling of "who
 * is viewing" would eventually disagree with this one.
 */
export function useCloudChatViewerId(): string {
  return useAuthStore((state) => state.contextMetadata?.userId ?? "");
}

export interface UseCloudChatListArgs {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly taskId: string;
  readonly enabled: boolean;
}

/**
 * A task's cloud chats: every `task`-visible chat plus the viewer's OWN private
 * ones, from every host they have ever used.
 *
 * Not polled. A published head changes only when its owning host publishes
 * again and this reader has no signal for that, so an interval would spend
 * requests on a list that is almost always identical. It refetches on host/auth
 * transitions (the key is host-scoped) and on explicit invalidation.
 */
export function useCloudChatList(
  args: UseCloudChatListArgs,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "epic.listCloudChats">,
  HostRpcError
> {
  const viewerUserId = useCloudChatViewerId();
  const params = useMemo(() => ({ taskId: args.taskId }), [args.taskId]);
  return useHostQuery<HostRpcRegistry, "epic.listCloudChats">({
    // The one shared spelling of this key's viewer component -
    // `cloudChatListQueryKey` (the imperative reader's builder) appends the
    // same call to the same base, which is what keeps the two sides of that
    // seam from drifting.
    cacheKeyIdentity: cloudChatListCacheKeyIdentity(viewerUserId),
    client: args.client,
    method: "epic.listCloudChats",
    params,
    options: {
      enabled:
        args.enabled && args.taskId.length > 0 && viewerUserId.length > 0,
      staleTime: 30_000,
      // An older host answers `E_HOST_UNSUPPORTED` immediately and will keep
      // doing so; retrying only delays the moment the surface can hide itself.
      retry: (failureCount, error) =>
        error.code !== "E_HOST_UNSUPPORTED" && failureCount < 2,
    },
  });
}

/**
 * Whether a cloud-chat list has ANSWERED - including the answer "nothing is
 * going to ask".
 *
 * Two surfaces make a decision that is only sound once this list is in hand: the
 * canvas's record-liveness sweep (an in-flight list reads every cloud row as
 * absent, so it would reap exactly the never-adopted chats the exemption exists
 * for) and the sidebar's "No agents yet." state (a task whose only agents are
 * remote is not empty). Both derived it locally and both got it wrong in a
 * different direction, which is why the predicate lives here, beside the query it
 * describes.
 *
 * `isSuccess || isError` alone is NOT it: this query disables itself when there
 * is no client or no resolved viewer, and a disabled query never reaches either
 * flag - so a consumer gating on them waits forever for a response nobody will
 * send. A query that will not run has given its final answer.
 */
export function isCloudChatListSettled(
  query: Pick<
    UseQueryResult<unknown, HostRpcError>,
    "isEnabled" | "isSuccess" | "isError"
  >,
): boolean {
  return !query.isEnabled || query.isSuccess || query.isError;
}

/**
 * Whether the cloud-chat list's answer can authorize DESTROYING things -
 * specifically the canvas's record-liveness sweep, which closes tabs it
 * cannot prove alive and is not undone by a later, better answer.
 *
 * Stricter than {@link isCloudChatListSettled} in exactly one arm: a FAILED
 * list is a settled answer but not an authorizing one. A transient transport
 * failure that exhausted its retries has produced no evidence about any chat,
 * and treating its `data === undefined` as "no cloud rows" is what would reap
 * every restored same-host record-less tab the exemption exists to keep. The
 * one error that does authorize is `E_HOST_UNSUPPORTED`: an older host will
 * keep answering it forever, there are no cloud rows to consult through it,
 * and record policing on local records alone is that host's correct
 * pre-cloud-list behavior. A disabled query authorizes for the same reason it
 * settles - nothing will ever answer, and the sweep cannot wait forever.
 */
export function cloudChatListAuthorizesRecordSweep(
  query: Pick<
    UseQueryResult<unknown, HostRpcError>,
    "isEnabled" | "isSuccess" | "isError" | "error"
  >,
): boolean {
  if (!query.isEnabled || query.isSuccess) return true;
  return query.isError && query.error?.code === "E_HOST_UNSUPPORTED";
}

export interface UseCloudChatReadArgs {
  readonly client: HostClient<HostRpcRegistry> | null;
  /**
   * The full identity TRIPLE, or `null` to disable. `chatId` alone is NOT an
   * identity - it is host-minted and two hosts can produce the same one under a
   * task - so this hook takes nothing narrower.
   */
  readonly identity: CloudChatIdentity | null;
  readonly enabled: boolean;
}

/**
 * One published chat: resolved, gated, fetched, verified and assembled.
 *
 * ## Why this is a bare `useQuery` rather than `useHostQuery`
 *
 * `useHostQuery` models ONE method with ONE params object, which is the right
 * shape for every other host read. This is a pipeline: one `resolveHead`, then
 * a fan-out of `readCloudChatPart` whose size and membership are decided by a
 * document that arrives mid-flight. There is no single method to name, and
 * pretending otherwise would put a key on the cache that describes a request
 * nobody makes. Host scoping, the viewer component, and the null-client gate are
 * all still here - they are just spelled out instead of inherited.
 *
 * ## The interesting outcomes are DATA
 *
 * `unpublished`, `needs-newer-app`, `ambiguous-identity` and `corrupt` are
 * success values, because each has a different remedy and none of them is a
 * transport failure. Only a genuine RPC failure lands in `query.error`, which is
 * what keeps a chat that is one reconnect away from readable out of the cache as
 * a permanent refusal.
 *
 * ## One read per OPEN, and none within one
 *
 * These two options are a pair and neither works alone.
 *
 * `staleTime: Infinity` is what makes an open dialog a point-in-time copy:
 * swapping the transcript under a reader mid-scroll would be worse than showing
 * them the copy they opened, so nothing refetches while an observer is mounted.
 *
 * `gcTime: 0` is what makes "picked up by reopening" true rather than merely
 * intended. The dialog's body unmounts when it closes, so this query loses its
 * last observer and is dropped immediately; the next open finds no entry and
 * resolves the head again. WITHOUT it, `staleTime: Infinity` answers every
 * reopen out of memory - the reader opens H1, the owning device publishes H2,
 * and the reopen renders H1 having made zero requests. The incremental-read
 * property then holds in the pipeline and is unreachable from the surface built
 * for it, which is exactly the shape the mounted reopen test pins.
 *
 * Chosen over invalidating on the dialog's open transition because it needs no
 * caller to remember: any surface that mounts this hook gets one read per mount
 * lifecycle by construction. It also avoids the double fetch an on-mount
 * invalidation causes on a COLD open, and the stale-then-fresh flash a
 * post-render invalidation causes on a warm one.
 *
 * Dropping the assembled chat costs nothing to re-derive but the head: the
 * PARTS are content-addressed and live in a store this query does not own, so a
 * reopen after one turn fetches a head and one shard. That is measured as a
 * request count in `cloud-chat-dialog-reopen.test.tsx`, not inferred.
 */
export function useCloudChatRead(
  args: UseCloudChatReadArgs,
): UseQueryResult<CloudChatRead, HostRpcError> {
  const viewerUserId = useCloudChatViewerId();
  const { client, identity } = args;
  const hostId = client?.getActiveHostId() ?? null;

  // A named function rather than an inline arrow, matching `useHostQuery`'s own
  // construction: the whole point of this hook is that the read is a PIPELINE
  // over two methods, so its inputs cannot all be key components.
  const run = async (): Promise<CloudChatRead> => {
    if (client === null || identity === null) {
      throw new Error("Cloud chat read ran without a client or an identity");
    }
    try {
      return await readCloudChat({
        identity,
        port: createHostCloudChatReadPort(client),
        // Resolved per read, not captured at module load: sign-out DROPS the
        // store (an already-opened `Cache` handle survives its own deletion, and
        // the no-Cache-API fallback is not in `CacheStorage` at all), so a
        // module-level binding would go on serving the previous account's bytes.
        cache: activeChatPartCache(),
        sha256Hex: webCryptoSha256Hex,
      });
    } catch (error) {
      // The pipeline lets transport failures propagate unchanged so the two can
      // be told apart; this is where the renderer's error channel gets the
      // typed shape it declares.
      //
      // A genuine RPC failure arrives ALREADY typed and carrying its own
      // method, and `toHostRpcError` returns it untouched - so the label below
      // never mislabels a wire failure. It applies only to the residue: a bug
      // in the reader, or bytes that would not decode. Naming the pipeline's
      // first call is the closest honest answer for those, since by then
      // nothing knows which of the fan-out threw.
      throw toHostRpcError(error, "epic.resolveCloudChatHead");
    }
  };

  return useQuery<CloudChatRead, HostRpcError>(
    queryOptions<CloudChatRead, HostRpcError>({
      queryKey: cloudChatQueryKeys.read(
        hostId,
        viewerUserId,
        identity ?? { taskId: "", chatId: "", ownerUserId: "" },
      ),
      queryFn: run,
      enabled:
        args.enabled &&
        client !== null &&
        identity !== null &&
        viewerUserId.length > 0,
      staleTime: Infinity,
      // See the note above: this is the half that makes a reopen a new read.
      gcTime: 0,
      retry: (failureCount, error) =>
        error.code !== "E_HOST_UNSUPPORTED" && failureCount < 2,
    }),
  );
}

/**
 * Which of a chat's payloads this reader may fetch.
 *
 * Runs ALONGSIDE the read rather than after it, because the answer is needed
 * before presentation: the presenter's payload resolver is synchronous, so the
 * fetchable set has to be in hand while the transcript is built. Waiting for the
 * read would serialize two round trips for no gain - both need only the
 * identity.
 *
 * `staleTime: 0`, unlike the read beside it, and the asymmetry is the
 * publisher's ordering rather than a preference: the head is committed FIRST and
 * the heavy content follows, so a reader arriving inside that window gets a
 * truthful empty-or-partial list for a chat that never changes again. Cached
 * forever, that honest "not yet" would become a permanent one.
 *
 * Not retried, unlike its siblings: the transcript WAITS on this answer, so a
 * retry window is time the reader spends on a skeleton for a chat that is
 * already fully downloaded. Failing fast degrades to the markers this surface
 * rendered before the channel existed.
 *
 * ## The short list heals on REOPEN, and on nothing else
 *
 * What `staleTime: 0` buys is exactly one thing: the next mount of this key
 * refetches rather than being served the short answer. It is not a heal for a
 * reader already sitting on the transcript. The app's QueryClient sets
 * `refetchOnWindowFocus: false` and `refetchOnReconnect: false` and this query
 * does not opt out, so nothing fires while a mounted reader stays put - a
 * payload that lands seconds after the head keeps its "stored on the
 * originating device" marker until the surface is reopened or the key is
 * explicitly invalidated.
 *
 * A bounded self-poll was evaluated to close that and REJECTED. All four
 * reasons are structural rather than matters of taste, so they are written
 * here instead of being rediscovered:
 *
 * 1. **There is no caller-owned interval to set.** `useHostQuery` omits
 *    `refetchInterval` from its options type on purpose - cadence belongs to
 *    `HOST_METHOD_POLL_TABLE`, where a `condition` policy classifies from THIS
 *    method's response alone. Nothing in a `ListCloudChatPayloadsResponse`
 *    says whether it is short, so the condition cannot be written where the
 *    conditions live.
 * 2. **The only predicate that can say "short" cannot say "not yet".** That
 *    predicate is "wanted is not a subset of available": the refs the
 *    assembled chat names, tested against this list through
 *    `resolverFromPayloadRefs` - which is precisely the
 *    `fidelity.missingPayloads > 0` the transcript already computes
 *    downstream. It is equally true in the ordinary STEADY state: content that
 *    only ever lived on the originating device, a payload the publisher
 *    skipped as too large or could not read, a chat published by a host that
 *    predates payload upload entirely. A poll gated on it would spend its
 *    whole window on chats that can never converge.
 * 3. **The obvious discriminator does not discriminate.** "The head was
 *    committed seconds ago", read off the summary's `publishedAt`, excludes
 *    the archived chats nobody is reading and admits every chat somebody IS
 *    reading: a live chat recommits its head each turn, so its `publishedAt`
 *    is always fresh. It also compares a server-stamped timestamp against a
 *    browser clock, which fails silently, in both directions, under skew.
 * 4. **The bound would have to encode the publisher's internals.** How long
 *    "not yet" lasts is the owning host's blob retry ladder and its park
 *    interval - numbers this client does not know, must not copy, and cannot
 *    observe.
 *
 * ## What the host would have to emit instead
 *
 * The fix belongs where the fact already is. The publisher settles each blob
 * pass on a count of what it still OWES and parks the chat when it gives up,
 * so "more payloads are coming" is a fact it holds precisely. It has to travel
 * on the cloud ROW, because a reader is generally on a different device than
 * the owning host: `epic.chatBackupStatus` cannot stand in, it is a local read
 * that answers about the host being asked.
 *
 * So: the publisher records its payload debt on the chat row, and this list
 * answers with it. Adding a key to an existing unary response is breaking for
 * an older client even when nullable - the same rule that kept this answer off
 * the head resolve in the first place - so that is a new major of
 * `epic.listCloudChatPayloads` with a bridge, or a new optional method name.
 * Either way an older host degrades to exactly today's behavior.
 *
 * The client side then costs one table entry and nothing in this hook:
 * `defineConditionPolicy("epic.listCloudChatPayloads", ...)`, returning a lane
 * while the outcome reports debt and `false` once it does not. The episode
 * coordinator already supplies everything a hand-rolled interval would have
 * had to invent - backoff between an initial and a maximum delay, an episode
 * that ends when the condition clears, stop-on-unmount and stop-when-disabled
 * off observer activity, and a reset on host/auth transitions - and a parked
 * or unpublishable payload reports NO debt, so the poll that could never
 * converge never starts. `staleTime: 0`, the viewer-scoped key and the
 * no-identity gate below are untouched by any of it (a condition policy owns
 * `retry`, which is already `false` here).
 *
 * The three facts that reading rests on - one request per mount with no
 * interval behind it, a remount that refetches, and a focus event that does
 * not - are pinned in `__tests__/cloud-chat-payload-list-healing.test.tsx`.
 */
export function useCloudChatPayloadList(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly identity: CloudChatIdentity | null;
  readonly enabled: boolean;
}): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "epic.listCloudChatPayloads">,
  HostRpcError
> {
  const viewerUserId = useCloudChatViewerId();
  const { identity } = args;
  // `identity` is frequently a fresh object per render at the call site, so the
  // params are memoized on its three fields rather than its reference -
  // otherwise every render would mint a new query key.
  const params = useMemo(
    () => ({
      taskId: identity?.taskId ?? "",
      chatId: identity?.chatId ?? "",
      ownerUserId: identity?.ownerUserId ?? "",
    }),
    [identity?.taskId, identity?.chatId, identity?.ownerUserId],
  );
  return useHostQuery<HostRpcRegistry, "epic.listCloudChatPayloads">({
    cacheKeyIdentity: [viewerUserId],
    client: args.client,
    method: "epic.listCloudChatPayloads",
    params,
    options: {
      enabled: args.enabled && identity !== null && viewerUserId.length > 0,
      staleTime: 0,
      retry: false,
    },
  });
}

/**
 * One payload's bytes, fetched on demand and VERIFIED before anyone can render
 * them.
 *
 * `enabled` is the whole point of the on-demand part: a transcript can name many
 * payloads, and a chat with fifty file changes would otherwise spend a hundred
 * requests on content nobody looked at.
 *
 * ## Why the decode lives in the queryFn
 *
 * Returning the raw RPC response and decoding at the call site is what the
 * first version did, and it put UNVERIFIED bytes in a component's hands - the
 * dialog held the ref, dropped it, and rendered whatever came back under it.
 * Fetching and verifying as ONE operation removes the opportunity: nothing
 * downstream of this hook can obtain payload bytes that have not been hashed
 * against the address they were requested by. That is the same shape the shard
 * path already has, where `assembleChat` owns fetch-and-verify together.
 *
 * A bare `useQuery` rather than `useHostQuery` for that reason alone - the
 * latter's job is to return a method's response, and the response is precisely
 * what must not escape.
 *
 * `staleTime: Infinity` is safe here in a way it rarely is: a payload is
 * content-addressed, so the ref in the key names immutable bytes. `gcTime` is
 * left at its default, unlike the head read - there is no newer version of
 * these bytes to discover, which is the whole difference between an address and
 * a pointer.
 */
export function useCloudChatPayload(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly identity: CloudChatIdentity | null;
  readonly ref: { readonly kind: string; readonly sha256: string } | null;
  readonly enabled: boolean;
}): UseQueryResult<CloudChatPayloadBytes, HostRpcError> {
  const viewerUserId = useCloudChatViewerId();
  const { client, identity, ref } = args;
  const hostId = client?.getActiveHostId() ?? null;

  const run = async (): Promise<CloudChatPayloadBytes> => {
    if (client === null || identity === null || ref === null) {
      throw new Error("Cloud chat payload read ran without its inputs");
    }
    // Same normalization boundary as `useCloudChatRead`: the decode's own
    // rejections (a digest mismatch, `crypto.subtle` unavailable) are plain
    // Errors, and this query's declared error type - which the `retry`
    // predicate below reads `.code` off - is `HostRpcError`. An RPC failure
    // arrives already typed and passes through untouched.
    try {
      const response = await client.request("epic.readCloudChatPayload", {
        ...identity,
        ref: { kind: ref.kind, sha256: ref.sha256 },
      });
      return await decodeCloudChatPayload(response, ref, webCryptoSha256Hex);
    } catch (error) {
      throw toHostRpcError(error, "epic.readCloudChatPayload");
    }
  };

  return useQuery<CloudChatPayloadBytes, HostRpcError>(
    queryOptions<CloudChatPayloadBytes, HostRpcError>({
      queryKey: cloudChatQueryKeys.payload(
        hostId,
        viewerUserId,
        identity ?? { taskId: "", chatId: "", ownerUserId: "" },
        ref ?? { kind: "", sha256: "" },
      ),
      queryFn: run,
      enabled:
        args.enabled &&
        client !== null &&
        identity !== null &&
        ref !== null &&
        viewerUserId.length > 0,
      staleTime: Infinity,
      retry: (failureCount, error) =>
        error.code !== "E_HOST_UNSUPPORTED" && failureCount < 2,
    }),
  );
}
