import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { SandboxRetryApplyingButton } from "@/components/sandboxes/sandbox-retry-applying-button";
import { SandboxOperationFailure } from "@/components/hosts/sandbox-operation-failure";
import { useSandboxOperation } from "@/hooks/sandboxes/use-sandbox-operation";
import { useSandboxSettingsStatus } from "@/hooks/sandboxes/use-sandbox-settings-status";
import {
  sandboxSettingsFailureLine,
  sandboxSettingsFailed,
  sandboxSettingsEvidence,
  sandboxSettingsStepsLine,
} from "@traycer/protocol/host/sandbox-settings";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useIsMutatingOf } from "@/hooks/use-mutation-state-of";
import { v5 as uuidv5 } from "uuid";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { OpencodeLine } from "@traycer/protocol/common/opencode-line";
import { useChatSessionHandleForContainer } from "@/lib/registries/chat-session-registry";
import type {
  ChatSessionState,
  ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import type { HostSandboxState } from "@traycer/protocol/host/host-status";
import type { CreateChatResponseV12 } from "@traycer/protocol/host/epic/unary-schemas";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import {
  PendingSandboxMessage,
  SandboxReadyLine,
  SandboxSetupLine,
  type SandboxSetupLineActions,
  type SandboxSetupLineFacts,
} from "@/components/composer/sandbox-setup-line";
import {
  StoppedSandboxSendReceipts,
  StoppedSandboxSendReceiptStrip,
} from "@/components/sandboxes/stopped-sandbox-send-receipts";
import {
  openStagedShapeSheet,
  restingVerb,
} from "@/components/composer/use-sandbox-staging";
import {
  stagedSandboxFallbackName,
  useNewHostActions,
  useSetupLineFacts,
  useStagedSandboxRunner,
  type StagedSandboxRunner,
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
import {
  ChatOpencodeLineContext,
  useChatOpencodeLine,
} from "@/hooks/harnesses/chat-opencode-line-context";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import {
  useSandboxList,
  sandboxListReadSentAt,
} from "@/hooks/sandboxes/use-sandbox-list-query";
import {
  decodePendingSandboxObservation,
  type PendingSandboxObservation,
} from "@/lib/sandboxes/pending-sandbox-observation";
import {
  useSandboxVerb,
  type SandboxVerbOutcome,
} from "@/hooks/sandboxes/use-sandbox-verb-mutation";
import { useConfigurationBillingUrl } from "@/hooks/sandboxes/use-configuration-billing-url";
import {
  sandboxConfigurationOf,
  useSandboxConfigurations,
} from "@/hooks/sandboxes/use-sandbox-configurations";
import { useOpenLink } from "@/lib/links/open-link";
import { openSandboxDetails } from "@/stores/sandboxes/sandbox-details-store";
import {
  isNewConversationDraftOccupied,
  useNewConversationModalStore,
} from "@/stores/epics/new-conversation-modal-store";
import {
  recordCancelledSandboxSend,
  recordRecoveredSandboxSend,
  recordSandboxStateSend,
  recordStoppedSandboxSend,
} from "@/stores/sandboxes/stopped-sandbox-send-receipt-store";
import { startSandboxWake } from "@/lib/sandboxes/sandbox-wake";
import type { StageConfiguration } from "@/lib/sandboxes/sandbox-stage-model";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import {
  chatOpencodeLine,
  isOpencodeFamilyHarness,
} from "@/lib/chat/opencode-line";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import { openChatClone } from "@/lib/chats/chat-clone-registry";
import { openActiveModelPickerForHarness } from "@/lib/commands/active-model-picker-registry";
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
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import { readLocalHostIdSnapshot } from "@/lib/host/local-host-id-snapshot";
import { readNegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";
import { guiHarnessIdToProviderId } from "@/lib/provider-ordering";
import {
  completePendingSandboxTerminal,
  canWithdrawPendingSandboxSend,
  returnPendingSandboxSend,
  resumePendingSandboxMessageReturn,
  returnPendingSandboxMessage,
  returnPendingSandboxSendToDraft,
  returnPendingSandboxSendToSandbox,
  returnPendingSandboxSendOnItsSandbox,
  pendingSandboxRecoveryDraftId,
  requestedAgentReadiness,
  type ReturnedPendingSandboxSend,
  type ReturnedSandboxPick,
  type RequestedAgentReadiness,
} from "@/lib/sandboxes/pending-sandbox-send";
import {
  CHOOSE_ANOTHER_HOST,
  stoppingSandboxLine,
  couldntStopLine,
  RETRY,
  STOP,
  DETAILS,
} from "@/lib/sandboxes/sandbox-strings";
import { sandboxSupportReference } from "@traycer/protocol/host/sandbox-control";
import { sandboxMutationKeys } from "@/lib/query-keys";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import {
  holdPendingSandboxSendOwnership,
  ownsPendingSandboxSend,
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
  stagedSandboxRested,
  useStagedSandbox,
  useStagedSandboxStore,
  type HandoffOwnerWatch,
  type StagedSandbox,
  type StagedSandboxFailure,
  type StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useInitialChatHandoffStore } from "@/stores/epics/initial-chat-handoff-store";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import { newConversationSurfaceKey } from "@/stores/host/surface-host-selection-store";
import {
  pendingSendSurfaceKey,
  usePendingSandboxSendStore,
  type PendingSandboxSend,
  type PendingSandboxSendDispatch,
  type PendingSandboxSendRequest,
  pendingSandboxSendFacts,
  pendingSandboxDispatchCurrent,
} from "@/stores/sandboxes/pending-sandbox-send-store";

import {
  pendingSendState,
  transitionPendingSend,
  UNKNOWN_PENDING_SEND_FACTS,
  PENDING_STAGE_RETRY_EVENTS,
  type PendingStageRetryAction,
  type PendingSendObservation,
  type PendingSendFacts,
  type PendingSendBlocker,
  type PendingSendEvent,
  type PendingSendView,
  type PendingSendTransition,
} from "@/lib/sandboxes/pending-sandbox-send-transition";

/** How often a waiting send re-reads the requested agent's readiness. */
const READINESS_POLL_MS = 2_000;
const STOP_INTENT_CODE = "pending-send-stop";
const STOP_FAILED_CODE = "stop";
const stopsInFlight = new Map<string, { returned: boolean }>();
interface StopAttention {
  readonly userId: string | null;
  readonly giveBack: (rowState: HostSandboxState) => ReturnedPendingSandboxSend;
}
const stopAttention = new Map<string, StopAttention>();

/**
 * "Stopped" is only for a Stop that happened. A send that a suspend reached
 * first is an ordinary rest: Stop may yet fail, and Start would not fit.
 */
function recordStopReceipt(
  send: PendingSandboxSend,
  stage: StagedSandbox,
  returned: ReturnedPendingSandboxSend,
  rowState: HostSandboxState | null,
): void {
  if (rowState !== "suspended") {
    recordStoppedSandboxSend(
      send,
      stage,
      stage.target.name.length > 0
        ? stage.target.name
        : stagedSandboxFallbackName(send.text),
      returned,
    );
    return;
  }
  if (send.request.kind === "chat")
    recordSandboxStateSend(send, stage, returned, "rested");
}

/** A suspend is an ordinary rest whoever is watching: the message stays on its sandbox. */
function giveBackStopped(
  send: PendingSandboxSend,
  stage: StagedSandbox | undefined,
  attention: StopAttention | undefined,
  rowState: HostSandboxState | null,
): ReturnedPendingSandboxSend {
  if (attention === undefined) {
    return rowState === "suspended" && stage !== undefined
      ? returnPendingSandboxSendToSandbox(
          send.id,
          returnedSandboxPick(send, stage, rowState),
        )
      : returnPendingSandboxSendToDraft(send.id);
  }
  return attention.userId === (useAuthStore.getState().profile?.userId ?? null)
    ? attention.giveBack(rowState === "suspended" ? "suspended" : "stopped")
    : returnPendingSandboxSendToDraft(send.id);
}

/** Attention is local to the requesting mounted strip and never persisted. */
function returnStoppedPendingSend(
  id: string,
  rowState: HostSandboxState | null,
): void {
  const attention = stopAttention.get(id);
  const { sends } = usePendingSandboxSendStore.getState();
  if (!Object.hasOwn(sends, id)) return;
  const send = sends[id];
  const stage = readStagedSandbox(pendingSendSurfaceKey(id)) ?? send.stopStage;
  if (send.request.kind === "message") {
    const saveInDrafts =
      attention === undefined ||
      attention.userId !== (useAuthStore.getState().profile?.userId ?? null);
    void returnPendingSandboxMessage(id, saveInDrafts, false)
      .then((returned) => {
        if (Object.hasOwn(usePendingSandboxSendStore.getState().sends, id))
          return;
        const attempt = stopsInFlight.get(id);
        if (attempt !== undefined) attempt.returned = true;
        if (stage !== undefined)
          recordStopReceipt(send, stage, returned, rowState);
      })
      .catch(() => undefined);
    stopAttention.delete(id);
    return;
  }
  const returned = giveBackStopped(send, stage, attention, rowState);
  if (!Object.hasOwn(usePendingSandboxSendStore.getState().sends, id)) {
    const attempt = stopsInFlight.get(id);
    if (attempt !== undefined) attempt.returned = true;
    if (stage !== undefined) {
      recordStopReceipt(send, stage, returned, rowState);
    }
  }
  stopAttention.delete(id);
}

/**
 * A pending send's owner never goes: the send is the task's, not a
 * composer's, and it ends only when it is delivered or the person ends it.
 */
const SEND_OWNER_STAYS: HandoffOwnerWatch = () => () => undefined;

/**
 * Drives every pending send of the signed-in account,
 * whatever tab is in front: the create or wake, the wait for
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
  return (
    <>
      <StoppedSandboxSendReceipts />
      {ids.map((id) => (
        <OwnedPendingSendDriver key={id} id={id} />
      ))}
    </>
  );
}

/**
 * Only one window drives a send. A queued window re-reads storage when it
 * takes ownership: its hydrated copy may already have been delivered or
 * cancelled. Closing the owner releases the lock for the next window.
 */
function OwnedPendingSendDriver(props: { readonly id: string }): ReactNode {
  const [owned, setOwned] = useState(() => ownsPendingSandboxSend(props.id));
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
  if (send?.returnRequested !== undefined)
    return <PendingMessageReturnDriver send={send} />;
  return <ActivePendingSendDriver {...props} />;
}

function PendingMessageReturnDriver(props: {
  readonly send: PendingSandboxSend;
}): ReactNode {
  const { id, returnRequested } = props.send;
  useEffect(() => {
    if (returnRequested === undefined) return;
    // As it was decided when it began, sandbox and all.
    void resumePendingSandboxMessageReturn(id).catch(() => undefined);
  }, [id, returnRequested]);
  return null;
}

function ActivePendingSendDriver(props: { readonly id: string }): ReactNode {
  const send = usePendingSandboxSendStore(
    (state): PendingSandboxSend | null => state.sends[props.id] ?? null,
  );
  const surfaceKey = pendingSendSurfaceKey(props.id);
  const observedStage = useStagedSandbox(surfaceKey);
  const stage = observedStage ?? send?.stopStage ?? null;
  usePendingSendRecovery(props.id, send, stage);
  usePendingStagedRun(send, stage, surfaceKey);
  const dispatch = send?.dispatch ?? null;
  if (send !== null && dispatch !== null) {
    return <PendingDispatchDriver send={send} dispatch={dispatch} />;
  }
  // A terminal asked for in place of an agent waits on no agent: the task's
  // strip opens it once the sandbox is up.
  if (send === null || stage === null || send.ended === true) {
    return null;
  }
  if (
    send.request.kind === "message" &&
    isOpencodeFamilyHarness(send.settings.harnessId) &&
    stage.createdHostId !== null
  )
    return (
      <PendingMessageLineDelivery
        send={send}
        stage={stage}
        chatId={send.request.chatId}
        hostId={send.request.hostId ?? stage.createdHostId}
      />
    );
  return <PendingSendDelivery send={send} stage={stage} chatLineReady />;
}

/** Runs only an undispatched send; its captured intent survives older terminal records. */
function usePendingStagedRun(
  send: PendingSandboxSend | null,
  stage: StagedSandbox | null,
  surfaceKey: string,
): void {
  const runner = useStagedSandboxRunner();
  useEffect(() => {
    if (send === null) return;
    const current = readStagedSandbox(surfaceKey);
    const plan = transitionPendingSend(
      pendingSendState(send, stageBlocker(current)),
      "observe",
      pendingSandboxSendFacts(send.id, {
        ...UNKNOWN_PENDING_SEND_FACTS,
        stageStatus: current?.phase ?? "missing",
        wakeInFlight: stagedRunActive(surfaceKey),
      }),
    );
    if (!plan.effects.includes("run-stage") || current === null) return;
    executePendingStageRun(send, current, runner);
  }, [runner, send, stage, surfaceKey]);
}

/** The kernel's run-stage effect preserves the original terminal/send intent and key. */
function executePendingStageRun(
  send: PendingSandboxSend,
  stage: StagedSandbox,
  runner: StagedSandboxRunner,
): void {
  const surfaceKey = pendingSendSurfaceKey(send.id);
  if (send.request.kind === "terminal" && !stage.openTerminal)
    useStagedSandboxStore.getState().report(surfaceKey, { openTerminal: true });
  runner(surfaceKey, stagedCreateNeedsFreshKey(stage), {
    taskId: send.epicId,
    resume: stage.phase === "creating" && stage.failure === null,
  });
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
  useEffect(() => {
    if (send === null) return;
    const event = stage === null ? "stage-lost" : "reload";
    const plan = transitionPendingSend(
      pendingSendState(send, stageBlocker(stage)),
      event,
      pendingSandboxSendFacts(id, UNKNOWN_PENDING_SEND_FACTS),
    );
    if (
      plan.effects.includes("return-message") ||
      plan.effects.includes("remove")
    ) {
      const returned = returnPendingSandboxSendOnItsSandbox(id);
      // A send whose window went before its task was confirmed: nothing else
      // is left to say where its message went. Stopped and rested sends have
      // receipts of their own.
      if (
        !send.epicConfirmed &&
        send.ended !== true &&
        returned.kind === "landing-draft"
      )
        recordRecoveredSandboxSend(send, returned);
    }
    if (plan.effects.includes("rehydrate"))
      void usePendingSandboxSendStore.persist.rehydrate();
  }, [id, send, stage]);
}

interface PendingSendDeliveryProps {
  readonly send: PendingSandboxSend;
  readonly stage: StagedSandbox;
}

/** Read the bound chat's current line, including when its tile is closed. */
function PendingMessageLineDelivery(
  props: PendingSendDeliveryProps & {
    readonly chatId: string;
    readonly hostId: string;
  },
): ReactNode {
  const { send, stage, chatId, hostId } = props;
  const handle = useChatSessionHandleForContainer(
    send.epicId,
    chatId,
    hostId,
    stage.phase === "handoff",
  );
  const subscribe = useCallback(
    (listener: () => void) =>
      handle === null ? () => undefined : handle.store.subscribe(listener),
    [handle],
  );
  const getSnapshot = useCallback(
    () => handle?.store.getState().chat ?? null,
    [handle],
  );
  const chat = useSyncExternalStore(subscribe, getSnapshot, () => null);
  return (
    <ChatOpencodeLineContext
      value={chat === null ? null : chatOpencodeLine(chat)}
    >
      <PendingSendDelivery
        send={send}
        stage={stage}
        chatLineReady={chat !== null}
      />
    </ChatOpencodeLineContext>
  );
}

/**
 * Once the sandbox is up and its host connected: waits for the agent the
 * person asked for to be ready there, then hands it the message. An agent
 * that cannot run there, or whose install failed, is said on the line in
 * place; the message is never moved to another agent.
 */
function PendingSendDelivery(
  props: PendingSendDeliveryProps & { readonly chatLineReady: boolean },
): ReactNode {
  const { send, stage } = props;
  const runner = useStagedSandboxRunner();
  const surfaceKey = pendingSendSurfaceKey(send.id);
  const sandbox = useWatchedSandboxRow(
    stage.createdSandboxId,
    surfaceKey,
    send,
  );
  const { rowState } = sandbox;
  const { client, requested, model, environment } = usePendingDeliveryReadiness(
    send,
    stage,
    sandbox.environment,
    props.chatLineReady,
  );
  const event = sandboxObservation(stageBlocker(stage), environment);
  const plan = transitionPendingSend(
    pendingSendState(send, stageBlocker(stage)),
    event,
    pendingSandboxSendFacts(send.id, environment),
  );
  const polling = plan.effects.includes("poll");
  const refetchAgent = requested.refetch;
  const refetchSandboxes = sandbox.refetch;
  const refetchModel = model.refetch;
  useEffect(() => {
    if (!polling) return;
    return startVisibleInterval({
      tick: () => {
        refetchAgent();
        void refetchSandboxes();
      },
      intervalMs: READINESS_POLL_MS,
      fireOnShow: true,
    });
  }, [polling, refetchAgent, refetchSandboxes]);
  useEffect(() => {
    const resolved = pendingStageObservation(
      send.id,
      stage,
      environment,
      rowState,
    );
    if (resolved === null || executePendingStageDecision(resolved, runner))
      return;
    executePendingReadiness({
      decision: resolved.decision,
      send: resolved.send,
      stage: resolved.stage,
      client,
      requested: {
        readiness: requested.readiness,
        profiles: requested.profiles,
      },
      model: { model: model.model, refetch: refetchModel },
    });
  }, [
    client,
    environment,
    event,
    model.model,
    refetchModel,
    runner,
    requested.profiles,
    requested.readiness,
    rowState,
    send,
    stage,
    surfaceKey,
  ]);
  return null;
}

interface PendingStageObservation {
  readonly send: PendingSandboxSend;
  readonly stage: StagedSandbox;
  readonly action: PendingStageRetryAction;
  readonly manualRetry: boolean;
  readonly decision: PendingSendTransition;
  /** The row the decision observed; a withdrawal keeps a resting sandbox. */
  readonly rowState: HostSandboxState | null;
}

/** Resolve and acknowledge the current mailbox before executing any accepted intent. */
function pendingStageObservation(
  id: string,
  captured: StagedSandbox,
  environment: PendingSendFacts,
  rowState: HostSandboxState | null,
): PendingStageObservation | null {
  const { sends } = usePendingSandboxSendStore.getState();
  if (!Object.hasOwn(sends, id)) return null;
  const send = sends[id];
  const surfaceKey = pendingSendSurfaceKey(id);
  const stage = readStagedSandbox(surfaceKey);
  if (stage === null) return null;
  const retry = stage.retryRequest;
  const requestedRetry =
    retry !== undefined &&
    retry.userId === send.userId &&
    retry.clientRequestId === stage.clientRequestId &&
    retry.id !== stage.retryHandledId;
  const action = retry?.action ?? "send-again";
  const event = sandboxObservation(stageBlocker(stage), environment);
  const decision = transitionPendingSend(
    pendingSendState(send, stageBlocker(stage)),
    requestedRetry ? "consume-retry" : event,
    pendingSandboxSendFacts(id, {
      ...environment,
      stageStatus: stage.phase,
      stageCurrent:
        stage.clientRequestId === captured.clientRequestId &&
        stage.createdHostId === captured.createdHostId &&
        stage.phase === "handoff",
      retryAction: action,
      retryObservation: event,
    }),
  );
  if (!acknowledgePendingStageRetry(surfaceKey, retry?.id, decision))
    return null;
  return {
    send,
    stage,
    action,
    manualRetry: requestedRetry,
    decision,
    rowState,
  };
}

/** A failed acknowledgement may hold an accepted action, never a refused observation. */
function acknowledgePendingStageRetry(
  surfaceKey: string,
  requestId: string | undefined,
  decision: PendingSendTransition,
): boolean {
  if (
    !decision.effects.includes("acknowledge-retry") ||
    requestId === undefined
  )
    return true;
  try {
    useStagedSandboxStore
      .getState()
      .report(surfaceKey, { retryHandledId: requestId });
    return true;
  } catch {
    return !decision.effects.includes("retry");
  }
}

/** Stage work needs the captured failure; readiness retries may clear only its projection. */
function executePendingStageDecision(
  plan: PendingStageObservation,
  runner: StagedSandboxRunner,
): boolean {
  const { send, stage, action, manualRetry, decision, rowState } = plan;
  if (
    decision.effects.includes("retry") &&
    usePendingSandboxSendStore.getState().holdObservation(send.id, decision) ===
      null
  )
    return true;
  const running = decision.effects.includes("run-stage");
  if (decision.effects.includes("retry") && !running)
    useStagedSandboxStore
      .getState()
      .report(pendingSendSurfaceKey(send.id), { failure: null });
  if (running) {
    if (manualRetry && decision.effects.includes("retry"))
      executePendingStageRetry(send, stage, action, runner);
    else executePendingStageRun(send, stage, runner);
    return true;
  }
  if (
    decision.effects.includes("return-message") ||
    decision.effects.includes("remove")
  ) {
    returnWatchedSend(send, stage, rowState);
    return true;
  }
  return false;
}

/** Executes the query and preparation effects after the owner checked identity and mailbox. */
function executePendingReadiness(input: {
  readonly decision: PendingSendTransition;
  readonly send: PendingSandboxSend;
  readonly stage: StagedSandbox;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly requested: Pick<PendingAgentReadiness, "readiness" | "profiles">;
  readonly model: Pick<PendingDefaultModel, "model" | "refetch">;
}): void {
  const { decision, send, stage: current, client, requested, model } = input;
  const surfaceKey = pendingSendSurfaceKey(send.id);
  const refetchModel = model.refetch;
  if (
    decision.effects.includes("report-provider") &&
    requested.readiness !== null
  ) {
    agentNotReady(
      surfaceKey,
      current.failure,
      send.settings.harnessId,
      requested.readiness,
    );
  }
  if (decision.effects.includes("fetch-model")) refetchModel();
  if (decision.effects.includes("report-not-sent")) notSent(surfaceKey);
  if (
    !decision.effects.includes("prepare") ||
    requested.readiness?.kind !== "ready"
  )
    return;
  clearPendingSandboxFailure(surfaceKey);
  preparePendingReadySend({
    send,
    stage: current,
    client,
    model: model.model,
    profiles: requested.profiles,
    opencodeLine: requested.readiness.opencodeLine,
  });
}

/** Executes preparation against the same destination observation the kernel authorized. */
function preparePendingReadySend(input: {
  readonly send: PendingSandboxSend;
  readonly stage: StagedSandbox;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly model: string | null;
  readonly profiles: ReadonlyArray<ProviderProfile> | undefined;
  readonly opencodeLine: OpencodeLine | null;
}): void {
  const { send, stage, client } = input;
  const settings = {
    ...send.settings,
    model: input.model ?? send.settings.model,
    profileId: resolveSeededProfileId(
      send.settings.profileId,
      input.profiles,
      true,
    ),
  };
  const hostId = stage.createdHostId;
  if (hostId === null) return;
  if (send.request.kind === "fork")
    deliverPendingFork({
      send,
      request: send.request,
      stage,
      hostId,
      settings,
      opencodeLine: input.opencodeLine,
    });
  else if (client !== null)
    prepareAndDeliverSend({
      send,
      hostId,
      client,
      settings,
      opencodeLine: input.opencodeLine,
    });
}

interface PendingAgentReadiness {
  readonly readiness: RequestedAgentReadiness | null;
  readonly profiles: ReadonlyArray<ProviderProfile> | undefined;
  readonly refetch: () => void;
}

interface PendingDefaultModel {
  readonly model: string | null;
  readonly unavailable: boolean;
  readonly refetch: () => void;
}

/** Delivery and explicit Retry observe the same destination query facts. */
function usePendingDeliveryReadiness(
  send: PendingSandboxSend,
  stage: StagedSandbox | null,
  sandbox: PendingSendFacts,
  chatLineReady: boolean,
): {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly requested: PendingAgentReadiness;
  readonly model: PendingDefaultModel;
  readonly environment: PendingSendFacts;
} {
  const client = useHostClientForHostId(stage?.createdHostId ?? null);
  const opencodeLine = useChatOpencodeLine();
  const active =
    stage?.phase === "handoff" &&
    send.request.kind !== "terminal" &&
    chatLineReady;
  const requested = useRequestedAgentOnHost(
    active ? client : null,
    active,
    send.settings.harnessId,
    opencodeLine,
  );
  const needsModel = send.settings.model.length === 0;
  const model = useDefaultModelOnHost(
    active && needsModel ? client : null,
    send.settings.harnessId,
    send.id,
    stage?.createdHostId ?? null,
  );
  const environment = useMemo<PendingSendFacts>(
    () => ({
      ...sandbox,
      clientReady: client !== null,
      agentReady: requested.readiness?.kind === "ready",
      modelReady: !needsModel || model.model !== null,
      modelUnavailable: needsModel && model.unavailable,
      stageCurrent: stage?.phase === "handoff",
      stageStatus: stage?.phase ?? "missing",
    }),
    [
      client,
      model.model,
      model.unavailable,
      needsModel,
      requested.readiness,
      sandbox,
      stage?.phase,
    ],
  );
  return { client, requested, model, environment };
}

/**
 * The requested agent's readiness on the sandbox's host, and the profiles
 * that host offers for it. Nothing is read until the sandbox is `active`.
 */
function useRequestedAgentOnHost(
  client: HostClient<HostRpcRegistry> | null,
  active: boolean,
  harnessId: GuiHarnessId,
  opencodeLine: OpencodeLine | null,
): PendingAgentReadiness {
  const activity = { enabled: active, subscribed: active };
  const harnesses = useGuiHarnessesQueryForClient(client, activity);
  const providers = useProvidersListForClient(client, activity);
  const providerRows = providers.data?.providers;
  const readiness = active
    ? requestedAgentReadiness(
        harnessId,
        harnesses.data?.harnesses,
        providerRows,
        opencodeLine,
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
  sendId: string,
  hostId: string | null,
): PendingDefaultModel {
  const opencodeLine = useChatOpencodeLine();
  const models = useGuiHarnessModelsQueryForClient(client, harnessId, null, {
    // Observe the shared cache; only the kernel's fetch-model effect reads it.
    enabled: false,
    subscribed: client !== null,
  });
  const model =
    client === null
      ? null
      : (findDefaultModel(models.data?.models ?? [])?.slug ?? null);
  const identity = `${sendId}:${hostId ?? ""}:${harnessId}:${opencodeLine ?? ""}`;
  const [completed, setCompleted] = useState<string | null>(null);
  const reading = useRef<string | null>(null);
  const refetchModels = models.refetch;
  const refetch = useCallback((): void => {
    if (reading.current === identity) return;
    reading.current = identity;
    setCompleted(null);
    // A negative shared cache is not a read for this send. Only completion
    // of its own requested read can refuse a default model; positive cache
    // entries remain usable immediately.
    const finish = (): void => {
      if (reading.current !== identity) return;
      reading.current = null;
      setCompleted(identity);
    };
    void refetchModels({ cancelRefetch: false }).then(finish, finish);
  }, [identity, refetchModels]);
  return {
    model,
    refetch,
    unavailable:
      completed === identity &&
      client !== null &&
      model === null &&
      !models.isFetching &&
      (models.isError || models.data !== undefined),
  };
}

/**
 * The sandbox's own row, read again from here on: a send taken up after a
 * gap may wait on a sandbox destroyed meanwhile, whose host never answers.
 * Only a read sent after the pending request counts, so an older list
 * never reads as its sandbox being gone. A row that failed is said
 * on the line; `failed` is whether it did.
 */
interface PendingSandboxRowFacts {
  readonly row: SandboxSummary | null;
  readonly observation: PendingSandboxObservation;
  readonly known: boolean;
  readonly ready: boolean;
  readonly failure: StagedSandboxFailure | null;
  readonly terminal: boolean;
  readonly refetch: () => Promise<unknown>;
}

const TERMINAL_SANDBOX_STATES = new Set<HostSandboxState>([
  "failed",
  "destroying",
  "destroyed",
]);

/** A frozen resting sandbox needs credits too; its request remains accountable. */
function pendingSandboxFailure(
  row: SandboxSummary | null,
): StagedSandboxFailure | null {
  if (row?.frozen === true && !TERMINAL_SANDBOX_STATES.has(row.state)) {
    return { kind: "credits", shortfallMc: null };
  }
  const verdict = settleVerdict(row);
  return verdict?.kind === "failure" ? verdict.failure : null;
}

function authoritativeSandboxRows(input: {
  readonly sandboxId: string | null;
  readonly owner: string | null;
  readonly currentUserId: string | null;
  readonly failed: boolean;
  readonly rows: readonly SandboxSummary[] | null;
}): readonly SandboxSummary[] | null {
  if (
    input.owner !== input.currentUserId ||
    input.sandboxId === null ||
    input.sandboxId === ""
  )
    return null;
  if (input.failed) return null;
  return input.rows;
}

function pendingRowHost(row: SandboxSummary | null): PendingSendFacts["host"] {
  if (row === null || TERMINAL_SANDBOX_STATES.has(row.state)) return "ended";
  if (row.state === "awake") return "awake";
  if (row.state === "suspended" || row.state === "stopped") return "resting";
  return "waking";
}

/** Only a successful fresh read made for this account can settle its sandbox. */
function usePendingSandboxRowFacts(
  sandboxId: string | null,
  userId: string | null,
  hostId: string | null,
  sendId: string | null,
): PendingSandboxRowFacts {
  const [mountedAt] = useState(() => Date.now());
  const currentUserId = useAuthStore((state) => state.profile?.userId ?? null);
  const sandboxList = useSandboxList();
  const refetchQuery = sandboxList.refetch;
  const refetch = useCallback(
    () => refetchQuery({ cancelRefetch: false }),
    [refetchQuery],
  );
  useEffect(() => {
    if (sendId !== null)
      usePendingSandboxSendStore.getState().ensureObservationBoundary(sendId);
  }, [sendId, sandboxList.data]);
  const send = usePendingSandboxSendStore((state) =>
    sendId === null ? null : (state.sends[sendId] ?? null),
  );
  const rows = authoritativeSandboxRows({
    sandboxId,
    owner: userId,
    currentUserId,
    failed: sandboxList.isError,
    rows: sandboxList.data?.sandboxes ?? null,
  });
  const row =
    rows === null ? null : (rows.find((item) => item.id === sandboxId) ?? null);
  const observation: PendingSandboxObservation = {
    kind: "list",
    sentAt: sandboxListReadSentAt(sandboxList.data),
    mountedAt,
    missingSandboxId: row === null ? (sandboxId ?? undefined) : undefined,
  };
  const identityMatches =
    rows !== null && (row === null || row.hostId === hostId);
  useEffect(() => {
    if (
      sendId !== null &&
      sandboxId !== null &&
      row !== null &&
      identityMatches
    )
      usePendingSandboxSendStore
        .getState()
        .markSandboxRowSeen(sendId, sandboxId, {
          kind: "list",
          sentAt: sandboxListReadSentAt(sandboxList.data),
          mountedAt,
        });
  }, [sendId, sandboxId, row, identityMatches, sandboxList.data, mountedAt]);
  return {
    ...pendingSandboxRowProjection(send, row, observation, identityMatches),
    refetch,
  };
}

/** A row's identity and decoded provenance must both admit its visible projection. */
function pendingSandboxRowProjection(
  send: PendingSandboxSend | null,
  row: SandboxSummary | null,
  observation: PendingSandboxObservation,
  identityMatches: boolean,
): Omit<PendingSandboxRowFacts, "refetch"> {
  const host = identityMatches ? pendingRowHost(row) : "unknown";
  const observedHost =
    send === null
      ? decodePendingSandboxObservation(null, host, observation)
      : pendingSandboxSendFacts(send.id, {
          ...UNKNOWN_PENDING_SEND_FACTS,
          host,
          observation,
        }).host;
  const matching = identityMatches && observedHost !== "unknown";
  const verdict = matching ? settleVerdict(row) : null;
  const terminal =
    matching && (row === null || TERMINAL_SANDBOX_STATES.has(row.state));
  return {
    row: matching ? row : null,
    observation,
    known: matching,
    ready: verdict?.kind === "awake",
    failure: matching ? pendingSandboxFailure(row) : null,
    terminal,
  };
}

/** The stage representation is decoded here; the kernel decides what it permits. */
function stageBlocker(stage: StagedSandbox | null): PendingSendBlocker {
  const failure = stage?.failure;
  if (failure === undefined || failure === null) return "none";
  switch (failure.kind) {
    case "credits":
      return "credits";
    case "settings":
      return failure.code === STOP_INTENT_CODE ||
        failure.code === STOP_FAILED_CODE
        ? "stop"
        : "settings";
    case "no-provider":
    case "traycer-off":
    case "agent-not-offered":
    case "agent-setup-failed":
      return "provider";
    case "failed":
      return failure.code === "wake" ? "wake" : "not-sent";
    default:
      return "not-sent";
  }
}

function stageRestedAt(
  stage: StagedSandbox | null,
  rowState: HostSandboxState | null,
): boolean {
  return (
    stage !== null &&
    stagedSandboxRested(
      stage,
      rowState === "suspended" || rowState === "stopped",
    )
  );
}

function useWatchedSandboxRow(
  sandboxId: string | null,
  surfaceKey: string,
  send: PendingSandboxSend | null,
): {
  readonly failed: boolean;
  readonly ready: boolean;
  readonly refetch: () => Promise<unknown>;
  readonly environment: PendingSendFacts;
  readonly rowState: HostSandboxState | null;
} {
  const stage = readStagedSandbox(surfaceKey) ?? send?.stopStage ?? null;
  const row = usePendingSandboxRowFacts(
    sandboxId,
    send?.userId ?? null,
    stage?.createdHostId ?? null,
    send === null ? null : send.id,
  );
  const settings = useSandboxSettingsStatus(row.row);
  const rowState = row.row?.state ?? null;
  const environment = sandboxEnvironment(row, {
    ...UNKNOWN_PENDING_SEND_FACTS,
    settingsReady: settings.ready,
    clientReady: true,
    stageStatus: stage?.phase ?? "missing",
    stageCurrent: stage?.phase === "handoff",
    wakeInFlight: stagedRunActive(surfaceKey),
    stageRested: stageRestedAt(stage, rowState),
  });
  const decision =
    send === null
      ? null
      : transitionPendingSend(
          pendingSendState(send, stageBlocker(stage)),
          sandboxObservation(stageBlocker(stage), environment),
          pendingSandboxSendFacts(send.id, environment),
        );
  useEffect(() => {
    if (send === null || decision === null) return;
    projectSandboxBlocker(surfaceKey, decision.state.blocker, row.failure);
    if (
      environment.stageRested &&
      !decision.effects.includes("return-message") &&
      pendingSandboxSendFacts(send.id, environment).host === "resting"
    )
      projectSandboxRest(surfaceKey, stage);
    if (decision.effects.includes("open-terminal"))
      clearPendingSandboxFailure(surfaceKey);
    if (decision.effects.includes("end-host")) {
      if (
        usePendingSandboxSendStore
          .getState()
          .endDispatch(send.id, null, "terminal-row", environment)
      ) {
        returnWatchedSend(send, stage, rowState);
      }
    }
    if (decision.effects.includes("rehydrate"))
      void usePendingSandboxSendStore.persist.rehydrate();
    if (
      decision.effects.includes("return-message") ||
      decision.effects.includes("remove")
    ) {
      returnWatchedSend(send, stage, rowState);
    }
  }, [decision, environment, row.failure, rowState, send, stage, surfaceKey]);
  return {
    failed: row.failure !== null,
    ready: row.ready,
    refetch: row.refetch,
    environment,
    rowState,
  };
}

function clearPendingSandboxFailure(surfaceKey: string): void {
  const current = readStagedSandbox(surfaceKey);
  if (current === null || current.failure === null) return;
  useStagedSandboxStore.getState().report(surfaceKey, { failure: null });
}

/**
 * A new agent's message withdrawn because its sandbox rests goes back to its
 * task's composer, still on that sandbox; one whose sandbox ended goes back
 * without it. Either way the task says the sandbox's state where its setup
 * line was. Nothing opens: neither is anybody's gesture.
 */
function returnWatchedSend(
  send: PendingSandboxSend,
  stage: StagedSandbox | null,
  rowState: HostSandboxState | null,
): void {
  if (send.stopRequested === true) {
    returnStoppedPendingSend(send.id, rowState);
    return;
  }
  // Ended with its sandbox still up: its task is gone, so the saved draft
  // keeps the sandbox.
  if (
    send.ended === true &&
    (rowState === "awake" || restingVerb(rowState) !== null)
  ) {
    returnPendingSandboxSendOnItsSandbox(send.id);
    return;
  }
  if (send.request.kind !== "chat" || stage === null) {
    returnPendingSandboxSend(send.id);
    return;
  }
  const resting = restingVerb(rowState) !== null;
  const returned = resting
    ? returnPendingSandboxSendToSandbox(
        send.id,
        returnedSandboxPick(send, stage, rowState),
      )
    : returnPendingSandboxSend(send.id);
  if (!Object.hasOwn(usePendingSandboxSendStore.getState().sends, send.id))
    recordSandboxStateSend(send, stage, returned, resting ? "rested" : "ended");
}

/**
 * The sandbox a send's message stays on in its task's composer, as that
 * composer's own pick of it would be: an awake one is its host, a resting
 * one is staged to wake, and one not created yet is its own stage again,
 * with the create's key whenever Cancel would keep it, so an accepted
 * create still unanswered is named again rather than billed twice. A
 * created sandbox only wakes, so it needs no key.
 */
function returnedSandboxPick(
  send: PendingSandboxSend,
  stage: StagedSandbox,
  state: HostSandboxState | null,
): ReturnedSandboxPick {
  const { createdSandboxId, createdHostId, target } = stage;
  if (createdSandboxId === null || createdHostId === null)
    return {
      kind: "stage",
      target,
      clientRequestId: stagedCreateNeedsFreshKey(stage)
        ? null
        : stage.clientRequestId,
    };
  const created: Extract<StagedSandboxTarget, { kind: "existing" }> = {
    kind: "existing",
    hostId: createdHostId,
    sandboxId: createdSandboxId,
    name:
      target.name.length > 0
        ? target.name
        : stagedSandboxFallbackName(send.text),
    configuration: target.configuration,
    // Still on its way up, or awake: waking it joins that, or finds it up.
    verb: restingVerb(state) ?? "resume",
  };
  if (state === "awake") return { kind: "host", target: created };
  return { kind: "stage", target: created, clientRequestId: null };
}

/** Persist the kernel's live blocker in the setup line's existing representation. */
function projectSandboxBlocker(
  surfaceKey: string,
  blocker: PendingSendBlocker,
  failure: StagedSandboxFailure | null,
): void {
  if (blocker !== "credits" && blocker !== "settings") return;
  if (failure === null || failure.kind !== blocker) return;
  const current = readStagedSandbox(surfaceKey);
  if (
    current === null ||
    JSON.stringify(current.failure) === JSON.stringify(failure)
  )
    return;
  useStagedSandboxStore.getState().report(surfaceKey, { failure });
}

/**
 * A send this window can't give back keeps the person's way to wake its
 * sandbox: a stopped stage, which Retry runs again. A refusal already on the
 * stage has its own remedy; "ready, but nothing was sent" no longer holds.
 */
function projectSandboxRest(
  surfaceKey: string,
  stage: StagedSandbox | null,
): void {
  if (stage === null) return;
  if (stage.failure !== null && stage.failure.kind !== "not-sent") return;
  useStagedSandboxStore
    .getState()
    .report(surfaceKey, { phase: "creating", failure: { kind: "rested" } });
}

/**
 * Whether the requested agent cannot take the message yet: still waiting,
 * or unable to run there, in which case that is said on the line.
 */
function agentNotReady(
  surfaceKey: string,
  failure: StagedSandbox["failure"],
  harnessId: GuiHarnessId,
  readiness: RequestedAgentReadiness,
): void {
  let next: StagedSandbox["failure"];
  switch (readiness.kind) {
    case "not-offered":
      next = { kind: "agent-not-offered", harnessId };
      break;
    case "traycer-off":
      next = { kind: "traycer-off" };
      break;
    case "unusable":
      next = { kind: "no-provider" };
      break;
    case "setup-failed":
      next = { kind: "agent-setup-failed", detail: readiness.detail };
      break;
    case "ready":
    case "waiting":
      if (!isAgentReadinessFailure(failure)) return;
      next = null;
  }
  if (JSON.stringify(next) === JSON.stringify(failure)) return;
  useStagedSandboxStore.getState().report(surfaceKey, { failure: next });
}

/** The requested agent can become ready without withdrawing the send. */
function isAgentReadinessFailure(failure: StagedSandbox["failure"]): boolean {
  return (
    failure?.kind === "no-provider" ||
    failure?.kind === "traycer-off" ||
    failure?.kind === "agent-not-offered" ||
    failure?.kind === "agent-setup-failed"
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
  readonly opencodeLine: OpencodeLine | null;
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
        const decision = transitionPendingSend(
          pendingSendState(send, stageBlocker(readStagedSandbox(surfaceKey))),
          "prepare-failed",
          pendingSandboxSendFacts(send.id, UNKNOWN_PENDING_SEND_FACTS),
        );
        if (decision.effects.includes("report-not-sent")) notSent(surfaceKey);
        return;
      }
      const latest = readStagedSandbox(surfaceKey);
      const decision = transitionPendingSend(
        pendingSendState(send, "none"),
        "prepared",
        pendingSandboxSendFacts(send.id, {
          ...UNKNOWN_PENDING_SEND_FACTS,
          modelReady: true,
          stageCurrent:
            latest?.phase === "handoff" &&
            latest.createdHostId === hostId &&
            latest.failure === null,
        }),
      );
      if (!decision.effects.includes("persist-claim") || latest === null)
        return;
      return deliverPendingSend({
        send,
        stage: latest,
        hostId,
        settings,
        content: prepared.content,
        attachmentsByHash: prepared.attachmentsByHash,
        opencodeLine: input.opencodeLine,
      });
    })
    .catch(() => {
      const decision = transitionPendingSend(
        pendingSendState(send, stageBlocker(readStagedSandbox(surfaceKey))),
        "prepare-failed",
        pendingSandboxSendFacts(send.id, UNKNOWN_PENDING_SEND_FACTS),
      );
      if (decision.effects.includes("report-not-sent")) notSent(surfaceKey);
    })
    .finally(() => deliveriesPreparing.delete(send.id));
}

/** Preparation may outlive its composer or account; only its own send can continue. */
function preparingSendCurrent(send: PendingSandboxSend): boolean {
  const stage = readStagedSandbox(pendingSendSurfaceKey(send.id));
  return transitionPendingSend(
    pendingSendState(send, "none"),
    "prepared",
    pendingSandboxSendFacts(send.id, {
      ...UNKNOWN_PENDING_SEND_FACTS,
      modelReady: true,
      stageCurrent: stage?.phase === "handoff" && stage.failure === null,
    }),
  ).effects.includes("persist-claim");
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
  readonly opencodeLine: OpencodeLine | null;
}): void {
  const { send, hostId, settings } = input;
  if (send.request.kind !== "chat" && send.request.kind !== "message") return;
  claimPendingDispatch(send, input.stage, {
    epicId: send.epicId,
    hostId,
    parentId: send.request.kind === "chat" ? send.request.parentId : null,
    title: "",
    chatId:
      send.request.kind === "message"
        ? send.request.chatId
        : uuidv5(`pending-sandbox-send:${send.id}:chat`, uuidv5.URL),
    settings,
    ...(input.opencodeLine === null
      ? {}
      : { opencodeLine: input.opencodeLine }),
    workspaceMode: "folderless",
    worktreeIntent:
      send.request.kind === "message"
        ? (send.request.worktreeIntent ?? null)
        : null,
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
  readonly opencodeLine: OpencodeLine | null;
}): void {
  const { send, request, stage, hostId, settings } = input;
  const support = chatForkTargetSupport(
    readNegotiatedMethodVersion(hostId, "epic.createChat"),
  );
  if (support.kind === "refused") {
    const decision = transitionPendingSend(
      pendingSendState(send, stageBlocker(stage)),
      "prepare-failed",
      pendingSandboxSendFacts(send.id, UNKNOWN_PENDING_SEND_FACTS),
    );
    if (!decision.effects.includes("report-not-sent")) return;
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
    ...(input.opencodeLine === null
      ? {}
      : { opencodeLine: input.opencodeLine }),
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
    const decision = transitionPendingSend(
      pendingSendState(send, stageBlocker(stage)),
      "claim-write-failed",
      pendingSandboxSendFacts(send.id, UNKNOWN_PENDING_SEND_FACTS),
    );
    void usePendingSandboxSendStore.persist.rehydrate();
    if (decision.effects.includes("report-not-sent"))
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
  const policy = usePendingDispatchLifecycle(send, dispatch, client === null);
  return send.request.kind === "message" ? (
    <PendingMessageDispatchDriver
      send={send}
      dispatch={dispatch}
      policy={policy}
    />
  ) : (
    <PendingCreateDispatchDriver
      send={send}
      dispatch={dispatch}
      client={client}
      policy={policy}
    />
  );
}

function PendingCreateDispatchDriver(props: {
  readonly send: PendingSandboxSend;
  readonly dispatch: PendingSandboxSendDispatch;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly policy: PendingDispatchPolicy;
}): ReactNode {
  const { send, dispatch, client, policy } = props;
  const createChat = useEpicCreateChatForPendingSandbox(client, send.userId);
  const createChatAsync = createChat.mutateAsync;
  const navigateNestedFocus = useEpicNestedFocusNavigation();
  useEffect(() => {
    if (!policy.dispatchAllowed) return;
    let disposed = false;
    const ownership = holdPendingSandboxSendOwnership(send.id);
    void ownership.ready.then((granted) => {
      if (!disposed && granted) {
        return runPendingDispatch(send, dispatch, {
          createChat: createChatAsync,
          navigateNestedFocus,
          environment: policy.environment,
        });
      }
    });
    return () => {
      disposed = true;
      ownership.release();
    };
  }, [
    createChatAsync,
    dispatch,
    navigateNestedFocus,
    policy.dispatchAllowed,
    policy.environment,
    send,
  ]);
  return null;
}

/** The existing chat uses its ordinary seeded send and the same durable claim. */
function PendingMessageDispatchDriver(props: {
  readonly send: PendingSandboxSend;
  readonly dispatch: PendingSandboxSendDispatch;
  readonly policy: PendingDispatchPolicy;
}): ReactNode {
  const handle = useChatSessionHandleForContainer(
    props.send.epicId,
    props.dispatch.input.chatId,
    props.dispatch.input.hostId,
    props.policy.dispatchAllowed,
  );
  return handle === null ? null : (
    <PendingMessageDispatchSession {...props} handle={handle} />
  );
}

function PendingMessageDispatchSession(props: {
  readonly send: PendingSandboxSend;
  readonly dispatch: PendingSandboxSendDispatch;
  readonly policy: PendingDispatchPolicy;
  readonly handle: ChatSessionStoreHandle;
}): ReactNode {
  const { send, dispatch, policy, handle } = props;
  const snapshot = useStore(
    handle.store,
    useShallow((state) => ({
      epoch: state.connectionEpoch,
      status: state.connectionStatus,
      loaded: state.snapshotLoaded,
      canAct: state.access?.canAct === true,
      accepted: state.acceptedActions,
      pending: state.pendingActions,
      messages: state.messages,
      delivery: state.messageDelivery,
      failed: state.failedSendRestoration,
      lastCopies: state.lastCopyPrompts,
      notices: state.errorNotices,
    })),
  );
  const attempt = useRef<PendingMessageAttempt | null>(null);
  useEffect(() => {
    const message = dispatch.input.initialMessage;
    if (
      message === null ||
      message === undefined ||
      send.request.kind !== "message" ||
      !pendingSandboxDispatchCurrent(send.id, dispatch)
    )
      return;
    const state = handle.store.getState();
    if (
      settlePendingMessage({
        send,
        dispatch,
        state,
        message,
        dispatchAllowed: policy.dispatchAllowed,
      })
    )
      return;
    if (
      !policy.dispatchAllowed ||
      !pendingMessageCanDispatch({
        send,
        dispatch,
        state,
        handle,
        attempt: attempt.current,
        actionId: message.clientActionId,
      })
    )
      return;
    const plan = transitionPendingSend(
      pendingSendState(send, "none"),
      "observe",
      pendingSandboxSendFacts(send.id, policy.environment),
    );
    if (!plan.effects.includes("dispatch")) return;
    if (
      usePendingSandboxSendStore.getState().holdObservation(send.id, plan) ===
      null
    )
      return;
    attempt.current = { handle, epoch: state.connectionEpoch };
    if (!sendPendingMessage(state, send, dispatch, message)) {
      attempt.current = null;
      usePendingSandboxSendStore
        .getState()
        .markDispatchUncertain(send.id, dispatch);
    }
  }, [
    dispatch,
    handle,
    policy.dispatchAllowed,
    policy.environment,
    send,
    snapshot,
  ]);
  return null;
}

interface PendingMessageAttempt {
  readonly handle: ChatSessionStoreHandle;
  readonly epoch: number;
}

type PendingDispatchMessage = NonNullable<
  PendingSandboxSendDispatch["input"]["initialMessage"]
>;

function pendingMessageOutcome(
  state: ChatSessionState,
  message: PendingDispatchMessage,
): "accepted" | "rejected" | "waiting" {
  if (
    state.acceptedActions[message.clientActionId]?.action === "send" ||
    state.messages.some(
      (row) => row.role === "user" && row.messageId === message.messageId,
    ) ||
    state.messageDelivery?.messageId === message.messageId
  )
    return "accepted";
  // A rejection can be displaced from the composer's single recovery slot.
  // Absence from pendingActions alone is never proof of rejection.
  if (
    state.failedSendRestoration?.clientActionId === message.clientActionId ||
    Object.hasOwn(state.lastCopyPrompts, message.clientActionId) ||
    state.errorNotices.some(
      (notice) => notice.clientActionId === message.clientActionId,
    )
  )
    return "rejected";
  return "waiting";
}

function settlePendingMessage(input: {
  readonly send: PendingSandboxSend;
  readonly dispatch: PendingSandboxSendDispatch;
  readonly state: ChatSessionState;
  readonly message: PendingDispatchMessage;
  readonly dispatchAllowed: boolean;
}): boolean {
  const { send, dispatch, state, message, dispatchAllowed } = input;
  const outcome = pendingMessageOutcome(state, message);
  if (outcome === "accepted") {
    if (
      usePendingSandboxSendStore
        .getState()
        .markDelivered(send.id, dispatch.delivery)
    ) {
      useStagedSandboxStore.getState().clear(pendingSendSurfaceKey(send.id));
    }
    return true;
  }
  if (outcome !== "rejected" || !dispatchAllowed) return false;
  refusePendingDispatch(send, dispatch);
  state.ackRetainedRejectedSend(message.clientActionId);
  return true;
}

function pendingMessageCanDispatch(input: {
  readonly send: PendingSandboxSend;
  readonly dispatch: PendingSandboxSendDispatch;
  readonly state: ChatSessionState;
  readonly handle: ChatSessionStoreHandle;
  readonly attempt: PendingMessageAttempt | null;
  readonly actionId: string;
}): boolean {
  const { send, dispatch, state, handle, attempt, actionId } = input;
  const pending = Object.hasOwn(state.pendingActions, actionId);
  if (state.connectionStatus !== "open") {
    if (dispatch.status === "sending" && (attempt !== null || pending)) {
      usePendingSandboxSendStore
        .getState()
        .markDispatchUncertain(send.id, dispatch);
    }
    return false;
  }
  if (
    !state.snapshotLoaded ||
    state.access?.canAct !== true ||
    send.userId === null ||
    pending
  )
    return false;
  return attempt?.handle !== handle || attempt.epoch !== state.connectionEpoch;
}

function sendPendingMessage(
  state: ChatSessionState,
  send: PendingSandboxSend,
  dispatch: PendingSandboxSendDispatch,
  message: PendingDispatchMessage,
): boolean {
  if (send.request.kind !== "message") return false;
  return (
    state.sendSeededUserMessage({
      messageId: message.messageId,
      clientActionId: message.clientActionId,
      content: message.content,
      sender: message.sender,
      settings: dispatch.input.settings,
      worktreeIntent: send.request.worktreeIntent ?? null,
      browserAnnotations: send.request.browserAnnotations,
      deliveryPolicy: send.request.deliveryPolicy,
    }) !== null
  );
}

/** Converts observations into facts; only the transition kernel chooses effects. */
function sandboxEnvironment(
  row: PendingSandboxRowFacts,
  environment: PendingSendFacts,
): PendingSendFacts {
  let host: PendingSendFacts["host"] = "unknown";
  if (row.terminal) host = "ended";
  else if (row.known && row.row !== null) {
    host = "waking";
    if (row.row.state === "awake") host = "awake";
    else if (row.row.state === "suspended" || row.row.state === "stopped")
      host = "resting";
  }
  return {
    ...environment,
    observation: row.observation,
    host,
    frozen: row.row?.frozen ?? false,
    settingsReady:
      row.row?.guestConfigured !== false && environment.settingsReady,
  };
}

function sandboxObservation(
  blocker: PendingSendBlocker,
  environment: PendingSendFacts,
): PendingSendObservation {
  if (environment.host === "ended") return "terminal-row";
  if (
    blocker === "credits" &&
    environment.host !== "unknown" &&
    !environment.frozen
  )
    return "unfrozen";
  if (
    blocker === "settings" &&
    environment.host === "awake" &&
    environment.settingsReady
  )
    return "settings-repaired";
  if (blocker === "client" && environment.clientReady) return "client-restored";
  return "observe";
}

interface PendingDispatchPolicy {
  readonly dispatchAllowed: boolean;
  readonly environment: PendingSendFacts;
}

/** The same kernel controls replay, wake, terminal recovery, and blocked views. */
function usePendingDispatchLifecycle(
  send: PendingSandboxSend,
  dispatch: PendingSandboxSendDispatch,
  clientMissing: boolean,
): PendingDispatchPolicy {
  const row = usePendingSandboxRowFacts(
    dispatch.delivery.sandboxId,
    send.userId,
    dispatch.input.hostId,
    send.id,
  );
  const binding = useHostBinding();
  const queryClient = useQueryClient();
  const wakeRequested = useRef(false);
  const [owned, setOwned] = useState(() => ownsPendingSandboxSend(send.id));
  const settings = useSandboxSettingsStatus(row.row);
  useEffect(() => {
    let disposed = false;
    const ownership = holdPendingSandboxSendOwnership(send.id);
    void ownership.ready.then((granted) => {
      if (!disposed) setOwned(granted);
    });
    return () => {
      disposed = true;
      ownership.release();
    };
  }, [send.id]);
  const environment = sandboxEnvironment(row, {
    ...UNKNOWN_PENDING_SEND_FACTS,
    clientReady: !clientMissing,
    settingsReady: settings.ready,
    agentReady: true,
    modelReady: true,
    wakeInFlight: false,
    inFlight: dispatchesInFlight.has(send.id),
  });
  const event = sandboxObservation(dispatch.blocker ?? "none", environment);
  const plan = transitionPendingSend(
    pendingSendState(send, "none"),
    event,
    pendingSandboxSendFacts(send.id, environment),
  );
  const polling = plan.effects.includes("poll");
  const refetch = row.refetch;
  useEffect(() => {
    if (!polling) return;
    return startVisibleInterval({
      tick: () => {
        void refetch();
      },
      intervalMs: READINESS_POLL_MS,
      fireOnShow: true,
    });
  }, [polling, refetch]);
  useEffect(() => {
    if (!owned) return;
    const decision = usePendingSandboxSendStore
      .getState()
      .dispatchEvent(
        send.id,
        send.retryRequest !== undefined &&
          send.retryRequest.id !== send.retryHandledId
          ? "consume-retry"
          : event,
        {
          ...environment,
          retryAction: "send-again",
          retryObservation: event,
          wakeInFlight: wakeRequested.current,
        },
      );
    if (decision === null) return;
    if (decision.effects.includes("rehydrate"))
      void usePendingSandboxSendStore.persist.rehydrate();
    if (decision.effects.includes("end-host")) {
      if (
        usePendingSandboxSendStore
          .getState()
          .endDispatch(send.id, dispatch, "terminal-row", environment)
      )
        returnPendingSandboxSend(send.id);
    }
    if (
      decision.effects.includes("return-message") ||
      decision.effects.includes("remove")
    )
      returnPendingSandboxSend(send.id);
    if (decision.state.blocker === "wake" || environment.host !== "resting")
      wakeRequested.current = false;
    if (!decision.effects.includes("wake") || wakeRequested.current) return;
    const wakeBoundary = usePendingSandboxSendStore
      .getState()
      .holdObservation(send.id, decision);
    if (wakeBoundary === null) return;
    wakeRequested.current = true;
    void startSandboxWake(
      queryClient,
      binding,
      dispatch.input.hostId,
      "send",
    ).then((outcome) => {
      const settled = usePendingSandboxSendStore
        .getState()
        .dispatchEvent(
          send.id,
          outcome?.kind === "awake" ? "observe" : "wake-failed",
          {
            ...environment,
            wakeInFlight: true,
            observation: { kind: "wake-result", requestedAt: wakeBoundary },
          },
        );
      if (settled?.effects.includes("poll")) void refetch();
    });
  }, [
    binding,
    dispatch,
    environment,
    event,
    owned,
    queryClient,
    refetch,
    send.id,
    send.retryRequest,
    send.retryHandledId,
  ]);
  return {
    dispatchAllowed: owned && plan.effects.includes("dispatch"),
    environment,
  };
}

/** A refusal is definite; every other failed response may have accepted the create. */
async function runPendingDispatch(
  send: PendingSandboxSend,
  dispatch: PendingSandboxSendDispatch,
  execution: {
    readonly createChat: CreateChatAsync;
    readonly navigateNestedFocus: NavigateNestedFocus;
    readonly environment: PendingSendFacts;
  },
): Promise<void> {
  const { createChat, navigateNestedFocus, environment } = execution;
  const plan = transitionPendingSend(
    pendingSendState(send, "none"),
    "observe",
    pendingSandboxSendFacts(send.id, {
      ...environment,
      inFlight: dispatchesInFlight.has(send.id),
    }),
  );
  if (!plan.effects.includes("dispatch")) return;
  if (
    usePendingSandboxSendStore.getState().holdObservation(send.id, plan) ===
    null
  )
    return;
  dispatchesInFlight.add(send.id);
  try {
    const response = await createChat(dispatch.input);
    if (response.refusal !== undefined) {
      refusePendingDispatch(send, dispatch);
      return;
    }
    // The agent's tile opens once its chat exists on the sandbox; until then
    // the pending send shows the setup line and the message.
    registerDispatchHandoff(send, dispatch);
    const receiptOwnership = ownsPendingSandboxSend(send.id);
    const recorded = usePendingSandboxSendStore
      .getState()
      .markDelivered(send.id, dispatch.delivery);
    if (!recorded) return;
    const receipt = transitionPendingSend(
      { ...plan.state, phase: "accepted" },
      "receipt-saved",
      {
        ...pendingSandboxSendFacts(send.id, {
          ...environment,
          host: "awake",
          observation: {
            kind: "dispatch-result",
            chatId: dispatch.input.chatId,
            hostId: dispatch.input.hostId,
          },
        }),
        owns: receiptOwnership,
      },
    );
    if (!receipt.effects.includes("finish-ui")) return;
    useStagedSandboxStore.getState().clear(pendingSendSurfaceKey(send.id));
    finishDispatchUi(send, dispatch, response, navigateNestedFocus);
  } catch (error: unknown) {
    if (
      error instanceof HostRpcError &&
      error.code === "E_FORK_BOUNDARY_NOT_PUBLISHED"
    ) {
      refusePendingDispatch(send, dispatch);
    } else {
      usePendingSandboxSendStore
        .getState()
        .markDispatchUncertain(send.id, dispatch);
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
  const decision = transitionPendingSend(
    pendingSendState(send, "none"),
    "known-refusal",
    pendingSandboxSendFacts(send.id, {
      ...UNKNOWN_PENDING_SEND_FACTS,
      observation: {
        kind: "dispatch-result",
        chatId: dispatch.input.chatId,
        hostId: dispatch.input.hostId,
      },
    }),
  );
  if (!decision.effects.includes("known-refusal")) return;
  if (decision.effects.includes("report-not-sent")) {
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
  usePendingSandboxSendStore.getState().refuseDispatch(send.id, dispatch);
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

/**
 * A claimed send. Until the sandbox takes the request, its setup line stays
 * above the message; only a refusal or a failure replaces it with the
 * dispatch line.
 */
function PendingDispatchItem(props: {
  readonly id: string;
  readonly userId: string | null;
  readonly dispatch: PendingSandboxSendDispatch;
  readonly tabId: string;
}): ReactNode {
  const row = usePendingSandboxRowFacts(
    props.dispatch.delivery.sandboxId,
    props.userId,
    props.dispatch.input.hostId,
    props.id,
  );
  const client = useHostClientForHostId(props.dispatch.input.hostId);
  const settings = useSandboxSettingsStatus(row.row);
  const send = usePendingSandboxSendStore(
    (state): PendingSandboxSend | null => state.sends[props.id] ?? null,
  );
  const stage = useStagedSandbox(pendingSendSurfaceKey(props.id));
  if (send === null) return null;
  const environment = sandboxEnvironment(row, {
    ...UNKNOWN_PENDING_SEND_FACTS,
    clientReady: client !== null,
    settingsReady: settings.ready,
    inFlight: dispatchesInFlight.has(props.id),
    agentReady: true,
    modelReady: true,
  });
  const stored = pendingSendState(send, "none");
  const facts = pendingSandboxSendFacts(props.id, environment);
  const { view } = transitionPendingSend(
    stored,
    sandboxObservation(props.dispatch.blocker ?? "none", environment),
    facts,
  );
  // The view can run ahead of the stored record, which is what a Retry asks.
  const retryable =
    view.canRetry &&
    transitionPendingSend(
      stored,
      "request-dispatch-retry",
      facts,
    ).effects.includes("request-dispatch-retry");
  if (stage !== null && (view.line === "waiting" || view.line === "creating"))
    return <PendingStagedSendItem send={send} tabId={props.tabId} />;
  return (
    <div
      className="flex w-full flex-col gap-2"
      data-testid="pending-sandbox-send"
    >
      <div
        className="flex flex-wrap items-center gap-2 text-ui-xs"
        data-testid="pending-sandbox-dispatch"
      >
        {view.line === "uncertain" ||
        view.line === "credits" ||
        view.line === "settings" ||
        view.line === "not-sent" ? null : (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
        )}
        <span>
          {view.line === "settings"
            ? pendingSettingsTitle(row.row, settings.data)
            : pendingDispatchLineCopy(send.request.kind, view.line)}
        </span>
        {view.line === "settings" ? (
          <PendingDispatchSettingsDetail row={row.row} status={settings.data} />
        ) : null}
        {view.line === "credits" || view.line === "settings" ? (
          <PendingDispatchRemedy
            id={props.dispatch.delivery.sandboxId}
            userId={props.userId}
            row={row.row}
            failure={view.line}
          />
        ) : null}
        {retryable ? (
          <Button
            type="button"
            variant="link"
            size="inline-xs"
            data-testid="pending-sandbox-dispatch-retry"
            onClick={() => {
              usePendingSandboxSendStore
                .getState()
                .requestDispatchRetry(props.id);
            }}
          >
            Retry
          </Button>
        ) : null}
      </div>
      <PendingSendMessage send={send} />
    </div>
  );
}

function pendingSettingsTitle(
  row: SandboxSummary | null,
  status: EnvironmentStatusResponseV11 | undefined,
): string {
  if (row === null) return "Applying settings…";
  if (
    !sandboxSettingsFailed(status?.items ?? []) &&
    row.guestConfigured !== false
  )
    return "Applying settings…";
  return sandboxSettingsFailureLine(
    row.displayName,
    status?.principal?.kind === "team" ? status.principal.teamName : "Personal",
    "SBX-0520",
  );
}

function PendingDispatchSettingsDetail(props: {
  readonly row: SandboxSummary | null;
  readonly status: EnvironmentStatusResponseV11 | undefined;
}): ReactNode {
  if (
    !sandboxSettingsFailed(props.status?.items ?? []) &&
    props.row?.guestConfigured !== false
  )
    return null;
  return (
    <div className="flex w-full flex-col gap-1">
      <p>Compute is charged while it is awake.</p>
      <p>
        {sandboxSettingsStepsLine(
          sandboxSettingsEvidence(
            props.status?.items ?? [],
            props.row?.guestConfigured ?? null,
          ),
        )}
      </p>
      <p>Your message waits until they apply.</p>
    </div>
  );
}

function pendingDispatchLineCopy(
  kind: PendingSandboxSendRequest["kind"],
  line: Exclude<PendingSendView["line"], "settings">,
): string {
  const message = kind === "message";
  const copy: Readonly<
    Record<Exclude<PendingSendView["line"], "settings">, string>
  > = {
    hidden: "",
    waiting: "Waiting for the sandbox…",
    creating: message ? "Sending message…" : "Creating agent…",
    uncertain: message
      ? "Couldn't confirm the message was sent."
      : "Couldn't confirm the agent was created.",
    credits: "Add credits to resume this sandbox.",
    "not-sent": "Couldn't resume this sandbox.",
    model: "Waiting for a model…",
    provider: "Waiting for the agent…",
    delivered: message ? "Message sent." : "Agent ready.",
  };
  return copy[line];
}

/** Repairs a live sandbox without releasing a possibly accepted request. */
function PendingDispatchRemedy(props: {
  readonly id: string;
  readonly userId: string | null;
  readonly row: SandboxSummary | null;
  readonly failure: "credits" | "settings";
}): ReactNode {
  const { configurations } = useSandboxConfigurations();
  const configuration =
    props.row === null
      ? null
      : sandboxConfigurationOf(props.row, configurations);
  const billingUrl = useConfigurationBillingUrl(
    configuration ?? { kind: "personal" },
  );
  const openLink = useOpenLink();
  if (props.failure === "settings" && props.row !== null)
    return (
      <SandboxRetryApplyingButton
        hostId={props.row.hostId}
        guestSetupFailed={props.row.guestConfigured === false}
      />
    );
  return (
    <Button
      type="button"
      variant="link"
      size="inline-xs"
      onClick={() => {
        if ((useAuthStore.getState().profile?.userId ?? null) !== props.userId)
          return;
        if (props.failure === "credits" && configuration !== null)
          void openLink(billingUrl, "account", null);
        else openSandboxDetails(props.id);
      }}
    >
      {props.failure === "credits" ? "Add credits" : "Details"}
    </Button>
  );
}

/**
 * The task's pending sends: each message
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
            send.request.kind !== "message" &&
            send.delivery === null &&
            send.userId === userId,
        )
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((send) => send.id),
    ),
  );
  return (
    <>
      <StoppedSandboxSendReceiptStrip
        epicId={props.epicId}
        tabId={props.tabId}
      />
      {ids.length > 0 ? (
        <div
          className="flex w-full flex-col gap-3 px-4 py-3"
          data-testid="pending-sandbox-sends"
        >
          {ids.map((id) => (
            <PendingSendItem key={id} id={id} tabId={props.tabId} />
          ))}
        </div>
      ) : null}
    </>
  );
}

/** A bound send's setup and pending bubble stay beside that chat on every copy. */
export function PendingSandboxSendForChat(props: {
  readonly epicId: string;
  readonly chatId: string;
  readonly tabId: string;
}): ReactNode {
  const userId = useAuthStore((state) => state.profile?.userId ?? null);
  const ids = usePendingSandboxSendStore(
    useShallow((state) =>
      Object.values(state.sends)
        .filter(
          (send) =>
            send.epicId === props.epicId &&
            send.userId === userId &&
            send.delivery === null &&
            send.request.kind === "message" &&
            send.request.chatId === props.chatId,
        )
        .map((send) => send.id),
    ),
  );
  return (
    <>
      <StoppedSandboxSendReceiptStrip
        epicId={props.epicId}
        tabId={props.tabId}
        chatId={props.chatId}
      />
      {ids.map((id) => (
        <PendingSendItem key={id} id={id} tabId={props.tabId} />
      ))}
    </>
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
  if (send.returnRequested !== undefined)
    return <PendingMessageReturnItem send={send} />;
  const dispatch = send.dispatch ?? null;
  if (dispatch === null)
    return <PendingStagedSendItem send={send} tabId={props.tabId} />;
  return (
    <PendingDispatchItem
      id={send.id}
      userId={send.userId}
      dispatch={dispatch}
      tabId={props.tabId}
    />
  );
}

function PendingMessageReturnItem(props: {
  readonly send: PendingSandboxSend;
}): ReactNode {
  const { send } = props;
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // As it was decided when it began, sandbox and all.
  const giveBack = useCallback(
    () => resumePendingSandboxMessageReturn(send.id),
    [send.id],
  );
  useEffect(() => {
    let disposed = false;
    void giveBack().then(
      () => {
        if (
          !disposed &&
          Object.hasOwn(usePendingSandboxSendStore.getState().sends, send.id)
        )
          setFailed(true);
      },
      () => {
        if (!disposed) setFailed(true);
      },
    );
    return () => {
      disposed = true;
    };
  }, [attempt, giveBack, send.id]);
  return (
    <div
      className="flex w-full flex-col gap-2"
      data-testid="pending-sandbox-send"
    >
      <p role="status" className="text-ui-xs text-muted-foreground">
        {failed
          ? "Couldn't return your message. It is still kept here."
          : "Returning your message…"}
      </p>
      <Button
        type="button"
        variant="link"
        size="inline-xs"
        aria-busy={!failed}
        disabled={!failed}
        onClick={() => {
          setFailed(false);
          setAttempt((value) => value + 1);
        }}
      >
        Cancel the message
      </Button>
      <PendingSendMessage send={send} />
    </div>
  );
}

/** Manual stage retries preserve the captured failure until the runner has read it. */
function executePendingStageRetry(
  send: PendingSandboxSend,
  stage: StagedSandbox,
  action: PendingStageRetryAction,
  runner: StagedSandboxRunner,
): void {
  let fresh = false;
  if (action === "retry-creation") fresh = true;
  else if (action === "retry-stage") fresh = stagedCreateNeedsFreshKey(stage);
  runner(pendingSendSurfaceKey(send.id), fresh, {
    taskId: send.epicId,
    resume: false,
  });
}

/** A queued strip publishes intent; only the owning window runs stage or host effects. */
function usePendingStagedSendRetry(
  send: PendingSandboxSend,
  runner: StagedSandboxRunner,
): (action: PendingStageRetryAction) => void {
  return useCallback(
    (action: PendingStageRetryAction) => {
      const surfaceKey = pendingSendSurfaceKey(send.id);
      const current = readStagedSandbox(surfaceKey);
      const { sends } = usePendingSandboxSendStore.getState();
      if (current === null || !Object.hasOwn(sends, send.id)) return;
      const publish =
        action === "send-again" || !ownsPendingSandboxSend(send.id);
      const plan = transitionPendingSend(
        pendingSendState(sends[send.id], stageBlocker(current)),
        publish ? "request-retry" : PENDING_STAGE_RETRY_EVENTS[action],
        pendingSandboxSendFacts(send.id, {
          ...UNKNOWN_PENDING_SEND_FACTS,
          retryAction: action,
          settingsReady: true,
          stageStatus: current.phase,
          wakeInFlight: stagedRunActive(surfaceKey),
        }),
      );
      if (plan.effects.includes("request-retry"))
        void useStagedSandboxStore
          .getState()
          .requestRetry(surfaceKey, send.userId, action);
      executePendingStageDecision(
        {
          send: sends[send.id],
          stage: current,
          action,
          manualRetry: true,
          decision: plan,
          rowState: null,
        },
        runner,
      );
    },
    [send, runner],
  );
}

/** Stop holds the unsent copy until the mutation or a fresh row proves rest. */
async function stopPendingSend(
  id: string,
  stop: () => Promise<SandboxVerbOutcome>,
  requested: () => void,
  refresh: () => Promise<unknown>,
): Promise<void> {
  const plan = pendingStopDecision(id, "stop", "unknown", null);
  if (plan?.effects.includes("hold-stop")) {
    if (!usePendingSandboxSendStore.getState().holdStop(id)) return;
    try {
      useStagedSandboxStore.getState().report(pendingSendSurfaceKey(id), {
        failure: { kind: "settings", code: STOP_INTENT_CODE },
      });
    } catch {
      // The pending record already holds the durable intent. A failed stage
      // projection cannot veto the authorized Stop or erase its observer.
    }
  }
  if (!plan?.effects.includes("stop-host")) {
    if (plan?.effects.includes("remove")) {
      requested();
      returnStoppedPendingSend(id, null);
    }
    return;
  }
  const boundary =
    usePendingSandboxSendStore.getState().sends[id]?.stopRequestedAt ?? null;
  const originalSend = usePendingSandboxSendStore.getState().sends[id];
  const originalStage =
    readStagedSandbox(pendingSendSurfaceKey(id)) ?? originalSend.stopStage;
  requested();
  void refresh();
  stopsInFlight.set(id, { returned: false });
  try {
    const outcome = await stop();
    observePendingStopResult(originalSend, originalStage, boundary, outcome);
  } catch {
    const failed = pendingStopDecision(id, "stop-failed", "unknown", boundary);
    if (failed?.outcome === "applied") {
      // Retain the failure on the existing stage across a new mutation observer.
      useStagedSandboxStore.getState().report(pendingSendSurfaceKey(id), {
        failure: { kind: "settings", code: STOP_FAILED_CODE },
      });
    }
  } finally {
    stopsInFlight.delete(id);
  }
}

/** A stop completion either gives back the held copy or points at task-loss recovery. */
function observePendingStopResult(
  originalSend: PendingSandboxSend,
  originalStage: StagedSandbox | undefined,
  boundary: number | null,
  outcome: SandboxVerbOutcome,
): void {
  const id = originalSend.id;
  const host = stoppedHostObservation(outcome);
  const rowState = outcome.kind === "settled" ? outcome.state : null;
  const settled = pendingStopDecision(id, "stop-result", host, boundary);
  if (settled?.effects.includes("remove"))
    returnStoppedPendingSend(id, rowState);
  else if (
    settled === null &&
    stopsInFlight.get(id)?.returned !== true &&
    host === "resting" &&
    originalStage !== undefined &&
    originalSend.userId === (useAuthStore.getState().profile?.userId ?? null)
  ) {
    // Task deletion may already have recovered and removed the pending send.
    // Point at that saved draft; never recreate or return its message twice.
    const draftId = pendingSandboxRecoveryDraftId(id);
    if (
      useLandingDraftStore
        .getState()
        .drafts.some((draft) => draft.id === draftId)
    ) {
      recordStopReceipt(
        originalSend,
        originalStage,
        { kind: "landing-draft", draftId },
        rowState,
      );
    }
  }
}

/** A moving or non-resting verb answer proves no completed Stop. */
function stoppedHostObservation(
  outcome: SandboxVerbOutcome,
): PendingSendFacts["host"] {
  if (outcome.kind === "gone") return "ended";
  if (
    outcome.kind === "settled" &&
    (outcome.state === "stopped" || outcome.state === "suspended")
  )
    return "resting";
  return "unknown";
}

/** Every completion rechecks the current record and the original account. */
function pendingStopDecision(
  id: string,
  event: PendingSendEvent,
  host: PendingSendFacts["host"],
  boundary: number | null,
): PendingSendTransition | null {
  const { sends } = usePendingSandboxSendStore.getState();
  if (!Object.hasOwn(sends, id)) return null;
  const stage =
    readStagedSandbox(pendingSendSurfaceKey(id)) ?? sends[id].stopStage;
  return transitionPendingSend(
    pendingSendState(
      sends[id],
      stageBlocker(readStagedSandbox(pendingSendSurfaceKey(id))),
    ),
    event,
    pendingSandboxSendFacts(id, {
      ...UNKNOWN_PENDING_SEND_FACTS,
      host,
      observation:
        event === "stop"
          ? { kind: "none" }
          : { kind: "stop-result", requestedAt: boundary },
      sandboxKnown: (stage?.createdSandboxId ?? null) !== null,
      inFlight: stopsInFlight.has(id),
    }),
  );
}

/** The existing failure projection retains a Stop failure across observer replacement. */
function isStopFailure(failure: StagedSandboxFailure | null): boolean {
  return failure?.kind === "settings" && failure.code === STOP_FAILED_CODE;
}

function PendingStopLine(props: {
  readonly name: string;
  readonly sandboxId: string;
  readonly configuration: StageConfiguration;
  readonly costLine: string;
  readonly pending: boolean;
  readonly failed: boolean;
  readonly canWithdraw: boolean;
  readonly stop: () => void;
}): ReactNode {
  const operation = useSandboxOperation(props.sandboxId);
  const failure =
    operation?.kind === "failed" && operation.verb === "stop" && !props.pending
      ? operation
      : null;
  return (
    <div data-testid="sandbox-setup-line" className="flex flex-col gap-2">
      <p className="m-0">{props.costLine}</p>
      {failure !== null ? (
        <SandboxOperationFailure
          sandboxId={props.sandboxId}
          name={props.name}
          configuration={props.configuration}
          operation={failure}
          busy={props.pending}
          onRetry={props.canWithdraw ? props.stop : null}
        />
      ) : (
        <PendingStopFallback
          name={props.name}
          sandboxId={props.sandboxId}
          pending={props.pending}
          failed={props.failed}
          canWithdraw={props.canWithdraw}
          stop={props.stop}
        />
      )}
    </div>
  );
}

/** A held Stop stays readable while its outcome is pending or no longer cached. */
function PendingStopFallback(props: {
  readonly name: string;
  readonly sandboxId: string;
  readonly pending: boolean;
  readonly failed: boolean;
  readonly canWithdraw: boolean;
  readonly stop: () => void;
}): ReactNode {
  return (
    <>
      <span>
        {!props.failed || props.pending
          ? stoppingSandboxLine(props.name)
          : `${couldntStopLine(props.name)} · ${sandboxSupportReference("stop")}`}
      </span>
      <div className="flex flex-wrap gap-2">
        {props.canWithdraw ? (
          <Button
            type="button"
            variant="link"
            size="inline-xs"
            data-testid="sandbox-setup-stop"
            disabled={props.pending}
            onClick={props.stop}
          >
            {props.pending ? STOP : RETRY}
          </Button>
        ) : null}
        {props.failed && !props.pending ? (
          <Button
            type="button"
            variant="link"
            size="inline-xs"
            onClick={() => openSandboxDetails(props.sandboxId)}
          >
            {DETAILS}
          </Button>
        ) : null}
      </div>
    </>
  );
}

type PendingLineRemedies = Pick<
  SandboxSetupLineActions,
  "onChooseModel" | "onChooseAnotherHost"
>;

/**
 * A message to an existing chat is handed back to that chat's composer first:
 * "Choose a model" then opens its picker on what sandboxes run, and "Choose
 * another host" the chat's clone flow, which carries the message to the clone
 * unsent. A message the composer could not take went to Drafts instead, and
 * nothing is carried. Every other request takes `otherwise`.
 */
function pendingMessageRemedies(
  send: PendingSandboxSend,
  offeredAgents: ReadonlyArray<string> | null,
  otherwise: PendingLineRemedies,
): PendingLineRemedies {
  const request = send.request;
  if (request.kind !== "message") return otherwise;
  return {
    onChooseModel: () => {
      void returnPendingSandboxMessage(send.id, false, true).catch(
        () => undefined,
      );
      openActiveModelPickerForHarness("traycer", null, offeredAgents);
    },
    onChooseAnotherHost: () => {
      // Another host is the person's choice: a draft keeps no sandbox.
      void returnPendingSandboxMessage(send.id, false, false).then(
        (returned) => {
          if (returned.kind === "chat") openChatClone(request.chatId);
        },
        () => undefined,
      );
    },
  };
}

/** Model recovery needs an undispatched message and an empty destination draft. */
function pendingSandboxModelRecovery(input: {
  readonly send: PendingSandboxSend;
  readonly stage: StagedSandbox;
  readonly tabId: string;
  readonly canWithdraw: boolean;
  readonly draftOccupied: boolean;
  readonly pick: ReturnedSandboxPick;
}): (() => void) | null {
  if (
    input.send.request.kind !== "chat" ||
    !input.send.epicConfirmed ||
    input.send.ended === true ||
    !input.canWithdraw ||
    input.draftOccupied
  )
    return null;
  return () => {
    endSendBackToComposer({
      send: input.send,
      stage: input.stage,
      tabId: input.tabId,
      restage: false,
      pick: input.pick,
      modelPickerHarnessId: "traycer",
    });
  };
}

function PendingStagedSendItem(props: {
  readonly send: PendingSandboxSend;
  readonly tabId: string;
}): ReactNode {
  const { send } = props;
  const canWithdraw = usePendingSendWithdrawal(send.id);
  const taskDraftOccupied = useNewConversationModalStore((state) =>
    isNewConversationDraftOccupied(state.draftPatchesByEpicId[send.epicId]),
  );
  const surfaceKey = pendingSendSurfaceKey(send.id);
  const observedStage = useStagedSandbox(surfaceKey);
  const stage = observedStage ?? send.stopStage ?? null;
  const attention = useRef<StopAttention | null>(null);
  useEffect(
    () => () => {
      if (stopAttention.get(send.id) === attention.current)
        stopAttention.delete(send.id);
    },
    [send.id, send.userId],
  );
  const facts = useSetupLineFacts(stage);
  const runner = useStagedSandboxRunner();
  const retrySend = usePendingStagedSendRetry(send, runner);
  const sandboxId = stage?.createdSandboxId ?? "";
  const verb = useSandboxVerb(sandboxId);
  const activeVerbs = useIsMutatingOf({
    mutationKey: sandboxMutationKeys.verb(sandboxId),
  });
  const sandboxList = useSandboxList();
  const { openTile } = useEpicTileNavigation();
  const epicId = send.epicId;
  const run = useCallback(
    (fresh: boolean): void => {
      const { sends } = usePendingSandboxSendStore.getState();
      if (!Object.hasOwn(sends, send.id)) return;
      const current = readStagedSandbox(surfaceKey);
      let event: PendingSendEvent = "observe";
      if (current?.failure !== null && current?.failure !== undefined)
        event = "retry";
      if (current?.failure?.kind === "settings") event = "settings-repaired";
      const plan = transitionPendingSend(
        pendingSendState(sends[send.id], stageBlocker(current)),
        event,
        pendingSandboxSendFacts(send.id, {
          ...UNKNOWN_PENDING_SEND_FACTS,
          settingsReady: true,
          stageStatus: current?.phase ?? "missing",
          wakeInFlight: stagedRunActive(surfaceKey),
        }),
      );
      if (
        event === "settings-repaired" &&
        plan.outcome === "applied" &&
        plan.state.blocker !== "stop"
      )
        useStagedSandboxStore.getState().report(surfaceKey, { failure: null });
      if (!plan.effects.includes("run-stage")) return;
      runner(surfaceKey, fresh, {
        taskId: epicId,
        resume: false,
      });
    },
    [epicId, runner, send.id, surfaceKey],
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
    return <PendingSendMessage send={send} />;
  }
  const rowState =
    sandboxList.data?.sandboxes.find((row) => row.id === stage.createdSandboxId)
      ?.state ?? null;
  const backToComposer = (
    restage: boolean,
    pick: ReturnedSandboxPick | null,
  ): ReturnedPendingSandboxSend => {
    return endSendBackToComposer({
      send,
      stage,
      tabId: props.tabId,
      restage,
      pick,
    });
  };
  const stop = (): void => {
    void stopPendingSend(
      send.id,
      () => verb.mutateAsync("stop"),
      () => {
        attention.current = {
          userId: send.userId,
          // Back in this task's composer, still on its sandbox: its send
          // wakes it again.
          giveBack: (rowState) =>
            backToComposer(false, returnedSandboxPick(send, stage, rowState)),
        };
        stopAttention.set(send.id, attention.current);
      },
      () => sandboxList.refetch({ cancelRefetch: false }),
    );
  };
  const name =
    stage.target.name.length > 0
      ? stage.target.name
      : stagedSandboxFallbackName(send.text);
  const chooseModel = pendingSandboxModelRecovery({
    send,
    stage,
    tabId: props.tabId,
    canWithdraw,
    draftOccupied: taskDraftOccupied,
    pick: returnedSandboxPick(send, stage, rowState),
  });
  const lineRemedies = pendingMessageRemedies(send, facts.offeredAgents, {
    onChooseModel: chooseModel,
    onChooseAnotherHost: () => backToComposer(false, null),
  });
  return (
    <div
      className="flex w-full flex-col gap-2"
      data-testid="pending-sandbox-send"
    >
      {pendingSendState(send, stageBlocker(stage)).blocker === "stop" ? (
        <PendingStopLine
          name={name}
          sandboxId={sandboxId}
          configuration={stage.target.configuration}
          costLine={facts.costLine}
          pending={verb.isPending || activeVerbs > 0}
          failed={verb.error !== null || isStopFailure(stage.failure)}
          canWithdraw={canWithdraw}
          stop={stop}
        />
      ) : (
        <PendingSendSetupLine
          requestKind={send.request.kind}
          withdrawalAllowed={canWithdraw}
          stage={stage}
          name={name}
          facts={facts}
          actions={{
            onKeepWaiting: () => retrySend("keep-waiting"),
            onCancel: () => {
              if (send.request.kind === "message") {
                void returnPendingSandboxMessage(send.id, false, true).catch(
                  () => undefined,
                );
                return;
              }
              const returned = backToComposer(
                false,
                returnedSandboxPick(send, stage, rowState),
              );
              if (
                !Object.hasOwn(
                  usePendingSandboxSendStore.getState().sends,
                  send.id,
                )
              )
                recordCancelledSandboxSend(send, returned);
            },
            onChooseAnotherHost: lineRemedies.onChooseAnotherHost,
            chooseAnotherHostLabel: CHOOSE_ANOTHER_HOST,
            onRetryCreation: () => retrySend("retry-creation"),
            onRetry: () => retrySend("retry-stage"),
            onSendAgain: () => retrySend("send-again"),
            onChangeShape: () => backToComposer(true, null),
            onRetryApplying: newHost.onRetryApplying,
            onRepairSetup: newHost.onRepairSetup,
            repairSetupPending: newHost.repairSetupPending,
            applyingPending: newHost.applyingPending,
            applyingError: newHost.applyingError,
            onStop: stop,
            onOpenTerminal: newHost.onOpenTerminal,
            onChooseModel: lineRemedies.onChooseModel,
          }}
        />
      )}
      <PendingSendMessage send={send} />
    </div>
  );
}

function PendingSendMessage(props: {
  readonly send: PendingSandboxSend;
}): ReactNode {
  if (
    props.send.request.kind !== "chat" &&
    props.send.request.kind !== "message"
  )
    return null;
  return <PendingSandboxMessage text={props.send.text} />;
}

/** An existing chat keeps its binding, so its message changes no shape. */
function PendingSendSetupLine(props: {
  readonly requestKind: PendingSandboxSendRequest["kind"];
  readonly stage: StagedSandbox;
  readonly name: string;
  readonly facts: SandboxSetupLineFacts;
  readonly withdrawalAllowed: boolean;
  readonly actions: SandboxSetupLineActions;
}): ReactNode {
  const { requestKind, actions, ...line } = props;
  if (requestKind !== "message")
    return <SandboxSetupLine {...line} actions={actions} />;
  return (
    <SandboxSetupLine {...line} actions={{ ...actions, onChangeShape: null }} />
  );
}

/** A visible terminal ask holds its original-account ownership and repairs legacy intent. */
function usePendingTerminalOwnership(
  sendId: string | null,
  userId: string | null,
  surfaceKey: string,
): boolean {
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
  return owned;
}

/** Observe and poll a terminal's sandbox before handoff, including a held Stop. */
function usePendingTerminalSandbox(
  send: PendingSandboxSend | null,
  stage: StagedSandbox | null,
  owned: boolean,
): {
  readonly hostId: string | null;
  readonly ready: boolean;
  readonly environment: PendingSendFacts;
} {
  const sendId = send?.request.kind === "terminal" ? send.id : null;
  const surfaceKey = sendId === null ? "" : pendingSendSurfaceKey(sendId);
  const sandboxId = stage?.createdSandboxId ?? null;
  const watching =
    owned &&
    sendId !== null &&
    send?.epicConfirmed === true &&
    sandboxId !== null;
  const hostId = stage?.createdHostId ?? null;
  const sandboxRow = useWatchedSandboxRow(
    watching ? sandboxId : null,
    surfaceKey,
    send,
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
  // An endpoint alone cannot open a terminal. The row and handoff must agree.
  return {
    hostId,
    ready: watching && stage?.phase === "handoff" && sandboxRow.ready,
    environment: sandboxRow.environment,
  };
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
  const owned = usePendingTerminalOwnership(sendId, userId, surfaceKey);
  const sandboxRow = usePendingTerminalSandbox(send, stage, owned);
  const hostId = sandboxRow.hostId;
  const terminalReady = sandboxRow.ready && openTerminal !== null;
  useEffect(() => {
    if (!terminalReady || sendId === null) return;
    const { sends } = usePendingSandboxSendStore.getState();
    if (!Object.hasOwn(sends, sendId)) return;
    const current = sends[sendId];
    const currentStage = readStagedSandbox(surfaceKey);
    const decision = transitionPendingSend(
      pendingSendState(current, stageBlocker(currentStage)),
      "observe",
      pendingSandboxSendFacts(sendId, {
        ...sandboxRow.environment,
        clientReady: true,
        stageStatus: currentStage?.phase ?? "missing",
        stageCurrent:
          currentStage?.createdHostId === hostId &&
          currentStage.phase === "handoff",
      }),
    );
    if (!decision.effects.includes("open-terminal")) return;
    openTerminal();
    completePendingSandboxTerminal(sendId);
  }, [
    hostId,
    openTerminal,
    sandboxRow.environment,
    sendId,
    surfaceKey,
    terminalReady,
  ]);
}

/**
 * Ends the send and puts the message back in this task's new-agent
 * composer, opened unnamed so its picker stays live. `pick` keeps it on the
 * sandbox the send was made on (a Stop's give-back, Cancel, a model
 * recovery), staged when it rests so the composer's Send wakes it again;
 * `null` leaves the person to pick a host. `restage` stages the same
 * sandbox's shape there, for a shape change. A fork has no message to put
 * back: it ends, and the chat it came from is where to fork again.
 */
function endSendBackToComposer(input: {
  readonly send: PendingSandboxSend;
  readonly stage: StagedSandbox;
  readonly tabId: string;
  readonly restage: boolean;
  readonly pick: ReturnedSandboxPick | null;
  readonly modelPickerHarnessId?: GuiHarnessId;
}): ReturnedPendingSandboxSend {
  const { send } = input;
  if (
    input.modelPickerHarnessId !== undefined &&
    isNewConversationDraftOccupied(
      useNewConversationModalStore.getState().draftPatchesByEpicId[send.epicId],
    )
  )
    return { kind: "none" };
  const returned =
    input.pick === null
      ? returnPendingSandboxSend(send.id)
      : returnPendingSandboxSendToSandbox(send.id, input.pick);
  if (Object.hasOwn(usePendingSandboxSendStore.getState().sends, send.id))
    return returned;
  // A task that never came to be: its start-task draft holds the message.
  if (
    send.request.kind === "message" ||
    send.request.kind === "fork" ||
    returned.kind === "landing-draft"
  ) {
    return returned;
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
    // Unnamed: a named host stages nothing, and refuses to send while it rests.
    hostId: null,
    modelPickerHarnessId: input.modelPickerHarnessId,
  });
  return returned;
}

/**
 * The settled setup line above an agent whose first message waited for its
 * sandbox: `Sandbox ready · name · 24 s`, its expansion the sandbox's idle
 * rule. Nothing for any other agent.
 */
export function SandboxReadyLineForChat(props: {
  readonly chatId: string;
}): ReactNode {
  const userId = useAuthStore((state) => state.profile?.userId ?? null);
  const delivered = usePendingSandboxSendStore(
    (state) =>
      Object.values(state.sends).find(
        (send) =>
          send.userId === userId && send.delivery?.chatId === props.chatId,
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
