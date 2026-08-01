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
import { readCloudChat, type CloudChatRead } from "@traycer-clients/shared/cloud-chat/cloud-chat-reader";
import { webCryptoSha256Hex } from "@traycer-clients/shared/cloud-chat/bytes";
import type { CloudChatIdentity } from "@traycer/protocol/host/epic/cloud-chat";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { createHostCloudChatReadPort } from "@/lib/chats/cloud-chat-read-port";
import { resolveChatPartCache } from "@/lib/chats/cloud-chat-part-cache";
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

/** The store every read in this renderer shares. Immutable entries, so one is enough. */
const partCache = resolveChatPartCache(
  typeof globalThis.caches === "undefined" ? undefined : globalThis.caches,
);

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
    cacheKeyIdentity: [viewerUserId],
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
 * `staleTime: Infinity`: a read is a point-in-time copy at publication
 * freshness. Swapping the transcript under a reader mid-scroll would be worse
 * than showing the copy they opened; a newer head is picked up by reopening.
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
        cache: partCache,
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
 * One payload's bytes, fetched on demand.
 *
 * `enabled` is the whole point: a transcript can name many payloads and this
 * fetches exactly the one a reader asked to see. `staleTime: Infinity` is safe
 * here in a way it rarely is - a payload is content-addressed, so the ref in the
 * key names immutable bytes.
 *
 * `unavailable` and `ambiguous-identity` arrive as SUCCESS values and become
 * markers; only a genuine transport failure lands in `query.error`.
 */
export function useCloudChatPayload(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly identity: CloudChatIdentity | null;
  readonly ref: { readonly kind: string; readonly sha256: string } | null;
  readonly enabled: boolean;
}): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "epic.readCloudChatPayload">,
  HostRpcError
> {
  const viewerUserId = useCloudChatViewerId();
  const { identity, ref } = args;
  const params = useMemo(
    () => ({
      taskId: identity?.taskId ?? "",
      chatId: identity?.chatId ?? "",
      ownerUserId: identity?.ownerUserId ?? "",
      ref: { kind: ref?.kind ?? "", sha256: ref?.sha256 ?? "" },
    }),
    [
      identity?.taskId,
      identity?.chatId,
      identity?.ownerUserId,
      ref?.kind,
      ref?.sha256,
    ],
  );
  return useHostQuery<HostRpcRegistry, "epic.readCloudChatPayload">({
    cacheKeyIdentity: [viewerUserId],
    client: args.client,
    method: "epic.readCloudChatPayload",
    params,
    options: {
      enabled:
        args.enabled &&
        identity !== null &&
        ref !== null &&
        viewerUserId.length > 0,
      staleTime: Infinity,
      retry: (failureCount, error) =>
        error.code !== "E_HOST_UNSUPPORTED" && failureCount < 2,
    },
  });
}
