import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { v5 as uuidv5 } from "uuid";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
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
  mintPendingSandboxTerminalTile,
  type TerminalLaunchTarget,
} from "@/components/epic-canvas/sidebar/new-terminal-tile-ref";
import { findDefaultModel } from "@/components/home/data/landing-options";
import { chatForkTargetSupport } from "@/components/chat/chat-fork-target";
import { resolveBase64ByHash } from "@/components/home/hooks/use-landing-composer-actions";
import {
  useEpicCreateChatForPendingSandbox,
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
import { readNegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";
import { guiHarnessIdToProviderId } from "@/lib/provider-ordering";
import {
  completePendingSandboxTerminal,
  canWithdrawPendingSandboxSend,
  pendingSandboxSendHandedHere,
  returnPendingSandboxSend,
  requestedAgentReadiness,
  type RequestedAgentReadiness,
} from "@/lib/sandboxes/pending-sandbox-send";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import {
  holdPendingSandboxSendOwnership,
  ownsPendingSandboxSend,
  ownsPendingSandboxSendExclusively,
} from "@/lib/sandboxes/pending-sandbox-send-ownership";
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
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useInitialChatHandoffStore } from "@/stores/epics/initial-chat-handoff-store";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import { newConversationSurfaceKey } from "@/stores/host/surface-host-selection-store";
import {
  pendingSendSurfaceKey,
  pendingSandboxDispatchCurrent,
  usePendingSandboxSendStore,
  type PendingSandboxSend,
  type PendingSandboxSendDispatch,
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
  const stages = useStagedSandboxStore((state) => state.bySurface);
  const ids = usePendingSandboxSendStore(
    useShallow((state) =>
      Object.values(state.sends)
        .filter((send) => {
          if (send.delivery !== null || send.userId !== userId) return false;
          const stage = stages[pendingSendSurfaceKey(send.id)];
          // Once a terminal is ready, its visible task strip owns the open.
          // A background window must let that window take the lock.
          return !(
            send.request.kind === "terminal" &&
            stage?.phase === "handoff" &&
            stage.failure === null
          );
        })
        .map((send) => send.id),
    ),
  );
  return ids.map((id) => <OwnedPendingSendDriver key={id} id={id} />);
}

/**
 * Only one window drives a send. A queued window re-reads storage when it
 * takes ownership: its hydrated copy may already have been delivered or
 * cancelled. Closing the owner releases the lock for the next window.
 */
function OwnedPendingSendDriver(props: { readonly id: string }): ReactNode {
  const navigatorWithLocks: { readonly locks?: LockManager } = navigator;
  const [owned, setOwned] = useState(
    () =>
      ownsPendingSandboxSend(props.id) ||
      navigatorWithLocks.locks === undefined,
  );
  useEffect(() => {
    let disposed = false;
    const ownership = holdPendingSandboxSendOwnership(props.id);
    void ownership.ready.then((granted) => {
      if (!disposed && granted) setOwned(true);
    });
    return () => {
      disposed = true;
      ownership.release();
    };
  }, [props.id]);
  return owned ? <PendingSendDriver id={props.id} /> : null;
}

function PendingSendDriver(props: { readonly id: string }): ReactNode {
  const send = usePendingSandboxSendStore(
    (state): PendingSandboxSend | null => state.sends[props.id] ?? null,
  );
  const surfaceKey = pendingSendSurfaceKey(props.id);
  const stage = useStagedSandbox(surfaceKey);
  usePendingSendRecovery(props.id, send, stage);
  usePendingStagedRun(send, stage, surfaceKey);
  const dispatch = send?.dispatch ?? null;
  if (send !== null && dispatch !== null) {
    return <PendingDispatchDriver send={send} dispatch={dispatch} />;
  }
  // A terminal asked for in place of an agent waits on no agent: the task's
  // strip opens it once the sandbox is up.
  if (send === null || stage === null || send.request.kind === "terminal") {
    return null;
  }
  return <PendingSendDelivery send={send} stage={stage} />;
}

/** Runs only an undispatched send; its captured intent survives older terminal records. */
function usePendingStagedRun(
  send: PendingSandboxSend | null,
  stage: StagedSandbox | null,
  surfaceKey: string,
): void {
  const runner = useStagedSandboxRunner();
  const text = send?.text ?? "";
  const epicId = send?.epicId ?? null;
  const requestKind = send?.request.kind ?? null;
  const dispatch = send?.dispatch ?? null;
  // Creation and wake failures wait for a line action; agent readiness
  // continues to be observed by the delivery driver below.
  const phase = stage?.phase ?? null;
  const failed = stage !== null && stage.failure !== null;
  const epicConfirmed = send?.epicConfirmed;
  useEffect(() => {
    if (dispatch !== null || epicId === null || !epicConfirmed) return;
    const current = readStagedSandbox(surfaceKey);
    if (current === null) return;
    // Older persisted terminal sends predate the stage's terminal intent.
    // The captured request is authoritative on reload and on a failed retry.
    if (requestKind === "terminal" && !current.openTerminal) {
      useStagedSandboxStore.getState().report(surfaceKey, {
        openTerminal: true,
      });
    }
    if (current.failure !== null) return;
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
  }, [
    dispatch,
    epicConfirmed,
    epicId,
    failed,
    phase,
    requestKind,
    runner,
    surfaceKey,
    text,
  ]);
}

/** Retains the send's stage ownership and recovers interrupted task creation. */
function usePendingSendRecovery(
  id: string,
  send: PendingSandboxSend | null,
  stage: StagedSandbox | null,
): void {
  const surfaceKey = pendingSendSurfaceKey(id);
  useEffect(
    () => holdHandoffOwner(surfaceKey, null, SEND_OWNER_STAYS),
    [surfaceKey],
  );
  // Only exclusive ownership proves an unconfirmed task was interrupted.
  // Without it another window can still be creating this send's task.
  const dispatch = send?.dispatch ?? null;
  const lostTask =
    dispatch === null &&
    send !== null &&
    !send.epicConfirmed &&
    !pendingSandboxSendHandedHere(id) &&
    ownsPendingSandboxSendExclusively(id);
  const orphaned = dispatch === null && send !== null && stage === null;
  useEffect(() => {
    // In either case this record holds the message's only copy. Return it
    // to its composer before ending a send that cannot deliver it.
    if (lostTask || orphaned) returnPendingSandboxSend(id);
  }, [id, lostTask, orphaned]);
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
    stage.phase === "handoff" &&
    (stage.failure === null || isAgentReadinessFailure(stage.failure))
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
    send.userId,
  );
  const refetchAgent = agent.refetch;
  const refetchSandboxes = sandboxRow.refetch;
  useEffect(() => {
    if (readinessKind === null || readinessKind === "ready") return;
    return startVisibleInterval({
      tick: () => {
        refetchAgent();
        void refetchSandboxes();
      },
      intervalMs: READINESS_POLL_MS,
      fireOnShow: true,
    });
  }, [readinessKind, refetchAgent, refetchSandboxes]);
  const providerProfiles = agent.profiles;
  const failureDetail =
    agent.readiness?.kind === "setup-failed" ? agent.readiness.detail : null;
  const rowFailed = sandboxRow.failed;
  useEffect(() => {
    if (hostId === null || readinessKind === null || rowFailed) return;
    const current = readStagedSandbox(surfaceKey);
    if (
      current === null ||
      current.phase !== "handoff" ||
      current.createdHostId !== hostId ||
      (current.failure !== null && !isAgentReadinessFailure(current.failure))
    ) {
      return;
    }
    if (
      agentNotReady(surfaceKey, current.failure, readinessKind, failureDetail)
    ) {
      return;
    }
    if (needsModel && defaultModel === null) return;
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
      });
      return;
    }
    if (client === null) return;
    prepareAndDeliverSend({
      send,
      hostId,
      client,
      settings,
    });
  }, [
    client,
    defaultModel,
    failureDetail,
    hostId,
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
  userId: string | null,
): {
  readonly failed: boolean;
  readonly ready: boolean;
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
    if ((useAuthStore.getState().profile?.userId ?? null) !== userId) return;
    if (resting) wake(surfaceKey);
  }, [resting, surfaceKey, userId, wake]);
  useEffect(() => {
    if ((useAuthStore.getState().profile?.userId ?? null) !== userId) return;
    if (rowFailure === null) return;
    const current = readStagedSandbox(surfaceKey);
    if (
      current === null ||
      (current.failure !== null && !isAgentReadinessFailure(current.failure))
    ) {
      return;
    }
    useStagedSandboxStore.getState().report(surfaceKey, {
      failure:
        rowFailure.kind === "failed"
          ? { ...rowFailure, step: "delivering" }
          : rowFailure,
    });
  }, [rowFailure, surfaceKey, userId]);
  return {
    failed: rowFailure !== null,
    ready: rowVerdict?.kind === "awake",
    refetch: sandboxList.refetch,
  };
}

/**
 * Whether the requested agent cannot take the message yet: still waiting,
 * or unable to run there, in which case that is said on the line.
 */
function agentNotReady(
  surfaceKey: string,
  failure: StagedSandbox["failure"],
  readinessKind: RequestedAgentReadiness["kind"],
  failureDetail: string | null,
): boolean {
  if (readinessKind === "unusable" && failure?.kind !== "no-provider") {
    useStagedSandboxStore
      .getState()
      .report(surfaceKey, { failure: { kind: "no-provider" } });
  } else if (
    readinessKind === "setup-failed" &&
    (failure?.kind !== "agent-setup-failed" ||
      failure.detail !== (failureDetail ?? ""))
  ) {
    useStagedSandboxStore.getState().report(surfaceKey, {
      failure: { kind: "agent-setup-failed", detail: failureDetail ?? "" },
    });
  } else if (
    (readinessKind === "ready" || readinessKind === "waiting") &&
    isAgentReadinessFailure(failure)
  ) {
    useStagedSandboxStore.getState().report(surfaceKey, { failure: null });
  }
  return readinessKind !== "ready";
}

/** The requested agent can become ready without withdrawing the send. */
function isAgentReadinessFailure(failure: StagedSandbox["failure"]): boolean {
  return (
    failure?.kind === "no-provider" || failure?.kind === "agent-setup-failed"
  );
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
}): void {
  const { send, hostId, settings } = input;
  const surfaceKey = pendingSendSurfaceKey(send.id);
  if (deliveriesPreparing.has(send.id)) return;
  deliveriesPreparing.add(send.id);
  void contentForHost(hostId, input.client, send.content)
    .then((prepared) => {
      if (!preparingSendCurrent(send)) return;
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
        latest.createdHostId !== hostId ||
        !ownsPendingSandboxSend(send.id) ||
        !Object.hasOwn(sends, send.id) ||
        sends[send.id].delivery !== null ||
        (useAuthStore.getState().profile?.userId ?? null) !== send.userId
      ) {
        return;
      }
      return deliverPendingSend({
        send,
        stage: latest,
        hostId,
        settings,
        content: prepared.content,
        attachmentsByHash: prepared.attachmentsByHash,
      });
    })
    .catch(() => {
      if (preparingSendCurrent(send)) notSent(surfaceKey);
    })
    .finally(() => deliveriesPreparing.delete(send.id));
}

/** Preparation may outlive its composer or account; only its own send can continue. */
function preparingSendCurrent(send: PendingSandboxSend): boolean {
  const { sends } = usePendingSandboxSendStore.getState();
  return (
    ownsPendingSandboxSend(send.id) &&
    Object.hasOwn(sends, send.id) &&
    sends[send.id].delivery === null &&
    (sends[send.id].dispatch ?? null) === null &&
    (useAuthStore.getState().profile?.userId ?? null) === send.userId
  );
}

/** Sends preparing images before their durable dispatch claim. */
const deliveriesPreparing = new Set<string>();

/** The sandbox is up and the message did not reach it: Retry or another host. */
function notSent(surfaceKey: string): void {
  const current = readStagedSandbox(surfaceKey);
  if (
    current === null ||
    (current.failure !== null && !isAgentReadinessFailure(current.failure))
  ) {
    return;
  }
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

/** Records the exact chat payload durably before any host request can begin. */
function deliverPendingSend(input: {
  readonly send: PendingSandboxSend;
  readonly stage: StagedSandbox;
  readonly hostId: string;
  readonly settings: PendingSandboxSend["settings"];
  readonly content: JsonContent;
  readonly attachmentsByHash: boolean;
}): void {
  const { send, hostId, settings } = input;
  if (send.request.kind !== "chat") return;
  claimPendingDispatch(send, input.stage, {
    epicId: send.epicId,
    hostId,
    parentId: send.request.parentId,
    title: "",
    chatId: uuidv5(`pending-sandbox-send:${send.id}:chat`, uuidv5.URL),
    settings,
    workspaceMode: "folderless",
    worktreeIntent: null,
    initialMessage:
      send.userId === null
        ? null
        : {
            messageId: uuidv5(
              `pending-sandbox-send:${send.id}:message`,
              uuidv5.URL,
            ),
            clientActionId: uuidv5(
              `pending-sandbox-send:${send.id}:action`,
              uuidv5.URL,
            ),
            content: input.content,
            sender: { type: "user", userId: send.userId },
            settings,
            accountContext: useAccountContextStore.getState().accountContext,
            sentFromHostId: readLocalHostIdSnapshot(),
            ...(input.attachmentsByHash
              ? { attachmentsByHash: true as const }
              : {}),
          },
  });
}

/** Fork boundary and destination are fixed in the same durable dispatch claim. */
function deliverPendingFork(input: {
  readonly send: PendingSandboxSend;
  readonly request: Extract<PendingSandboxSendRequest, { kind: "fork" }>;
  readonly stage: StagedSandbox;
  readonly hostId: string;
  readonly settings: PendingSandboxSend["settings"];
}): void {
  const { send, request, stage, hostId, settings } = input;
  const support = chatForkTargetSupport(
    readNegotiatedMethodVersion(hostId, "epic.createChat"),
  );
  if (support.kind === "refused") {
    notSent(pendingSendSurfaceKey(send.id));
    reportableErrorToast(
      "Couldn't fork the agent.",
      { description: support.detail },
      {
        title: "Could not fork agent",
        message: null,
        code: null,
        source: "Sandbox fork",
      },
    );
    return;
  }
  claimPendingDispatch(send, stage, {
    epicId: send.epicId,
    hostId,
    parentId: request.parentId,
    title: request.title,
    chatId: uuidv5(`pending-sandbox-send:${send.id}:chat`, uuidv5.URL),
    settings,
    workspaceMode: "folderless",
    worktreeIntent: null,
    initialMessage: null,
    forkSource: request.forkSource,
  });
}

function claimPendingDispatch(
  send: PendingSandboxSend,
  stage: StagedSandbox,
  input: PendingSandboxSendDispatch["input"],
): void {
  const now = Date.now();
  const claimed = usePendingSandboxSendStore.getState().beginDispatch(send.id, {
    input,
    status: "sending",
    delivery: {
      chatId: input.chatId,
      hostId: input.hostId,
      sandboxId: stage.createdSandboxId ?? "",
      readySeconds: Math.max(
        0,
        Math.round((now - (stage.startedAt ?? now)) / 1000),
      ),
    },
  });
  if (!claimed) {
    void usePendingSandboxSendStore.persist.rehydrate();
    notSent(pendingSendSurfaceKey(send.id));
  }
}

/** Per-window requests still in flight; another window replays the same durable IDs. */
const dispatchesInFlight = new Set<string>();

function PendingDispatchDriver(props: {
  readonly send: PendingSandboxSend;
  readonly dispatch: PendingSandboxSendDispatch;
}): ReactNode {
  const { send, dispatch } = props;
  const client = useHostClientForHostId(dispatch.input.hostId);
  const createChat = useEpicCreateChatForPendingSandbox(client, send.userId);
  const createChatAsync = createChat.mutateAsync;
  const navigateNestedFocus = useEpicNestedFocusNavigation();
  useEffect(() => {
    if (client === null || dispatch.status !== "sending") return;
    let disposed = false;
    const ownership = holdPendingSandboxSendOwnership(send.id);
    void ownership.ready.then((granted) => {
      if (!disposed && granted) {
        return runPendingDispatch(
          send,
          dispatch,
          createChatAsync,
          navigateNestedFocus,
        );
      }
    });
    return () => {
      disposed = true;
      ownership.release();
    };
  }, [client, createChatAsync, dispatch, navigateNestedFocus, send]);
  return null;
}

/** A refusal is definite; every other failed response may have accepted the create. */
async function runPendingDispatch(
  send: PendingSandboxSend,
  dispatch: PendingSandboxSendDispatch,
  createChat: CreateChatAsync,
  navigateNestedFocus: NavigateNestedFocus,
): Promise<void> {
  if (
    dispatchesInFlight.has(send.id) ||
    !ownsPendingSandboxSend(send.id) ||
    (useAuthStore.getState().profile?.userId ?? null) !== send.userId ||
    !pendingSandboxDispatchCurrent(send.id, dispatch)
  )
    return;
  dispatchesInFlight.add(send.id);
  try {
    registerDispatchHandoff(send, dispatch);
    const response = await createChat(dispatch.input);
    if (response.refusal !== undefined) {
      refusePendingDispatch(send, dispatch);
      return;
    }
    const recorded = usePendingSandboxSendStore
      .getState()
      .markDelivered(send.id, dispatch.delivery);
    if (
      !recorded ||
      (useAuthStore.getState().profile?.userId ?? null) !== send.userId
    )
      return;
    useStagedSandboxStore.getState().clear(pendingSendSurfaceKey(send.id));
    finishDispatchUi(send, dispatch, response, navigateNestedFocus);
  } catch (error: unknown) {
    if (
      error instanceof HostRpcError &&
      error.code === "E_FORK_BOUNDARY_NOT_PUBLISHED"
    ) {
      refusePendingDispatch(send, dispatch);
    } else {
      usePendingSandboxSendStore.getState().markDispatchUncertain(send.id);
    }
  } finally {
    dispatchesInFlight.delete(send.id);
  }
}

function registerDispatchHandoff(
  send: PendingSandboxSend,
  dispatch: PendingSandboxSendDispatch,
): void {
  if (send.request.kind !== "chat") return;
  const { initialMessage } = dispatch.input;
  if (initialMessage === undefined || initialMessage === null) return;
  useInitialChatHandoffStore.getState().register({
    hostId: dispatch.input.hostId,
    userId: send.userId,
    epicId: send.epicId,
    chatId: dispatch.input.chatId,
    content: initialMessage.content,
    settings: dispatch.input.settings,
    worktreeIntent: null,
    placement: send.request.placement,
    messageId: initialMessage.messageId,
    clientActionId: initialMessage.clientActionId,
    createdAt: Date.now(),
  });
  useEpicCanvasStore.getState().markChatTitlePending(dispatch.input.chatId, "");
}

function refusePendingDispatch(
  send: PendingSandboxSend,
  dispatch: PendingSandboxSendDispatch,
): void {
  if (!pendingSandboxDispatchCurrent(send.id, dispatch)) return;
  if ((useAuthStore.getState().profile?.userId ?? null) === send.userId) {
    notSent(pendingSendSurfaceKey(send.id));
    useEpicCanvasStore.getState().clearChatTitlePending(dispatch.input.chatId);
    const message = dispatch.input.initialMessage;
    if (
      send.request.kind === "chat" &&
      message !== undefined &&
      message !== null
    ) {
      useInitialChatHandoffStore.getState().markFailedByAction(
        {
          hostId: dispatch.input.hostId,
          userId: send.userId,
          epicId: send.epicId,
        },
        dispatch.input.chatId,
        message.clientActionId,
        "Couldn't create the agent.",
      );
    }
  }
  usePendingSandboxSendStore.getState().refuseDispatch(send.id);
}

function finishDispatchUi(
  send: PendingSandboxSend,
  dispatch: PendingSandboxSendDispatch,
  response: CreateChatResponseV12,
  navigateNestedFocus: NavigateNestedFocus,
): void {
  if (send.request.kind === "chat") {
    if (response.initialTurnStarted === true) {
      useInitialChatHandoffStore.getState().markInitialTurnStarted(
        {
          hostId: dispatch.input.hostId,
          userId: send.userId,
          epicId: send.epicId,
        },
        dispatch.input.chatId,
      );
    }
    return;
  }
  if (send.request.kind !== "fork") return;
  Analytics.getInstance().track(AnalyticsEvent.ChatForked, {
    source: "direct_ui",
    include_history: true,
  });
  openCreatedChatWhenProjectedWithNavigation({
    intent: {
      epicId: send.epicId,
      tabId: send.request.tabId,
      chatId: response.chatId,
      hostId: dispatch.input.hostId,
      placement: null,
      source: "direct_ui",
    },
    navigateNestedFocus,
  });
}

function PendingDispatchLine(props: {
  readonly id: string;
  readonly userId: string | null;
  readonly dispatch: PendingSandboxSendDispatch;
}): ReactNode {
  const uncertain = props.dispatch.status === "uncertain";
  return (
    <div
      className="flex flex-wrap items-center gap-2 text-ui-xs"
      data-testid="pending-sandbox-dispatch"
    >
      {uncertain ? null : (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      )}
      <span>
        {uncertain
          ? "Couldn't confirm the agent was created."
          : "Creating agent…"}
      </span>
      {uncertain ? (
        <Button
          type="button"
          variant="link"
          size="inline-xs"
          data-testid="pending-sandbox-dispatch-retry"
          onClick={() => {
            if (
              (useAuthStore.getState().profile?.userId ?? null) !== props.userId
            )
              return;
            usePendingSandboxSendStore.getState().retryDispatch(props.id);
          }}
        >
          Retry
        </Button>
      ) : null}
    </div>
  );
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

function usePendingSendWithdrawal(id: string): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let disposed = false;
    const ownership = holdPendingSandboxSendOwnership(id);
    void ownership.ready.then((granted) => {
      if (!disposed) setReady(granted);
    });
    return () => {
      disposed = true;
      ownership.release();
    };
  }, [id]);
  return ready && canWithdrawPendingSandboxSend(id);
}

function PendingSendItem(props: {
  readonly id: string;
  readonly tabId: string;
}): ReactNode {
  const send = usePendingSandboxSendStore(
    (state): PendingSandboxSend | null => state.sends[props.id] ?? null,
  );
  if (send === null) return null;
  const dispatch = send.dispatch ?? null;
  if (dispatch === null)
    return <PendingStagedSendItem send={send} tabId={props.tabId} />;
  return (
    <div
      className="flex w-full flex-col gap-2"
      data-testid="pending-sandbox-send"
    >
      <PendingDispatchLine
        id={send.id}
        userId={send.userId}
        dispatch={dispatch}
      />
      {send.request.kind === "chat" ? (
        <PendingSandboxMessage text={send.text} />
      ) : null}
    </div>
  );
}

function PendingStagedSendItem(props: {
  readonly send: PendingSandboxSend;
  readonly tabId: string;
}): ReactNode {
  const { send } = props;
  const canWithdraw = usePendingSendWithdrawal(send.id);
  const surfaceKey = pendingSendSurfaceKey(send.id);
  const stage = useStagedSandbox(surfaceKey);
  const facts = useSetupLineFacts(stage);
  const runner = useStagedSandboxRunner();
  const verb = useSandboxVerb(stage?.createdSandboxId ?? "");
  const { openTile } = useEpicTileNavigation();
  const providersOpener = useConfigurationProvidersOpener(
    stage?.target.configuration.kind === "team",
  );
  const epicId = send.epicId;
  const text = send.text;
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
            mintPendingSandboxTerminalTile({ ...target, epicId }, send.id),
            { tabId: props.tabId },
            "explicit",
            "direct_ui",
          ),
        );
      },
    }),
    [epicId, openTile, send.id, props.tabId],
  );
  const newHost = useNewHostActions(
    surfaceKey,
    stage?.createdHostId ?? null,
    terminal,
    run,
  );
  useOpenTerminalWhenUp(send, stage, newHost.onOpenTerminal);
  if (stage === null || facts === null) {
    return send.request.kind === "chat" ? (
      <PendingSandboxMessage text={send.text} />
    ) : null;
  }
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
        withdrawalAllowed={canWithdraw}
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
            if (!canWithdrawPendingSandboxSend(send.id)) return;
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
  const sendId = send?.request.kind === "terminal" ? send.id : null;
  const userId = send?.userId ?? null;
  const surfaceKey = sendId === null ? "" : pendingSendSurfaceKey(sendId);
  const [owned, setOwned] = useState(false);
  useEffect(() => {
    if (sendId === null) return;
    let disposed = false;
    const ownership = holdPendingSandboxSendOwnership(sendId);
    void ownership.ready.then((granted) => {
      if (disposed || !granted) return;
      if ((useAuthStore.getState().profile?.userId ?? null) !== userId) return;
      // A historical terminal record can predate the stage's intent flag.
      // Restore it before the row watcher can wake its resting sandbox.
      const current = readStagedSandbox(surfaceKey);
      if (current !== null && !current.openTerminal) {
        useStagedSandboxStore.getState().report(surfaceKey, {
          openTerminal: true,
        });
      }
      setOwned(true);
    });
    return () => {
      disposed = true;
      ownership.release();
    };
  }, [sendId, surfaceKey, userId]);
  const watching =
    owned &&
    sendId !== null &&
    send?.epicConfirmed === true &&
    stage?.phase === "handoff" &&
    stage.failure === null;
  const hostId = watching ? stage.createdHostId : null;
  const sandboxRow = useWatchedSandboxRow(
    watching ? stage.createdSandboxId : null,
    surfaceKey,
    userId,
  );
  const refetchSandboxes = sandboxRow.refetch;
  useEffect(() => {
    if (!watching) return;
    return startVisibleInterval({
      tick: () => {
        void refetchSandboxes();
      },
      intervalMs: READINESS_POLL_MS,
      fireOnShow: true,
    });
  }, [refetchSandboxes, watching]);
  // A cached endpoint and cwd do not prove the sandbox is still awake.
  const terminalReady = watching && sandboxRow.ready && openTerminal !== null;
  useEffect(() => {
    if (!terminalReady) return;
    const { sends } = usePendingSandboxSendStore.getState();
    if (!Object.hasOwn(sends, sendId)) return;
    const current = sends[sendId];
    const currentStage = readStagedSandbox(surfaceKey);
    if (
      !ownsPendingSandboxSend(sendId) ||
      !current.epicConfirmed ||
      current.delivery !== null ||
      currentStage?.phase !== "handoff" ||
      currentStage.failure !== null ||
      currentStage.createdHostId !== hostId ||
      (useAuthStore.getState().profile?.userId ?? null) !== current.userId
    ) {
      return;
    }
    openTerminal();
    completePendingSandboxTerminal(sendId);
  }, [hostId, openTerminal, sendId, surfaceKey, terminalReady]);
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
  if (Object.hasOwn(usePendingSandboxSendStore.getState().sends, send.id))
    return;
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
