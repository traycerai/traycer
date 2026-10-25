import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { v4 as uuidv4 } from "uuid";
import { useShallow } from "zustand/react/shallow";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { CreateChatResponseV12 } from "@traycer/protocol/host/epic/unary-schemas";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import {
  PendingSandboxMessage,
  SandboxReadyLine,
  SandboxSetupLine,
} from "@/components/composer/sandbox-setup-line";
import { openStagedShapeSheet } from "@/components/composer/use-sandbox-staging";
import {
  stagedSandboxFallbackName,
  useNewHostActions,
  useSetupLineFacts,
  useStagedSandboxRunner,
  useStagedSandboxWaker,
} from "@/components/composer/use-staged-sandbox-send";
import {
  mintNewEpicTerminalTile,
  type TerminalLaunchTarget,
} from "@/components/epic-canvas/sidebar/new-terminal-tile-ref";
import { findDefaultModel } from "@/components/home/data/landing-options";
import { resolveBase64ByHash } from "@/components/home/hooks/use-landing-composer-actions";
import {
  useEpicCreateChatForHostClient,
  type CreateChatMutationInput,
} from "@/hooks/epic/use-epic-chat-mutations";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import {
  useGuiHarnessesQueryForClient,
  useGuiHarnessModelsQueryForClient,
} from "@/hooks/harnesses/use-gui-harness-catalog";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { useConfigurationProvidersOpener } from "@/hooks/sandboxes/use-open-configuration-providers";
import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";
import { useSandboxVerb } from "@/hooks/sandboxes/use-sandbox-verb-mutation";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import { openCreatedChatWhenProjectedWithNavigation } from "@/lib/commands/actions/new-chat";
import {
  confirmAttachmentsByHash,
  createAttachmentsByHashSupported,
  planAttachmentsByHash,
} from "@/lib/composer/attachments-by-hash";
import { inlineHashOnlyImageBytes } from "@/lib/composer/image-atoms";
import { resolveSeededProfileId } from "@/lib/composer/resolve-seeded-profile-id";
import { startVisibleInterval } from "@/lib/dom/visible-interval";
import { currentDraftBlobOwnerId } from "@/lib/drafts/draft-blob-transport";
import { draftImageByteTargetForHost } from "@/lib/drafts/draft-image-byte-target";
import type { NavigateNestedFocus } from "@/lib/epic-nested-focus-navigation";
import type { HostRpcRegistry } from "@/lib/host";
import { readLocalHostIdSnapshot } from "@/lib/host/local-host-id-snapshot";
import { guiHarnessIdToProviderId } from "@/lib/provider-ordering";
import {
  endPendingSandboxSend,
  pendingSandboxSendHandedHere,
  returnPendingSandboxSend,
  requestedAgentReadiness,
  type RequestedAgentReadiness,
} from "@/lib/sandboxes/pending-sandbox-send";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import {
  settleVerdict,
  stagedRunActive,
} from "@/lib/sandboxes/staged-sandbox-run";
import { useAccountContextStore } from "@/stores/auth/account-context-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  holdHandoffOwner,
  readStagedSandbox,
  stagedCreateNeedsFreshKey,
  useStagedSandbox,
  useStagedSandboxStore,
  type HandoffOwnerWatch,
  type StagedSandbox,
} from "@/stores/composer/staged-sandbox-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useInitialChatHandoffStore } from "@/stores/epics/initial-chat-handoff-store";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import { newConversationSurfaceKey } from "@/stores/host/surface-host-selection-store";
import {
  pendingSendSurfaceKey,
  usePendingSandboxSendStore,
  type PendingSandboxSend,
  type PendingSandboxSendRequest,
} from "@/stores/sandboxes/pending-sandbox-send-store";

/** How often a waiting send re-reads the requested agent's readiness. */
const READINESS_POLL_MS = 2_000;

/**
 * A pending send's owner never goes: the send is the task's, not a
 * composer's, and it ends only when it is delivered or the person ends it.
 */
const SEND_OWNER_STAYS: HandoffOwnerWatch = () => () => undefined;

/**
 * Drives every pending send of the signed-in account (sandboxes redesign,
 * Flow 1 step 2), whatever tab is in front: the create or wake, the wait for
 * the requested agent, and the message's delivery to it. Mounted once, at the
 * app root, so a send survives its task's tab going to the background and a
 * reload takes it up again.
 */
export function PendingSandboxSendsDriver(): ReactNode {
  const userId = useAuthStore((state) => state.profile?.userId ?? null);
  const ids = usePendingSandboxSendStore(
    useShallow((state) =>
      Object.values(state.sends)
        .filter((send) => send.delivery === null && send.userId === userId)
        .map((send) => send.id),
    ),
  );
  return ids.map((id) => <PendingSendDriver key={id} id={id} />);
}

function PendingSendDriver(props: { readonly id: string }): ReactNode {
  const send = usePendingSandboxSendStore(
    (state): PendingSandboxSend | null => state.sends[props.id] ?? null,
  );
  const surfaceKey = pendingSendSurfaceKey(props.id);
  const stage = useStagedSandbox(surfaceKey);
  const runner = useStagedSandboxRunner();
  const text = send?.text ?? "";
  const epicId = send?.epicId ?? null;
  useEffect(
    () => holdHandoffOwner(surfaceKey, null, SEND_OWNER_STAYS),
    [surfaceKey],
  );
  // Starts the send's run, and takes up one a reload stopped, on the same
  // key: never a second sandbox. A failure stays as it was: the person's
  // action on the line decides what follows it.
  const phase = stage?.phase ?? null;
  const failed = stage !== null && stage.failure !== null;
  // Nothing is created or woken before the send's task exists. A send
  // rehydrated with its task never confirmed lost that create to a reload:
  // it is dropped, so no sandbox is billed for a task that is not there.
  const epicConfirmed = send?.epicConfirmed;
  const lostTask =
    send !== null && !epicConfirmed && !pendingSandboxSendHandedHere(props.id);
  // Its message goes back to a start-task draft: the send held its only copy.
  useEffect(() => {
    if (lostTask) returnPendingSandboxSend(props.id);
  }, [lostTask, props.id]);
  useEffect(() => {
    if (epicId === null || !epicConfirmed) return;
    const current = readStagedSandbox(surfaceKey);
    if (current === null || current.failure !== null) return;
    const request = {
      fallbackName: stagedSandboxFallbackName(text),
      taskId: epicId,
    };
    if (current.phase === "staged") {
      runner(surfaceKey, stagedCreateNeedsFreshKey(current), {
        ...request,
        resume: false,
      });
    } else if (current.phase === "creating" && !stagedRunActive(surfaceKey)) {
      runner(surfaceKey, false, { ...request, resume: true });
    }
  }, [epicConfirmed, epicId, failed, phase, runner, surfaceKey, text]);
  // A send whose stage is gone has nothing left to deliver into: its message
  // goes back to its composer.
  const orphaned = send !== null && stage === null;
  useEffect(() => {
    if (orphaned) returnPendingSandboxSend(props.id);
  }, [orphaned, props.id]);
  // A terminal asked for in place of an agent waits on no agent: the task's
  // strip opens it once the sandbox is up.
  if (send === null || stage === null || send.request.kind === "terminal") {
    return null;
  }
  return <PendingSendDelivery send={send} stage={stage} />;
}

/**
 * Once the sandbox is up and its host connected: waits for the agent the
 * person asked for to be ready there, then hands it the message. An agent
 * that cannot run there, or whose install failed, is said on the line in
 * place; the message is never moved to another agent.
 */
function PendingSendDelivery(props: {
  readonly send: PendingSandboxSend;
  readonly stage: StagedSandbox;
}): ReactNode {
  const { send, stage } = props;
  const surfaceKey = pendingSendSurfaceKey(send.id);
  const hostId =
    stage.phase === "handoff" && stage.failure === null
      ? stage.createdHostId
      : null;
  const active = hostId !== null;
  const namedClient = useHostClientForHostId(hostId);
  const client = active ? namedClient : null;
  const harnessId = send.settings.harnessId;
  const needsModel = send.settings.model.length === 0;
  const agent = useRequestedAgentOnHost(client, active, harnessId);
  const defaultModel = useDefaultModelOnHost(
    needsModel ? client : null,
    harnessId,
  );
  const readinessKind = agent.readiness?.kind ?? null;
  const sandboxRow = useWatchedSandboxRow(
    active ? stage.createdSandboxId : null,
    surfaceKey,
  );
  const refetchAgent = agent.refetch;
  const refetchSandboxes = sandboxRow.refetch;
  useEffect(() => {
    if (readinessKind !== "waiting") return;
    return startVisibleInterval({
      tick: () => {
        refetchAgent();
        void refetchSandboxes();
      },
      intervalMs: READINESS_POLL_MS,
      fireOnShow: true,
    });
  }, [readinessKind, refetchAgent, refetchSandboxes]);
  const createChat = useEpicCreateChatForHostClient(client);
  const createChatAsync = createChat.mutateAsync;
  const navigateNestedFocus = useEpicNestedFocusNavigation();
  const providerProfiles = agent.profiles;
  const failureDetail =
    agent.readiness?.kind === "setup-failed" ? agent.readiness.detail : null;
  const rowFailed = sandboxRow.failed;
  useEffect(() => {
    if (hostId === null || readinessKind === null || rowFailed) return;
    if (agentNotReady(surfaceKey, readinessKind, failureDetail)) return;
    if (needsModel && defaultModel === null) return;
    const current = readStagedSandbox(surfaceKey);
    if (current === null || current.phase !== "handoff") return;
    const settings = {
      ...send.settings,
      model: defaultModel ?? send.settings.model,
      // A profile is the host's own: kept only where the sandbox offers it.
      profileId: resolveSeededProfileId(
        send.settings.profileId,
        providerProfiles,
        true,
      ),
    };
    if (send.request.kind === "fork") {
      deliverPendingFork({
        send,
        request: send.request,
        stage: current,
        hostId,
        settings,
        createChat: createChatAsync,
        navigateNestedFocus,
      });
      return;
    }
    if (client === null) return;
    prepareAndDeliverSend({
      send,
      hostId,
      client,
      settings,
      createChat: createChatAsync,
    });
  }, [
    client,
    createChatAsync,
    defaultModel,
    failureDetail,
    hostId,
    navigateNestedFocus,
    needsModel,
    providerProfiles,
    readinessKind,
    rowFailed,
    send,
    surfaceKey,
  ]);
  return null;
}

/**
 * The requested agent's readiness on the sandbox's host, and the profiles
 * that host offers for it. Nothing is read until the sandbox is `active`.
 */
function useRequestedAgentOnHost(
  client: HostClient<HostRpcRegistry> | null,
  active: boolean,
  harnessId: GuiHarnessId,
): {
  readonly readiness: RequestedAgentReadiness | null;
  readonly profiles: ReadonlyArray<ProviderProfile> | undefined;
  readonly refetch: () => void;
} {
  const activity = { enabled: active, subscribed: active };
  const harnesses = useGuiHarnessesQueryForClient(client, activity);
  const providers = useProvidersListForClient(client, activity);
  const providerRows = providers.data?.providers;
  const readiness = active
    ? requestedAgentReadiness(
        harnessId,
        harnesses.data?.harnesses,
        providerRows,
      )
    : null;
  const profiles = useMemo(() => {
    const providerId = guiHarnessIdToProviderId(harnessId);
    return providerId === null
      ? undefined
      : providerRows?.find((provider) => provider.providerId === providerId)
          ?.profiles;
  }, [harnessId, providerRows]);
  const refetchHarnesses = harnesses.refetch;
  const refetchProviders = providers.refetch;
  const refetch = useCallback((): void => {
    void refetchHarnesses();
    void refetchProviders();
  }, [refetchHarnesses, refetchProviders]);
  return { readiness, profiles, refetch };
}

/**
 * The model a send that named none goes with: the host's default for the
 * agent. `null` while it is not read yet, and always while `client` is
 * `null`, which is how a send that named its model reads nothing.
 */
function useDefaultModelOnHost(
  client: HostClient<HostRpcRegistry> | null,
  harnessId: GuiHarnessId,
): string | null {
  const models = useGuiHarnessModelsQueryForClient(client, harnessId, null, {
    enabled: client !== null,
    subscribed: false,
  });
  if (client === null) return null;
  return findDefaultModel(models.data?.models ?? [])?.slug ?? null;
}

/**
 * The sandbox's own row, read again from here on: a send taken up after a
 * gap may wait on a sandbox destroyed meanwhile, whose host never answers.
 * Only a read made since this mounted counts, so a list cached before the
 * sandbox existed never reads as it being gone. A row that failed is said
 * on the line; `failed` is whether it did.
 */
function useWatchedSandboxRow(
  sandboxId: string | null,
  surfaceKey: string,
): {
  readonly failed: boolean;
  readonly refetch: () => Promise<unknown>;
} {
  const [mountedAt] = useState(() => Date.now());
  const sandboxList = useSandboxList();
  const rows =
    sandboxId !== null &&
    sandboxList.data !== undefined &&
    sandboxList.data !== null &&
    sandboxList.dataUpdatedAt >= mountedAt
      ? sandboxList.data.sandboxes
      : null;
  const row =
    rows === null ? null : (rows.find((item) => item.id === sandboxId) ?? null);
  const rowVerdict = rows === null ? null : settleVerdict(row);
  const rowFailure = rowVerdict?.kind === "failure" ? rowVerdict.failure : null;
  // A sandbox that went to rest while the send waited is woken: the send is
  // the person's action, and it resumes on one. Back to its wake on the line,
  // then the wait for the agent as before.
  const resting = row?.state === "suspended" || row?.state === "stopped";
  const wake = useStagedSandboxWaker();
  useEffect(() => {
    if (resting) wake(surfaceKey);
  }, [resting, surfaceKey, wake]);
  useEffect(() => {
    if (rowFailure === null) return;
    const current = readStagedSandbox(surfaceKey);
    if (current === null || current.failure !== null) return;
    useStagedSandboxStore.getState().report(surfaceKey, {
      failure:
        rowFailure.kind === "failed"
          ? { ...rowFailure, step: "delivering" }
          : rowFailure,
    });
  }, [rowFailure, surfaceKey]);
  return { failed: rowFailure !== null, refetch: sandboxList.refetch };
}

/**
 * Whether the requested agent cannot take the message yet: still waiting,
 * or unable to run there, in which case that is said on the line.
 */
function agentNotReady(
  surfaceKey: string,
  readinessKind: RequestedAgentReadiness["kind"],
  failureDetail: string | null,
): boolean {
  if (readinessKind === "unusable") {
    useStagedSandboxStore
      .getState()
      .report(surfaceKey, { failure: { kind: "no-provider" } });
  } else if (readinessKind === "setup-failed") {
    useStagedSandboxStore.getState().report(surfaceKey, {
      failure: { kind: "agent-setup-failed", detail: failureDetail ?? "" },
    });
  }
  return readinessKind !== "ready";
}

/**
 * The message's images go to the sandbox first, by hash where it takes
 * them and inline where it does not, as any first message's do; then the
 * message is delivered, unless the send moved on meanwhile.
 */
function prepareAndDeliverSend(input: {
  readonly send: PendingSandboxSend;
  readonly hostId: string;
  readonly client: HostClient<HostRpcRegistry>;
  readonly settings: PendingSandboxSend["settings"];
  readonly createChat: CreateChatAsync;
}): void {
  const { send, hostId, settings } = input;
  const surfaceKey = pendingSendSurfaceKey(send.id);
  if (deliveriesPreparing.has(send.id)) return;
  deliveriesPreparing.add(send.id);
  void contentForHost(hostId, input.client, send.content)
    .then((prepared) => {
      if (prepared === null) {
        reportableErrorToast(
          "Couldn't attach an image.",
          { description: "Re-add the image and try sending again." },
          {
            title: "Could not attach image",
            message: null,
            code: null,
            source: "Sandbox send",
          },
        );
        notSent(surfaceKey);
        return;
      }
      const latest = readStagedSandbox(surfaceKey);
      // The send may have ended while its images were on their way.
      const sends = usePendingSandboxSendStore.getState().sends;
      if (
        latest === null ||
        latest.phase !== "handoff" ||
        latest.failure !== null ||
        !Object.hasOwn(sends, send.id) ||
        sends[send.id].delivery !== null
      ) {
        return;
      }
      deliverPendingSend({
        send,
        stage: latest,
        hostId,
        settings,
        content: prepared.content,
        attachmentsByHash: prepared.attachmentsByHash,
        createChat: input.createChat,
      });
    })
    .catch(() => notSent(surfaceKey))
    .finally(() => deliveriesPreparing.delete(send.id));
}

/** Sends whose images are on their way to the sandbox: delivered once. */
const deliveriesPreparing = new Set<string>();

/** The sandbox is up and the message did not reach it: Retry or another host. */
function notSent(surfaceKey: string): void {
  const current = readStagedSandbox(surfaceKey);
  if (current === null || current.failure !== null) return;
  useStagedSandboxStore
    .getState()
    .report(surfaceKey, { failure: { kind: "not-sent" } });
}

/**
 * The message as the sandbox can read it: each image the sandbox takes by
 * hash is uploaded to it, and every other one is inlined from this device.
 * `null` when an image's bytes are nowhere here.
 */
async function contentForHost(
  hostId: string,
  client: HostClient<HostRpcRegistry>,
  content: JsonContent,
): Promise<{
  readonly content: JsonContent;
  readonly attachmentsByHash: boolean;
} | null> {
  const plan = planAttachmentsByHash(content);
  if (plan.eligible.length === 0 && plan.ineligible.length === 0) {
    return { content, attachmentsByHash: false };
  }
  const confirmed =
    !plan.hasInlineHashedNode &&
    plan.eligible.length > 0 &&
    createAttachmentsByHashSupported(hostId, "epic.createChat")
      ? await confirmAttachmentsByHash({
          hostId,
          client,
          plan,
          ownerUserId: currentDraftBlobOwnerId(),
          onProgress: null,
        })
      : {
          byHash: new Set<string>(),
          inline: [...plan.eligible, ...plan.ineligible],
        };
  if (confirmed.inline.length === 0) {
    return { content, attachmentsByHash: true };
  }
  const bytesByHash = await resolveBase64ByHash(
    confirmed.inline,
    draftImageByteTargetForHost(hostId),
  );
  if (confirmed.inline.some((hash) => !bytesByHash.has(hash))) return null;
  return {
    content: inlineHashOnlyImageBytes(content, bytesByHash),
    attachmentsByHash: confirmed.byHash.size > 0,
  };
}

type CreateChatAsync = (
  input: CreateChatMutationInput,
) => Promise<CreateChatResponseV12>;

/**
 * Hands the message to the agent on the sandbox, once: the send is marked
 * delivered and its stage cleared before the create goes out, so a reload
 * mid-create never sends it a second time. The new agent's first-turn
 * handoff, which is persisted, owns the create's outcome from here, as it
 * does for an agent started on any host.
 */
function deliverPendingSend(input: {
  readonly send: PendingSandboxSend;
  readonly stage: StagedSandbox;
  readonly hostId: string;
  readonly settings: PendingSandboxSend["settings"];
  /** The message as the sandbox reads it (`contentForHost`). */
  readonly content: JsonContent;
  readonly attachmentsByHash: boolean;
  readonly createChat: CreateChatAsync;
}): void {
  const { send, stage, hostId, settings } = input;
  if (send.request.kind !== "chat") return;
  const now = Date.now();
  const userId = send.userId;
  const epicId = send.epicId;
  const chatId = uuidv4();
  const messageId = uuidv4();
  const clientActionId = uuidv4();
  useInitialChatHandoffStore.getState().register({
    hostId,
    userId,
    epicId,
    chatId,
    content: send.content,
    settings,
    worktreeIntent: null,
    // The pane the surface named for the agent's tile, as an ordinary create.
    placement: send.request.placement,
    messageId,
    clientActionId,
    createdAt: now,
  });
  useEpicCanvasStore.getState().markChatTitlePending(chatId, "");
  usePendingSandboxSendStore.getState().markDelivered(send.id, {
    chatId,
    hostId,
    sandboxId: stage.createdSandboxId ?? "",
    readySeconds: Math.max(
      0,
      Math.round((now - (stage.startedAt ?? now)) / 1000),
    ),
  });
  useStagedSandboxStore.getState().clear(pendingSendSurfaceKey(send.id));
  const scope = { hostId, userId, epicId };
  void input
    .createChat({
      epicId,
      hostId,
      parentId: send.request.parentId,
      title: "",
      chatId,
      settings,
      // The sandbox starts empty: the agent's first turn fetches the code.
      workspaceMode: "folderless",
      worktreeIntent: null,
      initialMessage:
        userId === null
          ? null
          : {
              messageId,
              clientActionId,
              content: input.content,
              sender: { type: "user" as const, userId },
              settings,
              accountContext: useAccountContextStore.getState().accountContext,
              sentFromHostId: readLocalHostIdSnapshot(),
              ...(input.attachmentsByHash
                ? { attachmentsByHash: true as const }
                : {}),
            },
    })
    .then((response) => {
      if (response.refusal !== undefined) {
        useEpicCanvasStore.getState().clearChatTitlePending(chatId);
        useInitialChatHandoffStore
          .getState()
          .markFailedByAction(
            scope,
            chatId,
            clientActionId,
            "Couldn't create the agent.",
          );
        return;
      }
      if (response.initialTurnStarted === true) {
        useInitialChatHandoffStore
          .getState()
          .markInitialTurnStarted(scope, chatId);
      }
    })
    .catch(() => {
      useEpicCanvasStore.getState().clearChatTitlePending(chatId);
      useInitialChatHandoffStore
        .getState()
        .markFailedByAction(
          scope,
          chatId,
          clientActionId,
          "Couldn't create the agent.",
        );
    });
}

/**
 * Forks the chat onto the sandbox, once, by the same rule as a message: the
 * send is marked delivered and its stage cleared before the create goes out.
 * The fork opens in the tab its dialog was in. A refusal or a failure is
 * reported by the create itself, and the send ends with it.
 */
function deliverPendingFork(input: {
  readonly send: PendingSandboxSend;
  readonly request: Extract<PendingSandboxSendRequest, { kind: "fork" }>;
  readonly stage: StagedSandbox;
  readonly hostId: string;
  readonly settings: PendingSandboxSend["settings"];
  readonly createChat: CreateChatAsync;
  readonly navigateNestedFocus: NavigateNestedFocus;
}): void {
  const { send, request, stage, hostId, settings } = input;
  const now = Date.now();
  const chatId = uuidv4();
  usePendingSandboxSendStore.getState().markDelivered(send.id, {
    chatId,
    hostId,
    sandboxId: stage.createdSandboxId ?? "",
    readySeconds: Math.max(
      0,
      Math.round((now - (stage.startedAt ?? now)) / 1000),
    ),
  });
  useStagedSandboxStore.getState().clear(pendingSendSurfaceKey(send.id));
  const ended = (): void => {
    usePendingSandboxSendStore.getState().remove(send.id);
  };
  void input
    .createChat({
      epicId: send.epicId,
      hostId,
      parentId: request.parentId,
      title: request.title,
      chatId,
      settings,
      // The sandbox starts empty: a fork onto another host carries no folders.
      workspaceMode: "folderless",
      worktreeIntent: null,
      initialMessage: null,
      forkSource: request.forkSource,
    })
    .then((response) => {
      if (response.refusal !== undefined) {
        ended();
        return;
      }
      Analytics.getInstance().track(AnalyticsEvent.ChatForked, {
        source: "direct_ui",
        include_history: true,
      });
      openCreatedChatWhenProjectedWithNavigation({
        intent: {
          epicId: send.epicId,
          tabId: request.tabId,
          chatId: response.chatId,
          hostId,
          placement: null,
          source: "direct_ui",
        },
        navigateNestedFocus: input.navigateNestedFocus,
      });
    })
    .catch(ended);
}

/**
 * The task's pending sends (sandboxes redesign, Flow 1 step 2): each message
 * the person sent to a staged sandbox, with the setup line above it, until it
 * is handed to the agent there. A refusal or a failure is said on the line in
 * place, with its remedies; the message is kept on every branch.
 */
export function PendingSandboxSendStrip(props: {
  readonly epicId: string;
  readonly tabId: string;
}): ReactNode {
  const userId = useAuthStore((state) => state.profile?.userId ?? null);
  const ids = usePendingSandboxSendStore(
    useShallow((state) =>
      Object.values(state.sends)
        .filter(
          (send) =>
            send.epicId === props.epicId &&
            send.delivery === null &&
            send.userId === userId,
        )
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((send) => send.id),
    ),
  );
  if (ids.length === 0) return null;
  return (
    <div
      className="flex w-full flex-col gap-3 px-4 py-3"
      data-testid="pending-sandbox-sends"
    >
      {ids.map((id) => (
        <PendingSendItem key={id} id={id} tabId={props.tabId} />
      ))}
    </div>
  );
}

function PendingSendItem(props: {
  readonly id: string;
  readonly tabId: string;
}): ReactNode {
  const send = usePendingSandboxSendStore(
    (state): PendingSandboxSend | null => state.sends[props.id] ?? null,
  );
  const surfaceKey = pendingSendSurfaceKey(props.id);
  const stage = useStagedSandbox(surfaceKey);
  const facts = useSetupLineFacts(stage);
  const runner = useStagedSandboxRunner();
  const verb = useSandboxVerb(stage?.createdSandboxId ?? "");
  const { openTile } = useEpicTileNavigation();
  const providersOpener = useConfigurationProvidersOpener(
    stage?.target.configuration.kind === "team",
  );
  const epicId = send?.epicId ?? "";
  const text = send?.text ?? "";
  const run = useCallback(
    (fresh: boolean): void => {
      runner(surfaceKey, fresh, {
        fallbackName: stagedSandboxFallbackName(text),
        taskId: epicId,
        resume: false,
      });
    },
    [epicId, runner, surfaceKey, text],
  );
  const terminal = useMemo(
    () => ({
      epicId,
      open: (target: TerminalLaunchTarget) => {
        openTile(
          tileIntent(
            mintNewEpicTerminalTile({ ...target, epicId }),
            { tabId: props.tabId },
            "explicit",
            "direct_ui",
          ),
        );
      },
    }),
    [epicId, openTile, props.tabId],
  );
  const newHost = useNewHostActions(
    surfaceKey,
    stage?.createdHostId ?? null,
    terminal,
    run,
  );
  useOpenTerminalWhenUp(send, stage, newHost.onOpenTerminal);
  if (send === null || stage === null || facts === null) return null;
  const backToComposer = (restage: boolean): void => {
    endSendBackToComposer({ send, stage, tabId: props.tabId, restage });
  };
  const name =
    stage.target.name.length > 0
      ? stage.target.name
      : stagedSandboxFallbackName(send.text);
  return (
    <div
      className="flex w-full flex-col gap-2"
      data-testid="pending-sandbox-send"
    >
      <SandboxSetupLine
        stage={stage}
        name={name}
        facts={facts}
        actions={{
          onKeepWaiting: () => run(false),
          onCancel: () => backToComposer(false),
          onChooseAnotherHost: () => backToComposer(false),
          onRetryCreation: () => run(true),
          onRetry: () => run(stagedCreateNeedsFreshKey(stage)),
          onSendAgain: () =>
            useStagedSandboxStore
              .getState()
              .report(surfaceKey, { failure: null }),
          onChangeShape: () => backToComposer(true),
          onRetryApplying: newHost.onRetryApplying,
          onStop: () => {
            if (stage.createdSandboxId !== null) verb.mutate("stop");
            backToComposer(false);
          },
          onOpenTerminal: newHost.onOpenTerminal,
          // The configuration's own Providers, a team's included.
          onOpenProviders: providersOpener(stage.target.configuration),
        }}
      />
      {send.request.kind === "chat" ? (
        <PendingSandboxMessage text={send.text} />
      ) : null}
    </div>
  );
}

/**
 * `Open terminal instead`: the terminal opens here once the sandbox is up,
 * and the send ends with it.
 */
function useOpenTerminalWhenUp(
  send: PendingSandboxSend | null,
  stage: StagedSandbox | null,
  openTerminal: (() => void) | null,
): void {
  const terminalReady =
    send !== null &&
    send.request.kind === "terminal" &&
    stage !== null &&
    stage.phase === "handoff" &&
    stage.failure === null &&
    openTerminal !== null;
  const sendId = send?.id ?? null;
  useEffect(() => {
    if (!terminalReady || sendId === null) return;
    openTerminal();
    endPendingSandboxSend(sendId);
  }, [openTerminal, sendId, terminalReady]);
}

/**
 * Ends the send and puts the message back in this task's new-agent
 * composer, where the person picks a host again; `restage` stages the same
 * sandbox there, for a shape change. A fork has no message to put back: it
 * ends, and the chat it came from is where to fork again.
 */
function endSendBackToComposer(input: {
  readonly send: PendingSandboxSend;
  readonly stage: StagedSandbox;
  readonly tabId: string;
  readonly restage: boolean;
}): void {
  const { send } = input;
  const returned = returnPendingSandboxSend(send.id);
  // A task that never came to be: its start-task draft holds the message.
  if (send.request.kind === "fork" || returned.kind === "landing-draft") {
    return;
  }
  if (input.restage) {
    const key = newConversationSurfaceKey(send.epicId);
    useStagedSandboxStore.getState().stage(key, input.stage.target);
    openStagedShapeSheet(key);
  }
  useNewConversationModalOpenStore.getState().open({
    epicId: send.epicId,
    tabId: input.tabId,
    placement: returned.kind === "task" ? returned.placement : null,
    parentId: returned.kind === "task" ? returned.parentId : null,
    hostId: null,
  });
}

/**
 * The settled setup line above an agent whose first message waited for its
 * sandbox: `Sandbox ready · name · 24 s`, its expansion the sandbox's idle
 * rule. Nothing for any other agent.
 */
export function SandboxReadyLineForChat(props: {
  readonly chatId: string;
}): ReactNode {
  const delivered = usePendingSandboxSendStore(
    (state) =>
      Object.values(state.sends).find(
        (send) => send.delivery?.chatId === props.chatId,
      ) ?? null,
  );
  const sandboxId = delivered?.delivery?.sandboxId ?? null;
  const row =
    useSandboxList().data?.sandboxes.find(
      (candidate) => candidate.id === sandboxId,
    ) ?? null;
  if (delivered === null || delivered.delivery === null) return null;
  return (
    <SandboxReadyLine
      name={row?.displayName ?? stagedSandboxFallbackName(delivered.text)}
      readySeconds={delivered.delivery.readySeconds}
      idleMinutes={row?.idleMinutes ?? null}
    />
  );
}
