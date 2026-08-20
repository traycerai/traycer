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
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { hostQueryKeys, epicMutationKeys } from "@/lib/query-keys";
import {
  toastFromHostError,
  toastFromHostErrorWithDetail,
} from "@/lib/host-error-toast";
import { invalidateEpicChatRecords } from "@/hooks/chats/use-epic-chat-records";
import { invalidateChatRunSettings } from "@/hooks/chats/use-chat-run-settings-query";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import {
  beginPendingChatCreation,
  clearPendingChatCreation,
} from "@/lib/chats/pending-chat-creations";
import { isRecoverableLatestForkRefusal } from "@/lib/chats/recoverable-fork-refusal";
import { evictChatTabPersistenceForChat } from "@/stores/chats/chat-tab-persistence-eviction";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

/**
 * Variables for `useEpicCreateChatForHostClient.mutate`/`mutateAsync`
 * (and its `useEpicCreateChatForHost` tab-scoped wrapper).
 *
 * `hostId` is REQUIRED and named by the caller - it is not projected from
 * whatever host happens to be active when `mutate` fires. A chat is bound to
 * its host for life, so the host is part of what the caller is asking for
 * ("create this agent on THAT machine"), and a hook-side projection let an
 * active-host change between the click and the mutate silently redirect the
 * create. Callers pass their tab's bound host, or the host they explicitly
 * chose in a picker.
 *
 * The hooks below still own the CHECK: the request travels on a client that
 * dials one specific host, so a named host that no longer matches that client
 * is rejected through the mutation error channel instead of creating the chat
 * on the wrong machine.
 */
export type CreateChatMutationInput = CreateChatRequestV11;
interface CreateChatMutationContext {
  readonly hostId: string | null;
  /**
   * The signed-in user the create was AUTHORIZED as, captured at mutate time.
   *
   * The retained stand-in is identity-bearing - `chatId` is not globally unique,
   * so the registry keys every retirement decision by owner - and the request
   * was made under whoever was signed in when it left. Reading the profile back
   * in `onSuccess` would stamp a chat created by user A onto user B whenever the
   * profile changed while the create was in flight: the store survives and
   * reprojects across a user switch, so B would see and could navigate to A's
   * chat, and A's real record could never retire a row filed under B.
   *
   * Same capture-at-mutate rule as `hostId`, for the same reason.
   */
  readonly ownerUserId: string | null;
}

interface DeleteChatMutationContext {
  readonly hostId: string | null;
}

/**
 * What a chat mutation has to remember to refresh the record list afterwards:
 * the host it was actually sent to, captured at mutate time so a host swap in
 * flight cannot redirect the invalidation at another machine's cache.
 */
interface ChatRecordMutationContext {
  readonly hostId: string | null;
}

export type DeleteChatMutationOptions = Omit<
  UseMutationOptions<
    DeleteChatResponse,
    HostRpcError,
    DeleteChatRequest,
    DeleteChatMutationContext
  >,
  "mutationFn"
>;

/**
 * Whether the caller is expected to render this refusal ITSELF, inline, instead
 * of through the generic toast.
 *
 * `E_FORK_BOUNDARY_NOT_PUBLISHED` is the host saying "the message you picked
 * hasn't finished backing up yet - try again shortly". It is retryable in the
 * plainest sense: the identical request succeeds a moment later. A toast would
 * be wrong in tone (nothing is broken) and wrong in place - the fork dialog
 * stays OPEN on this refusal so the retry is one click, and a toast beside a
 * dialog that is already explaining itself says the same thing twice.
 *
 * Reachable only from a request that named a precise fork boundary - the
 * host mints this code for exactly one condition - which is what keeps this
 * from becoming a general "quiet fork errors" bucket that would swallow a
 * real failure for someone.
 */
function isInlineForkRefusal(error: HostRpcError): boolean {
  return error.code === "E_FORK_BOUNDARY_NOT_PUBLISHED";
}

/**
 * Tab-scoped wrapper over {@link useEpicCreateChatForHostClient}, sending the
 * create on the tab's own bound host client.
 */
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
 * Mutation hook for `epic.createChat`, host-parametric: the caller resolves
 * an explicit `HostClient` (e.g. via `useHostClientFor` for a sidebar row's
 * OWN host, or a composer placement's frozen submit client) and the request
 * is sent on THAT client. `null` client (offline / directory unresolved)
 * rejects through the mutation error channel so the caller can disable the
 * affordance - `useHostMutation`'s own `client === null` guard covers that
 * case; only the second-stage host check lives in `mapVariables` here (also
 * normalized to `HostRpcError` by `useHostMutation`'s boundary).
 *
 * The caller names the host on the request (`CreateChatMutationInput.hostId`)
 * and this hook verifies the resolved client actually dials it, so a client
 * that lost (or changed) its host identity can never make the create land
 * somewhere the caller did not ask for. `useEpicCreateChatForHost` is the
 * tab-scoped wrapper over this; row child-create passes the row's host
 * client.
 *
 * There is deliberately no client-less `useEpicCreateChat()` wrapper any
 * more: the app-wide one that existed had zero callers, and a create is
 * PLACEMENT - it must be sent on the client the placement resolved, never
 * on a host read separately from the chip.
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
        // NOT optional here: this is the variant the in-Epic new-conversation
        // modal and the fork dialog actually run. The created chat lands in
        // the host's chat database and in nothing this renderer already
        // listens to, so without
        // this the record list is never re-read - and every create-then-open
        // flow (`openCreatedChatWhenProjected`, the handoff's
        // `projectedChatId`) waits on a projection that only a poll tick can
        // deliver. Scoped to the host the request was actually SENT to, which
        // is the one whose registry changed.
        invalidateEpicChatRecords(queryClient, ctx.hostId);
      },
      onError: (error, variables) => {
        releaseCreatedChat(variables);
        if (isInlineForkRefusal(error)) return;
        // A step inside an operation that recovers from it, not the end of
        // one: the clone-on-host-switch flow narrates the history downgrade
        // itself and retries without `forkSource`, so a toast here describes
        // an ATTEMPT moments before the clone succeeds. Keyed on the request's
        // `boundary: "latest"` as well as the code, so the manual fork
        // dialog's precise-boundary refusal - genuinely terminal, nobody
        // retrying - is still reported.
        if (isRecoverableLatestForkRefusal(error, variables)) return;
        // WITH DETAIL, unlike its sibling mutations. A create is refused for
        // reasons that live entirely in the host's message and nowhere else:
        // the worktree the user asked for could not be made (`git worktree
        // add` failed - a branch name that already exists, a dirty source, a
        // path that is not a repo). The host answers `RPC_ERROR` with that
        // reason as free text and deliberately mints no wire code for it
        // (`WORKTREE_CREATE_FAILED` is a chat-stream reject code only), so the
        // bare fallback is the whole of what the user gets - "Couldn't create
        // agent.", with the actual cause reachable only by opening host.log.
        //
        // `toastFromHostErrorWithDetail` appends the host text ONLY when no
        // mapped copy claimed the error, so every branch above
        // (`E_HOST_UNSUPPORTED`, `WORKTREE_BUSY`, the transport arm) keeps its
        // written-for-a-person sentence and never gains a raw suffix.
        toastFromHostErrorWithDetail(error, "Couldn't create agent.");
      },
    },
  });
}

/**
 * Make the created chat visible NOW, on every creation surface at once.
 *
 * The host writes the chat to its own database and to nothing this renderer
 * projects, so without this the agent the user just made is invisible until its
 * record completes the round trip - a ≤20s poll at best, and longer when the
 * creating host is not the one this window's record stream is keyed to. See
 * `stores/epics/open-epic/pending-chat-creations.ts`.
 *
 * Wired into the shared create hooks rather than into each caller for three
 * reasons. It cannot be forgotten - a surface added later inherits it by using
 * the hook, which is how the sibling surfaces came to share one silent
 * `CHAT_PROJECTION_WAIT_MS` wait in the first place. It reads the REQUEST, so
 * the retained row can never disagree with what was actually sent (the host it
 * was dialled at, the parent, the title). And it is mutation-level rather than
 * a per-`mutate` callback, which TanStack drops when the calling component
 * unmounts - and every one of these surfaces closes itself the moment it
 * submits.
 *
 * The OWNER, by contrast, is captured at mutate time and handed in - see
 * {@link CreateChatMutationContext.ownerUserId}. Only the row's TIMING belongs
 * on success; the identity it is filed under belongs to the request, and reading
 * it back here would attribute the chat to whoever happens to be signed in when
 * the answer lands.
 *
 * On SUCCESS, deliberately, not at mutate time: until the host answers, the
 * chat exists nowhere, and a row for it would advance the initial-chat
 * handoff's projection machine (and disarm its orphan deadline) for a chat that
 * may never be created. The window this closes is the one the user actually
 * waits through - between "created" and "visible" - not the one they spend
 * watching a submit spinner.
 *
 * The id is read back from the RESPONSE: the resolver is idempotent on the
 * client-minted id and echoes it, and it is the id the opener navigates to, so
 * taking it from here keeps the retained row, the open intent and the eventual
 * record on one identity.
 */
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

/**
 * The signed-in user, read at the moment of call.
 *
 * The same source the open-epic store reads for its own projection identity, so
 * a captured value and a store-side read can never disagree about who "current"
 * means - they only ever disagree about WHEN, which is the entire point of
 * capturing it.
 */
function currentProfileUserId(): string | null {
  return useAuthStore.getState().profile?.userId ?? null;
}

/**
 * No record will ever arrive for this chat - the create failed. A no-op for the
 * hooks' own flow (which retains only on success) and the reason the registry's
 * failure arm exists at all: a surface that seeds a row BEFORE the answer, to
 * cover a long create, has exactly one way to take it back down. Runs for EVERY
 * failure, including the ones this hook deliberately does not toast (the clone
 * flow's recoverable fork refusals, which retry under a fresh chat id).
 */
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
        // The write landed in the host store and NOWHERE the renderer projects
        // from: a registry-only chat's record row summarises to a harness id,
        // and a pre-pivot chat's doc entry is frozen. The hover card reads the
        // tuple over `epic.getChatRunSettings`, so without this it keeps
        // rendering the pre-change model/profile/permission mode.
        invalidateChatRunSettings(queryClient, ctx.hostId);
      },
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

/**
 * Mutation hook for epic.renameChat.
 * Input enters pending (read-only) state; success is silent.
 *
 * Scoped to the Epic SESSION's host, like archive above and for the same
 * reason: both call sites (the sidebar chat tree, the canvas tab rename) sit
 * inside an Epic and outside every tile `TabHostProvider`. The ambient client
 * this used to read is the effective host, which diverges from the session
 * host for the whole of a re-point that is establishing and after one that
 * failed - a window in which the sidebar stays interactive because only the
 * canvas is made inert. A rename issued then addressed the machine the WINDOW
 * had moved to rather than the one projecting the row being renamed.
 */
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
        // The title now lives in the chat database. For a chat whose doc entry
        // the upgrade sweep removed there is no replicated write to re-project,
        // so without this refetch the row keeps its old title until the poll
        // fires - a rename that reads as a no-op.
        invalidateEpicChatRecords(queryClient, ctx.hostId);
      },
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
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "epic.setChatArchived",
    ChatRecordMutationContext,
    SetChatArchivedRequest
  >({
    client,
    method: "epic.setChatArchived",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: epicMutationKeys.setChatArchived(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: (_data, _variables, ctx) => {
        // The comment this replaces said the archive flag "lives in the epic
        // Y.Doc, so the host's write replicates back through the epic stream".
        // That stopped being true at the single-write pivot: `archivedAt` is a
        // chat-database fact now, and the record list is how it reaches here.
        invalidateEpicChatRecords(queryClient, ctx.hostId);
      },
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
 *
 * Session-scoped for the reason given on rename above, and the stakes are
 * higher here because the request names no host: `epic.deleteChat` deletes
 * whatever the RECEIVING machine holds under that chat id. Sent to the
 * effective host during a re-point, it was a delete aimed at a row the sidebar
 * was projecting from somewhere else.
 */
export function useEpicDeleteChat(): UseMutationResult<
  DeleteChatResponse,
  HostRpcError,
  DeleteChatRequest,
  DeleteChatMutationContext
> {
  const client = useEpicSessionHostClient();
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "epic.deleteChat",
    DeleteChatMutationContext,
    DeleteChatRequest
  >({
    client,
    method: "epic.deleteChat",
    mapVariables: (variables) => variables,
    options: {
      // `epic.deleteChat` names no host on the wire - the host it is SENT to
      // is the one that owns the chat being deleted - so the teardown below
      // has to be told which host that was. Captured at mutate time (the
      // repo's host-swap convention) rather than re-read in `onSuccess`, so a
      // host swap while the delete is in flight cannot make us dispose a
      // same-id chat session belonging to a different machine.
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: (_data, variables, ctx) => {
        // No active host at mutate time means nothing could have acquired a
        // session under this chat's identity either, so there is nothing to
        // force-release - and guessing a host here is exactly the
        // cross-host dispose this teardown must not perform.
        if (ctx.hostId !== null) {
          getChatSessionRegistry().forceRelease(
            variables.epicId,
            variables.chatId,
            ctx.hostId,
          );
          // This mutation-level callback survives the optimistic sidebar row
          // unmounting. Per-call callbacks owned by that row do not, which can
          // otherwise leave a deleted chat tile visible indefinitely while the
          // cloud record query is unresolved.
          useEpicCanvasStore
            .getState()
            .closeConfirmedDeletedChatTiles(
              variables.epicId,
              variables.chatId,
              ctx.hostId,
            );
        }
        // Ticket 15 (decision #29): a deleted chat can never be reopened -
        // drop its durable chat-key entries across all seven per-tab
        // registries (the tab-key side, if this chat happened to be open,
        // is already handled by the canvas store's close sweep when the
        // caller closes the tile ahead of this mutation).
        evictChatTabPersistenceForChat({
          epicId: variables.epicId,
          chatId: variables.chatId,
        });
        // A chat deleted before any real record retired its stand-in would
        // otherwise stay on screen forever. Absence is precisely what
        // `applyChatRecords` PRESERVES a pending creation through - that is the
        // disappearance guard working as designed - so the refetch below cannot
        // clear it: the correct snapshot omits the chat, and omission is the one
        // signal the registry is built to ignore. Only an explicit retirement
        // ends it, and a successful delete is exactly that.
        //
        // Most reproducible where no record was ever going to arrive on its own:
        // a host without the optional `host.chatRecords.subscribe` stream, or a
        // cross-host target whose stream this window does not mount.
        clearPendingChatCreation(variables.epicId, variables.chatId);
        // The registry tombstones the chat, and its absence from the record
        // list is what removes the row here - a doc-side removal no longer
        // happens for a chat whose entry the sweep already took.
        invalidateEpicChatRecords(queryClient, ctx.hostId);
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
