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
  HostRpcError,
  toHostRpcError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useHostBinding } from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { hostQueryKeys, epicMutationKeys } from "@/lib/query-keys";
import {
  toastFromHostError,
  toastFromHostErrorWithDetail,
} from "@/lib/host-error-toast";
import { invalidateEpicChatRecords } from "@/hooks/chats/use-epic-chat-records";
import { invalidateChatRunSettings } from "@/hooks/chats/use-chat-run-settings-query";
import { invalidateEpicTuiAgentRecords } from "@/hooks/chats/use-epic-tui-agent-records";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import {
  beginPendingChatCreation,
  clearPendingChatCreation,
} from "@/lib/chats/pending-chat-creations";
import { isRecoverableLatestForkRefusal } from "@/lib/chats/recoverable-fork-refusal";
import { evictChatTabPersistenceForChat } from "@/stores/chats/chat-tab-persistence-eviction";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

/** Caller names hostId; do not project the active host at mutate time. Reject if the client no longer dials that host. */
export type CreateChatMutationInput = CreateChatRequestV11;
interface CreateChatMutationContext {
  readonly hostId: string | null;
  /** Capture owner at mutate time. Reading it in onSuccess would file the chat under whoever is signed in when the answer lands. */
  readonly ownerUserId: string | null;
}

interface ChatMutationTarget {
  readonly chatId: string;
  readonly hostId: string | null;
}

export type ArchiveChatMutationInput = SetChatArchivedRequest &
  ChatMutationTarget;
export type DeleteChatMutationInput = DeleteChatRequest & ChatMutationTarget;

/** What a chat mutation has to remember to refresh the record list afterwards: the host it was actually sent to, captured at mutate time so a host swap in flight cannot redirect the invalidation at another machine's cache. */
interface ChatRecordMutationContext {
  readonly hostId: string | null;
  readonly viewerHostId: string | null;
  readonly viewerUserId: string | null;
}

export type DeleteChatMutationOptions = Omit<
  UseMutationOptions<
    DeleteChatResponse,
    HostRpcError,
    DeleteChatMutationInput,
    ChatRecordMutationContext
  >,
  "mutationFn"
>;

/** The named target is fixed even if the viewing epic changes hosts. */
function useChatMutationClient(): (
  variables: ChatMutationTarget,
) => HostClient<HostRpcRegistry> | null {
  const sessionClient = useEpicSessionHostClient();
  const binding = useHostBinding();
  return ({ hostId }) => {
    if (hostId === null) return null;
    if (sessionClient?.getActiveHostId() === hostId) return sessionClient;
    return resolveNamedHostClient(binding, hostId);
  };
}

/** Resolve viewer state independently of the mutation's fixed destination. */
function getChatMutationViewer(
  epicId: string,
  chatId: string,
  ctx: ChatRecordMutationContext,
): OpenEpicStoreHandle | null {
  if (
    ctx.viewerUserId === null ||
    ctx.viewerUserId !== currentProfileUserId()
  ) {
    return null;
  }
  const handle = getOpenEpicRegistry().peek(epicId);
  if (handle === null) return null;
  const chats = handle.store.getState().chats.byId;
  const row = chats[chatId];
  // A replacement session can mount before its first record list.
  if (
    Object.hasOwn(chats, chatId) &&
    (row.userId !== ctx.viewerUserId ||
      (row.hostId ?? handle.hostId) !== ctx.hostId)
  )
    return null;
  return handle;
}

/** E_FORK_BOUNDARY_NOT_PUBLISHED is inline, not a toast. The fork dialog stays open for retry. */
function isInlineForkRefusal(error: HostRpcError): boolean {
  return error.code === "E_FORK_BOUNDARY_NOT_PUBLISHED";
}

/** Tab-scoped wrapper over {@link useEpicCreateChatForHostClient}, sending the create on the tab's own bound host client. */
export function useEpicCreateChatForHost(): UseMutationResult<
  CreateChatResponse,
  HostRpcError,
  CreateChatMutationInput,
  CreateChatMutationContext
> {
  const client = useTabHostClient();
  return useEpicCreateChatForHostClient(client);
}

/** Send createChat on the caller-resolved client and verify it dials request.hostId. No app-wide wrapper: placement owns the client. */
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
      const clientHostId = client?.getActiveHostId() ?? null;
      if (clientHostId !== params.hostId) {
        throw new HostRpcError({
          code: "RPC_ERROR",
          message:
            clientHostId === null
              ? "Tab host identity unavailable - cannot create an agent on it."
              : "This host client no longer addresses the requested host - the agent would be created on a different host.",
          requestId: "client-pre-flight",
          method: "epic.createChat",
          fatalDetails: null,
        });
      }
      return params;
    },
    options: {
      mutationKey: epicMutationKeys.createChat(),
      onMutate: () => ({
        hostId: client?.getActiveHostId() ?? null,
        ownerUserId: currentProfileUserId(),
      }),
      onSuccess: (data, params, ctx) => {
        retainCreatedChatUntilProjected(data, params, ctx.ownerUserId);
        invalidateBindingsForEpic(queryClient, ctx.hostId);
        // The created chat lands in the host's chat database and in nothing this renderer already listens to, so without this the record list is never re-read - and every create-then-open flow (`openCreatedChatWhenProjected`, the handoff's `projectedChatId`) waits on a projection that only a poll tick can deliver.
        invalidateEpicChatRecords(queryClient, ctx.hostId);
      },
      onError: (error, variables) => {
        releaseCreatedChat(variables);
        if (isInlineForkRefusal(error)) return;
        // A step inside an operation that recovers from it, not the end of one: the clone-on-host-switch flow narrates the history downgrade itself and retries without `forkSource`, so a toast here describes an ATTEMPT moments before the clone succeeds.
        if (isRecoverableLatestForkRefusal(error, variables)) return;
        // Append host text only when no mapped copy claimed the error.
        toastFromHostErrorWithDetail(error, "Couldn't create agent.");
      },
    },
  });
}

/** Retain on success only (not mutate time): a pre-answer row would disarm the handoff for a chat that may never exist. */
function retainCreatedChatUntilProjected(
  response: CreateChatResponse,
  request: CreateChatMutationInput,
  ownerUserId: string | null,
): void {
  beginPendingChatCreation(request.epicId, {
    chatId: response.chatId,
    hostId: request.hostId,
    parentChatId: request.parentId,
    title: request.title,
    ownerUserId,
  });
}

/** The same source the open-epic store reads for its own projection identity, so a captured value and a store-side read can never disagree about who "current" means - they only ever disagree about WHEN, which is the entire point of capturing it. */
function currentProfileUserId(): string | null {
  return useAuthStore.getState().profile?.userId ?? null;
}

/** Runs for EVERY failure, including the ones this hook deliberately does not toast (the clone flow's recoverable fork refusals, which retry under a fresh chat id). */
function releaseCreatedChat(request: CreateChatMutationInput): void {
  clearPendingChatCreation(request.epicId, request.chatId);
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

/** Tab-host scoped. No onError toast. E_HOST_UNSUPPORTED means persist on next send. */
export function useEpicUpdateChatRunSettings(): UseMutationResult<
  UpdateChatRunSettingsResponse,
  HostRpcError,
  UpdateChatRunSettingsRequest
> {
  const client = useTabHostClient();
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "epic.updateChatRunSettings",
    { hostId: string | null },
    UpdateChatRunSettingsRequest
  >({
    client,
    method: "epic.updateChatRunSettings",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: epicMutationKeys.updateChatRunSettings(),
      // Captured at mutate time, per the host-swap convention above.
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: (_data, _variables, ctx) => {
        // The hover card reads the tuple over `epic.getChatRunSettings`, so without this it keeps rendering the pre-change model/profile/permission mode.
        invalidateChatRunSettings(queryClient, ctx.hostId);
      },
    },
  });
}

/** Tab-host scoped. Host patches the record; do not rebuild the tuple client-side. E_HOST_UNSUPPORTED means persist on next send. */
export function useEpicUpdateChatProfile(): UseMutationResult<
  UpdateChatProfileResponse,
  HostRpcError,
  UpdateChatProfileRequest
> {
  const client = useTabHostClient();
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "epic.updateChatProfile",
    { hostId: string | null },
    UpdateChatProfileRequest
  >({
    client,
    method: "epic.updateChatProfile",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: epicMutationKeys.updateChatProfile(),
      // Same host-swap capture and the same reason as
      // `useEpicUpdateChatRunSettings` above - a profile move is a settings
      // write that reaches only the host's own record.
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: (_data, _variables, ctx) => {
        invalidateChatRunSettings(queryClient, ctx.hostId);
      },
    },
  });
}

/** Session host, never the app-wide one. Sidebar stays interactive during a re-point. */
export function useEpicRenameChat() {
  const client = useEpicSessionHostClient();
  const queryClient = useQueryClient();
  return useHostMutation({
    client,
    method: "epic.renameChat",
    mapVariables: (variables) => variables,
    options: {
      // Captured at mutate time, per the host-swap convention: a swap while the
      // rename is in flight must not invalidate a different machine's list.
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: (_data, _variables, ctx) => {
        // For a chat whose doc entry the upgrade sweep removed there is no replicated write to re-project, so without this refetch the row keeps its old title until the poll fires - a rename that reads as a no-op.
        invalidateEpicChatRecords(queryClient, ctx.hostId);
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't rename agent.");
      },
    },
  });
}

/** `updated: false` is an idempotent success, not a missing record. */
export function useEpicArchiveChat(): UseMutationResult<
  SetChatArchivedResponse,
  HostRpcError,
  ArchiveChatMutationInput
> {
  return useEpicArchiveChatMutation("individual");
}

function useEpicArchiveChatMutation(
  failurePresentation: "individual" | "aggregate",
): UseMutationResult<
  SetChatArchivedResponse,
  HostRpcError,
  ArchiveChatMutationInput
> {
  const client = useChatMutationClient();
  const sessionClient = useEpicSessionHostClient();
  const queryClient = useQueryClient();
  // An imperative post-write read: the viewer's cloud replica can lag the
  // owner's response. Reuse the record revision instead of inventing an overlay.
  const readOwnerRecords = useHostMutation<
    HostRpcRegistry,
    "epic.listChatRecords",
    unknown,
    ArchiveChatMutationInput
  >({
    client,
    method: "epic.listChatRecords",
    mapVariables: ({ epicId }) => ({ epicId, hasDocReplica: false }),
    options: null,
  });
  return useHostMutation<
    HostRpcRegistry,
    "epic.setChatArchived",
    ChatRecordMutationContext,
    ArchiveChatMutationInput
  >({
    client,
    method: "epic.setChatArchived",
    mapVariables: ({ epicId, chatId, archived }) => ({
      epicId,
      chatId,
      archived,
    }),
    options: {
      mutationKey: epicMutationKeys.setChatArchived(),
      onMutate: ({ hostId }) => ({
        hostId,
        viewerHostId: sessionClient?.getActiveHostId() ?? null,
        viewerUserId: currentProfileUserId(),
      }),
      onSuccess: async (_data, variables, ctx) => {
        const handle = getOpenEpicRegistry().peek(variables.epicId);
        // The visible session may have been replaced while the write travelled.
        for (const hostId of new Set([
          ctx.hostId,
          ctx.viewerHostId,
          handle?.hostId ?? null,
        ])) {
          invalidateEpicChatRecords(queryClient, hostId);
          invalidateEpicTuiAgentRecords(queryClient, hostId);
        }
        if (
          (ctx.hostId === ctx.viewerHostId && handle?.hostId === ctx.hostId) ||
          getChatMutationViewer(variables.epicId, variables.chatId, ctx) ===
            null
        )
          return;
        try {
          const { chats: records } =
            await readOwnerRecords.mutateAsync(variables);
          const currentHandle = getChatMutationViewer(
            variables.epicId,
            variables.chatId,
            ctx,
          );
          if (currentHandle === null) return;
          invalidateEpicChatRecords(queryClient, currentHandle.hostId);
          const record = records.find(
            (row) =>
              row.chatId === variables.chatId &&
              row.ownerUserId === ctx.viewerUserId &&
              row.originHostId === ctx.hostId &&
              row.origin === "own",
          );
          if (record === undefined) return;
          currentHandle.store.getState().applyConfirmedChatMutation({
            kind: "upsert",
            record:
              currentHandle.hostId === ctx.hostId
                ? record
                : {
                    ...record,
                    origin: "foreign",
                    archivedAt: null,
                    docResident: false,
                  },
          });
        } catch (error) {
          // The write succeeded; only its immediate display refresh failed.
          toastFromHostError(
            toHostRpcError(error, "epic.listChatRecords"),
            "Agent updated, but couldn't refresh its status.",
          );
        }
      },
      onError:
        failurePresentation === "individual"
          ? (error) => toastFromHostError(error, "Couldn't archive agent.")
          : undefined,
    },
  });
}

export interface ArchiveChatsMutationInput {
  readonly epicId: string;
  readonly chats: readonly ChatMutationTarget[];
  readonly archived: boolean;
}

export type ArchiveChatsMutationResult =
  readonly PromiseSettledResult<SetChatArchivedResponse>[];

/** This aggregate mutation owns pending state and failure presentation, and returns every outcome so the caller can reconcile successful selections without discarding failures. */
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
        variables.chats.map((chat) =>
          archiveChat.mutateAsync({
            epicId: variables.epicId,
            ...chat,
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

/** Deletes on the owning host and retires the viewer's confirmed replica. */
export function useEpicDeleteChat(): UseMutationResult<
  DeleteChatResponse,
  HostRpcError,
  DeleteChatMutationInput,
  ChatRecordMutationContext
> {
  const client = useChatMutationClient();
  const sessionClient = useEpicSessionHostClient();
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "epic.deleteChat",
    ChatRecordMutationContext,
    DeleteChatMutationInput
  >({
    client,
    method: "epic.deleteChat",
    mapVariables: ({ epicId, chatId }) => ({ epicId, chatId }),
    options: {
      // Captured at mutate time (the repo's host-swap convention) rather than re-read in `onSuccess`, so a host swap while the delete is in flight cannot make us dispose a same-id chat session belonging to a different machine.
      onMutate: ({ hostId }) => ({
        hostId,
        viewerHostId: sessionClient?.getActiveHostId() ?? null,
        viewerUserId: currentProfileUserId(),
      }),
      onSuccess: (_data, variables, ctx) => {
        // No active host at mutate time means nothing could have acquired a session under this chat's identity either, so there is nothing to force-release - and guessing a host here is exactly the cross-host dispose this teardown must not perform.
        if (ctx.hostId !== null) {
          getChatSessionRegistry().forceRelease(
            variables.epicId,
            variables.chatId,
            ctx.hostId,
          );
          // This mutation-level callback survives the optimistic sidebar row unmounting.
          useEpicCanvasStore
            .getState()
            .closeConfirmedDeletedChatTiles(
              variables.epicId,
              variables.chatId,
              ctx.hostId,
            );
        }
        // Ticket 15 (decision #29): a deleted chat can never be reopened - drop its durable chat-key entries across all seven per-tab registries (the tab-key side, if this chat happened to be open, is already handled by the canvas store's close sweep when the caller closes the tile ahead of this mutation).
        evictChatTabPersistenceForChat({
          epicId: variables.epicId,
          chatId: variables.chatId,
        });
        // Delete must retire the pending stand-in; applyChatRecords preserves absence.
        clearPendingChatCreation(variables.epicId, variables.chatId);
        // Retain the confirmed removal across stale replica polls while the
        // owning host's cloud retraction is still travelling to the viewer.
        const handle = getOpenEpicRegistry().peek(variables.epicId);
        if (
          handle !== null &&
          ctx.hostId !== null &&
          ctx.viewerUserId !== null &&
          ctx.viewerUserId === currentProfileUserId()
        ) {
          handle.store.getState().applyConfirmedChatMutation({
            kind: "remove",
            chatId: variables.chatId,
            ownerUserId: ctx.viewerUserId,
            originHostId: ctx.hostId,
          });
        }
        for (const hostId of new Set([
          ctx.hostId,
          ctx.viewerHostId,
          handle?.hostId ?? null,
        ])) {
          invalidateEpicChatRecords(queryClient, hostId);
        }
      },
      onError: (error, variables) => {
        // The optimistic sidebar row may already be unmounted, so its
        // per-call error callback is not a reliable rollback owner either.
        useEpicCanvasStore
          .getState()
          .unmarkArtifactSelfDeleted(variables.chatId);
        toastFromHostError(error, "Couldn't delete agent.");
      },
    },
  });
}
