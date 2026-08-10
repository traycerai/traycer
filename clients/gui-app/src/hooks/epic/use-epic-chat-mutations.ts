import {
  QueryClient,
  useMutation,
  useQueryClient,
  type UseMutationOptions,
  type UseMutationResult,
} from "@tanstack/react-query";
import type {
  CreateChatRequestV11,
  CreateChatResponse,
  DeleteChatRequest,
  DeleteChatResponse,
  SetChatArchivedRequest,
  SetChatArchivedResponse,
  UpdateChatProfileRequest,
  UpdateChatProfileResponse,
  UpdateChatRunSettingsRequest,
  UpdateChatRunSettingsResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  classifyHostRequestFailure,
  HostRpcError,
  toHostRpcError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useHostClient } from "@/lib/host/runtime";
import { hostQueryKeys, epicMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import { evictChatTabPersistenceForChat } from "@/stores/chats/chat-tab-persistence-eviction";

/**
 * Variables for `useEpicCreateChat.mutate`/`mutateAsync`. `hostId` is
 * stamped by the hook from the active host - callers never pass it
 * explicitly. Centralizing the projection here means there is exactly
 * one place that resolves "which host owns this new chat" and exactly
 * one place that fails loudly when no host is active.
 */
export type CreateChatMutationInput = Omit<CreateChatRequestV11, "hostId">;
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
      onError: (error, variables) => {
        if (isRecoverableLatestForkFailure(error, variables)) return;
        toastFromHostError(error, "Couldn't create agent.");
      },
    },
  });
}

/**
 * Whether `error` is one of the two failures `cloneChatOnHostSwitch` (ticket
 * 34B1) recovers from by design - a settings-only retry is already in
 * flight by the time this fires, so a generic "Couldn't create agent."
 * toast here would tell the user their clone failed on the exact request
 * that is about to quietly succeed without history.
 *
 * Scoped to `forkSource.boundary === "latest"` specifically, not "any
 * `forkSource`": both failure codes are otherwise reachable in principle
 * (`E_FORK_CHECKPOINT_UNAVAILABLE` is currently only ever produced by a
 * `"latest"` request, but `DOWNGRADE_UNSUPPORTED` is a general transport
 * code), and the manual fork dialog's precise-boundary requests do NOT
 * recover from either - they must still toast on failure like every other
 * caller of this hook.
 */
function isRecoverableLatestForkFailure(
  error: HostRpcError,
  variables: CreateChatMutationInput,
): boolean {
  if (variables.forkSource?.boundary !== "latest") return false;
  return (
    error.code === "E_FORK_CHECKPOINT_UNAVAILABLE" ||
    classifyHostRequestFailure(error).kind === "downgrade-unsupported"
  );
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
 * Mutation hook for `epic.setChatArchived` (optional host capability).
 *
 * Sets or clears the record's `archivedAt`, which the sidebar reads to hide a
 * row and its subtree. ONE hook covers chats and terminal-agents: the protocol
 * registers a single method keyed by record id and the host resolves it across
 * both the `chats` and `tuiAgents` maps, so a separate TUI variant would be the
 * same call with the same arguments under a second name.
 *
 * Scoped to the surrounding Epic session's owning host. The sidebar is outside
 * every tile-level `TabHostProvider`, so archive writes must follow the Epic
 * stream that projected these rows instead of borrowing an individual tile's
 * lifetime-bound host.
 *
 * No optimistic write and no cache invalidation, also matching rename: the
 * archive flag lives in the epic Y.Doc, so the host's write replicates back
 * through the epic stream and re-projects the tree on its own. There is no
 * TanStack-cached query derived from `archivedAt` to invalidate.
 *
 * `{ updated: false }` is success, not failure - it means the record was
 * already in the requested state (the RPC is idempotent). Callers must not
 * read it as "record gone".
 */
export function useEpicArchiveChat(): UseMutationResult<
  SetChatArchivedResponse,
  HostRpcError,
  SetChatArchivedRequest
> {
  return useEpicArchiveChatMutation("individual");
}

function useEpicArchiveChatMutation(
  failurePresentation: "individual" | "aggregate",
): UseMutationResult<
  SetChatArchivedResponse,
  HostRpcError,
  SetChatArchivedRequest
> {
  const client = useEpicSessionHostClient();
  return useHostMutation<
    HostRpcRegistry,
    "epic.setChatArchived",
    unknown,
    SetChatArchivedRequest
  >({
    client,
    method: "epic.setChatArchived",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: epicMutationKeys.setChatArchived(),
      onError:
        failurePresentation === "individual"
          ? (error) => {
              // EVERY failure mode gets the same generic toast, including
              // `E_HOST_UNSUPPORTED`. The renderer cannot discriminate them
              // anyway: the wire error envelope is `{ code, message }` only -
              // there is no status field on `HostRpcError` - and the specific
              // reason travels in the message, which must not be parsed.
              //
              // Archive is USER-INITIATED, so it follows the foreground
              // convention (`toastFromHostError`) rather than the background
              // one (`toastFromBackgroundHostError`, the only helper that
              // swallows `E_HOST_UNSUPPORTED` - it exists for work nobody asked
              // for, where there is no one to inform). Someone clicked this
              // control and expects an outcome; staying silent would read as a
              // broken button.
              //
              // The capability gate keeps this path cold: the affordance is
              // hidden unless that host advertised the method, so reaching it
              // means the host changed under a live session - an anomaly worth
              // surfacing. A missing record likewise surfaces as an ordinary
              // failure, which is right since the row is about to leave the
              // tree.
              toastFromHostError(error, "Couldn't archive agent.");
            }
          : undefined,
    },
  });
}

export interface ArchiveChatsMutationInput {
  readonly epicId: string;
  readonly chatIds: readonly string[];
  readonly archived: boolean;
}

export type ArchiveChatsMutationResult =
  readonly PromiseSettledResult<SetChatArchivedResponse>[];

/**
 * Query-owned lifecycle for a user-initiated archive batch.
 *
 * Each record still travels through the archive host mutation, preserving the
 * RPC gate. This aggregate mutation owns pending state and failure
 * presentation, and returns every outcome so the caller can reconcile
 * successful selections without discarding failures.
 */
export function useEpicArchiveChats(): UseMutationResult<
  ArchiveChatsMutationResult,
  Error,
  ArchiveChatsMutationInput
> {
  const archiveChat = useEpicArchiveChatMutation("aggregate");
  return useMutation<
    ArchiveChatsMutationResult,
    Error,
    ArchiveChatsMutationInput
  >({
    mutationKey: epicMutationKeys.archiveChats(),
    mutationFn: (variables) =>
      Promise.allSettled(
        variables.chatIds.map((chatId) =>
          archiveChat.mutateAsync({
            epicId: variables.epicId,
            chatId,
            archived: variables.archived,
          }),
        ),
      ),
    onSuccess: (results) => {
      const firstFailure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (firstFailure === undefined) return;
      const reason: unknown = firstFailure.reason;
      toastFromHostError(
        toHostRpcError(reason, "epic.setChatArchived"),
        "Couldn't archive some selected agents.",
      );
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
        // Ticket 15 (decision #29): a deleted chat can never be reopened -
        // drop its durable chat-key entries across all seven per-tab
        // registries (the tab-key side, if this chat happened to be open,
        // is already handled by the canvas store's close sweep when the
        // caller closes the tile ahead of this mutation).
        evictChatTabPersistenceForChat({
          epicId: variables.epicId,
          chatId: variables.chatId,
        });
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't delete agent.");
      },
    },
  });
}
