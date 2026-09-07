import { useMemo } from "react";
import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  isTransientHostRpcFailure,
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

// Viewer-scoped ACL reads; disable with no viewer. No toasts - consumers are inline surfaces.

/** Empty string when unsigned; callers disable rather than send an unattributed read. */
export function useCloudChatViewerId(): string {
  return useAuthStore((state) => state.contextMetadata?.userId ?? "");
}

export interface UseCloudChatListArgs {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly taskId: string;
  readonly enabled: boolean;
}

/** Task-visible chats plus the viewer's private ones. No success cadence; retry only transient transport failures. */
export function useCloudChatList(
  args: UseCloudChatListArgs,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "epic.listCloudChats">,
  HostRpcError
> {
  const viewerUserId = useCloudChatViewerId();
  const params = useMemo(() => ({ taskId: args.taskId }), [args.taskId]);
  return useHostQuery<HostRpcRegistry, "epic.listCloudChats">({
    cacheKeyIdentity: cloudChatListCacheKeyIdentity(viewerUserId),
    client: args.client,
    method: "epic.listCloudChats",
    params,
    options: {
      enabled:
        args.enabled && args.taskId.length > 0 && viewerUserId.length > 0,
      staleTime: 30_000,
      retry: (_failureCount, error) => isTransientHostRpcFailure(error),
    },
  });
}

/** Settled includes disabled: a query that will not run has given its final answer. */
export function isCloudChatListSettled(
  query: Pick<
    UseQueryResult<unknown, HostRpcError>,
    "isEnabled" | "isSuccess" | "isError"
  >,
): boolean {
  return !query.isEnabled || query.isSuccess || query.isError;
}

/** Failed lists do not authorize a record sweep. E_HOST_UNSUPPORTED does: that host has no cloud rows. */
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
  /** Full identity triple, or null to disable. chatId is host-minted and not unique across hosts. */
  readonly identity: CloudChatIdentity | null;
  readonly enabled: boolean;
}

/** One read per mount (`staleTime: Infinity`, `gcTime: 0`). unpublished / needs-newer-app / ambiguous-identity / corrupt are success values, not errors. */
export function useCloudChatRead(
  args: UseCloudChatReadArgs,
): UseQueryResult<CloudChatRead, HostRpcError> {
  const viewerUserId = useCloudChatViewerId();
  const { client, identity } = args;
  const hostId = client?.getActiveHostId() ?? null;

  const run = async (): Promise<CloudChatRead> => {
    if (client === null || identity === null) {
      throw new Error("Cloud chat read ran without a client or an identity");
    }
    try {
      return await readCloudChat({
        identity,
        port: createHostCloudChatReadPort(client),
        // Per-read: sign-out drops the store; a module-level handle would serve the previous account.
        cache: activeChatPartCache(),
        sha256Hex: webCryptoSha256Hex,
      });
    } catch (error) {
      // Genuine RPC failures stay typed. Label only decode/reader residue with the pipeline's first method.
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
      gcTime: 0,
      retry: (failureCount, error) =>
        error.code !== "E_HOST_UNSUPPORTED" && failureCount < 2,
    }),
  );
}

/** Fetch alongside the read. staleTime 0 so a short "not yet" list does not stick. No retry: the transcript waits on this. Heal on remount only. */
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
  // Identity is often a new object per render; key on the three fields.
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

/** Fetch and verify in queryFn so unverified bytes never escape. Content-addressed: staleTime Infinity is safe. */
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
