import {
  QueryClient,
  useQueryClient,
  type UseMutationOptions,
  type UseMutationResult,
} from "@tanstack/react-query";
import type {
  CreateChatRequest,
  CreateChatResponse,
  DeleteChatRequest,
  DeleteChatResponse,
  UpdateChatProfileRequest,
  UpdateChatProfileResponse,
  UpdateChatRunSettingsRequest,
  UpdateChatRunSettingsResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useHostClient } from "@/lib/host/runtime";
import { hostQueryKeys, epicMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";

/**
 * Variables for `useEpicCreateChat.mutate`/`mutateAsync`. `hostId` is
 * stamped by the hook from the active host - callers never pass it
 * explicitly. Centralizing the projection here means there is exactly
 * one place that resolves "which host owns this new chat" and exactly
 * one place that fails loudly when no host is active.
 */
export type CreateChatMutationInput = Omit<CreateChatRequest, "hostId">;
interface CreateChatMutationContext {
  readonly hostId: string | null;
}

export type DeleteChatMutationOptions = Omit<
  UseMutationOptions<DeleteChatResponse, HostRpcError, DeleteChatRequest>,
  "mutationFn"
>;

/**
 * Mutation hook for epic.createChat.
 *
 * Owns the per-tab host binding rule (`chatSchema.hostId` is required)
 * by stamping `hostId` from `useReactiveActiveHostId()` in the request
 * mapper. If no host is active at mutate time, the mutation rejects
 * through the mutation error channel with a `HostRpcError` so the failure
 * surfaces through `onError` (and `toastFromHostError`) instead of
 * silently dropping the action at the call site.
 *
 * Uses `useHostMutation` with a request mapper so the host RPC path stays
 * centralized while callers still pass host-agnostic chat inputs.
 */
export function useEpicCreateChat(): UseMutationResult<
  CreateChatResponse,
  HostRpcError,
  CreateChatMutationInput,
  CreateChatMutationContext
> {
  const client = useHostClient();
  const activeHostId = useReactiveActiveHostId();
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "epic.createChat",
    CreateChatMutationContext,
    CreateChatMutationInput
  >({
    client,
    method: "epic.createChat",
    mapVariables: (params) => {
      if (activeHostId === null) {
        throw new HostRpcError({
          code: "RPC_ERROR",
          message:
            "No active host - connect to a host before creating an agent.",
          requestId: "client-pre-flight",
          method: "epic.createChat",
          fatalDetails: null,
        });
      }
      return {
        ...params,
        hostId: activeHostId,
      };
    },
    options: {
      onMutate: () => ({ hostId: activeHostId }),
      onSuccess: (_data, _params, ctx) => {
        invalidateBindingsForEpic(queryClient, ctx.hostId);
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't create agent.");
      },
    },
  });
}

export function useEpicCreateChatForHost(): UseMutationResult<
  CreateChatResponse,
  HostRpcError,
  CreateChatMutationInput,
  CreateChatMutationContext
> {
  const client = useTabHostClient();
  return useEpicCreateChatForHostClient(client);
}

/**
 * Host-parametric variant of {@link useEpicCreateChat}: the caller resolves
 * an explicit `HostClient` (e.g. via `useHostClientFor` for a sidebar
 * row's OWN host) and the hook stamps that client's host id onto the new
 * chat, rather than the app-wide active host. `null` client (offline /
 * directory unresolved) rejects through the mutation error channel so the
 * caller can disable the affordance - `useHostMutation`'s own `client ===
 * null` guard covers that case; only the second-stage "client resolved but
 * host identity unset" check lives in `mapVariables` here (also normalized
 * to `HostRpcError` by `useHostMutation`'s boundary). `useEpicCreateChatForHost`
 * is the tab-scoped wrapper over this; row child-create passes the row's
 * host client.
 */
export function useEpicCreateChatForHostClient(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  CreateChatResponse,
  HostRpcError,
  CreateChatMutationInput,
  CreateChatMutationContext
> {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "epic.createChat",
    CreateChatMutationContext,
    CreateChatMutationInput
  >({
    client,
    method: "epic.createChat",
    mapVariables: (params) => {
      const hostId = client?.getActiveHostId() ?? null;
      if (hostId === null) {
        throw new HostRpcError({
          code: "RPC_ERROR",
          message: "Tab host identity unavailable - cannot stamp hostId.",
          requestId: "client-pre-flight",
          method: "epic.createChat",
          fatalDetails: null,
        });
      }
      return { ...params, hostId };
    },
    options: {
      mutationKey: epicMutationKeys.createChat(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: (_data, _params, ctx) => {
        invalidateBindingsForEpic(queryClient, ctx.hostId);
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't create agent.");
      },
    },
  });
}

function invalidateBindingsForEpic(
  queryClient: QueryClient,
  hostId: string | null,
): void {
  if (hostId === null) return;
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(hostId, "worktree.listBindingsForEpic"),
  });
}

/**
 * Mutation hook for `epic.updateChatRunSettings` (optional host capability).
 *
 * Persists a chat's run settings without sending a message, so the durable
 * per-chat profile a headless turn (e.g. an incoming agent-to-agent message)
 * runs on tracks the composer's selection immediately instead of at the next
 * send. Tab-host scoped: chat settings belong to the chat's bound host.
 *
 * Intentionally has no `onError` toast: callers are fire-and-forget syncs or
 * bulk switches that decide themselves how to surface failures. Against an
 * old host the call fails with `E_HOST_UNSUPPORTED` (declared degrade), which
 * callers treat as "legacy behavior: settings persist on next send".
 */
export function useEpicUpdateChatRunSettings(): UseMutationResult<
  UpdateChatRunSettingsResponse,
  HostRpcError,
  UpdateChatRunSettingsRequest
> {
  const client = useTabHostClient();
  return useHostMutation<
    HostRpcRegistry,
    "epic.updateChatRunSettings",
    unknown,
    UpdateChatRunSettingsRequest
  >({
    client,
    method: "epic.updateChatRunSettings",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: epicMutationKeys.updateChatRunSettings(),
    },
  });
}

/**
 * Mutation hook for `epic.updateChatProfile` (optional host capability).
 *
 * Narrow profile-only settings update: moves a chat onto another logged-in
 * profile of its current harness WITHOUT rebuilding the full tuple
 * client-side - the host patches its own authoritative persisted record, so
 * a possibly-stale projection can never be re-persisted just to move the
 * profile. Tab-host scoped, like `useEpicUpdateChatRunSettings` above, and
 * likewise fire-and-forget: against an old host the call fails with
 * `E_HOST_UNSUPPORTED` and callers degrade to persist-on-next-send.
 */
export function useEpicUpdateChatProfile(): UseMutationResult<
  UpdateChatProfileResponse,
  HostRpcError,
  UpdateChatProfileRequest
> {
  const client = useTabHostClient();
  return useHostMutation<
    HostRpcRegistry,
    "epic.updateChatProfile",
    unknown,
    UpdateChatProfileRequest
  >({
    client,
    method: "epic.updateChatProfile",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: epicMutationKeys.updateChatProfile(),
    },
  });
}

/**
 * Mutation hook for epic.renameChat.
 * Input enters pending (read-only) state; success is silent.
 */
export function useEpicRenameChat() {
  const client = useHostClient();
  return useHostMutation({
    client,
    method: "epic.renameChat",
    mapVariables: (variables) => variables,
    options: {
      onError: (error) => {
        toastFromHostError(error, "Couldn't rename agent.");
      },
    },
  });
}

/**
 * Mutation hook for epic.deleteChat.
 * Caller opens a confirm dialog first; on Delete the button enters
 * pending state; success is silent.
 */
export function useEpicDeleteChat() {
  const client = useHostClient();
  return useHostMutation({
    client,
    method: "epic.deleteChat",
    mapVariables: (variables) => variables,
    options: {
      onSuccess: (_data, variables) => {
        getChatSessionRegistry().forceRelease(
          variables.epicId,
          variables.chatId,
        );
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't delete agent.");
      },
    },
  });
}
