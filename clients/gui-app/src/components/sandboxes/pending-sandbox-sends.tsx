import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { v5 as uuidv5 } from "uuid";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useShallow } from "zustand/react/shallow";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import type { HostSandboxState } from "@traycer/protocol/host/host-status";
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
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { useConfigurationProvidersOpener } from "@/hooks/sandboxes/use-open-configuration-providers";
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
import { startSandboxWake } from "@/lib/sandboxes/sandbox-wake";
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
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import { readLocalHostIdSnapshot } from "@/lib/host/local-host-id-snapshot";
import { readNegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";
import { guiHarnessIdToProviderId } from "@/lib/provider-ordering";
import {
  completePendingSandboxTerminal,
  canWithdrawPendingSandboxSend,
  returnPendingSandboxSend,
  requestedAgentReadiness,
  type RequestedAgentReadiness,
} from "@/lib/sandboxes/pending-sandbox-send";
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
  useStagedSandbox,
  useStagedSandboxStore,
  type HandoffOwnerWatch,
  type StagedSandbox,
  type StagedSandboxFailure,
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
  type PendingSendTransition,
} from "@/lib/sandboxes/pending-sandbox-send-transition";

/** How often a waiting send re-reads the requested agent's readiness. */
const READINESS_POLL_MS = 2_000;
const STOP_INTENT_CODE = "pending-send-stop";
const stopsInFlight = new Set<string>();
const stopAttention = new Map<
  string,
  { readonly userId: string | null; readonly giveBack: () => void }
>();

/** Attention is local to the requesting mounted strip and never persisted. */
function returnStoppedPendingSend(id: string): void {
  const attention = stopAttention.get(id);
  if (
    attention !== undefined &&
    attention.userId === (useAuthStore.getState().profile?.userId ?? null)
  )
    attention.giveBack();
  else returnPendingSandboxSend(id);
}

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
  return <PendingSendDelivery send={send} stage={stage} />;
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
    fallbackName: stagedSandboxFallbackName(send.text),
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
    )
      returnPendingSandboxSend(id);
    if (plan.effects.includes("rehydrate"))
      void usePendingSandboxSendStore.persist.rehydrate();
  }, [id, send, stage]);
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
  const runner = useStagedSandboxRunner();
  const surfaceKey = pendingSendSurfaceKey(send.id);
  const sandbox = useWatchedSandboxRow(
    stage.createdSandboxId,
    surfaceKey,
    send,
  );
  const { client, requested, model, environment } = usePendingDeliveryReadiness(
    send,
    stage,
    sandbox.environment,
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
    const resolved = pendingStageObservation(send.id, stage, environment);
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
}

/** Resolve and acknowledge the current mailbox before executing any accepted intent. */
function pendingStageObservation(
  id: string,
  captured: StagedSandbox,
  environment: PendingSendFacts,
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
  return { send, stage, action, manualRetry: requestedRetry, decision };
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
  const { send, stage, action, manualRetry, decision } = plan;
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
    returnPendingSandboxSend(send.id);
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
      requested.readiness.kind,
      requested.readiness.kind === "setup-failed"
        ? requested.readiness.detail
        : null,
    );
  }
  if (decision.effects.includes("fetch-model")) refetchModel();
  if (decision.effects.includes("report-not-sent")) notSent(surfaceKey);
  if (!decision.effects.includes("prepare")) return;
  if (current.failure !== null)
    useStagedSandboxStore.getState().report(surfaceKey, { failure: null });
  preparePendingReadySend({
    send,
    stage: current,
    client,
    model: model.model,
    profiles: requested.profiles,
  });
}

/** Executes preparation against the same destination observation the kernel authorized. */
function preparePendingReadySend(input: {
  readonly send: PendingSandboxSend;
  readonly stage: StagedSandbox;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly model: string | null;
  readonly profiles: ReadonlyArray<ProviderProfile> | undefined;
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
    });
  else if (client !== null)
    prepareAndDeliverSend({ send, hostId, client, settings });
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
): {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly requested: PendingAgentReadiness;
  readonly model: PendingDefaultModel;
  readonly environment: PendingSendFacts;
} {
  const client = useHostClientForHostId(stage?.createdHostId ?? null);
  const active = stage?.phase === "handoff" && send.request.kind !== "terminal";
  const requested = useRequestedAgentOnHost(
    active ? client : null,
    active,
    send.settings.harnessId,
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
  const models = useGuiHarnessModelsQueryForClient(client, harnessId, null, {
    // Observe the shared cache; only the kernel's fetch-model effect reads it.
    enabled: false,
    subscribed: client !== null,
  });
  const model =
    client === null
      ? null
      : (findDefaultModel(models.data?.models ?? [])?.slug ?? null);
  const identity = `${sendId}:${hostId ?? ""}:${harnessId}`;
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
      return failure.code === STOP_INTENT_CODE ? "stop" : "settings";
    case "no-provider":
    case "agent-setup-failed":
      return "provider";
    case "failed":
      return failure.code === "wake" ? "wake" : "not-sent";
    default:
      return "not-sent";
  }
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
} {
  const stage = readStagedSandbox(surfaceKey) ?? send?.stopStage ?? null;
  const row = usePendingSandboxRowFacts(
    sandboxId,
    send?.userId ?? null,
    stage?.createdHostId ?? null,
    send === null ? null : send.id,
  );
  const environment = sandboxEnvironment(row, {
    ...UNKNOWN_PENDING_SEND_FACTS,
    clientReady: true,
    stageStatus: stage?.phase ?? "missing",
    stageCurrent: stage?.phase === "handoff",
    wakeInFlight: stagedRunActive(surfaceKey),
  });
  const decision =
    send === null
      ? null
      : transitionPendingSend(
          pendingSendState(send, stageBlocker(stage)),
          sandboxObservation(stageBlocker(stage), environment),
          pendingSandboxSendFacts(send.id, environment),
        );
  const wake = useStagedSandboxWaker();
  useEffect(() => {
    if (send === null || decision === null) return;
    projectSandboxBlocker(surfaceKey, decision.state.blocker, row.failure);
    if (decision.effects.includes("open-terminal") && stage?.failure !== null) {
      useStagedSandboxStore.getState().report(surfaceKey, { failure: null });
    }
    if (decision.effects.includes("wake")) wake(surfaceKey);
    if (decision.effects.includes("end-host")) {
      if (
        usePendingSandboxSendStore
          .getState()
          .endDispatch(send.id, null, "terminal-row", environment)
      ) {
        if (send.stopRequested === true) returnStoppedPendingSend(send.id);
        else returnPendingSandboxSend(send.id);
      }
    }
    if (decision.effects.includes("rehydrate"))
      void usePendingSandboxSendStore.persist.rehydrate();
    if (
      decision.effects.includes("return-message") ||
      decision.effects.includes("remove")
    ) {
      if (send.stopRequested === true) returnStoppedPendingSend(send.id);
      else returnPendingSandboxSend(send.id);
    }
  }, [
    decision,
    environment,
    row.failure,
    send,
    stage?.failure,
    surfaceKey,
    wake,
  ]);
  return {
    failed: row.failure !== null,
    ready: row.ready,
    refetch: row.refetch,
    environment,
  };
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
 * Whether the requested agent cannot take the message yet: still waiting,
 * or unable to run there, in which case that is said on the line.
 */
function agentNotReady(
  surfaceKey: string,
  failure: StagedSandbox["failure"],
  readinessKind: RequestedAgentReadiness["kind"],
  failureDetail: string | null,
): void {
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
    settingsReady: row.row?.guestConfigured !== false,
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
  return { dispatchAllowed: plan.effects.includes("dispatch"), environment };
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
    registerDispatchHandoff(send, dispatch);
    const response = await createChat(dispatch.input);
    if (response.refusal !== undefined) {
      refusePendingDispatch(send, dispatch);
      return;
    }
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

function PendingDispatchLine(props: {
  readonly id: string;
  readonly userId: string | null;
  readonly dispatch: PendingSandboxSendDispatch;
}): ReactNode {
  const row = usePendingSandboxRowFacts(
    props.dispatch.delivery.sandboxId,
    props.userId,
    props.dispatch.input.hostId,
    props.id,
  );
  const client = useHostClientForHostId(props.dispatch.input.hostId);
  const send = usePendingSandboxSendStore(
    (state): PendingSandboxSend | null => state.sends[props.id] ?? null,
  );
  if (send === null) return null;
  const environment = sandboxEnvironment(row, {
    ...UNKNOWN_PENDING_SEND_FACTS,
    clientReady: client !== null,
    inFlight: dispatchesInFlight.has(props.id),
    agentReady: true,
    modelReady: true,
  });
  const { view } = transitionPendingSend(
    pendingSendState(send, "none"),
    sandboxObservation(props.dispatch.blocker ?? "none", environment),
    pendingSandboxSendFacts(props.id, environment),
  );
  const copy: Readonly<Record<typeof view.line, string>> = {
    hidden: "",
    waiting: "Waiting for the sandbox…",
    creating: "Creating agent…",
    uncertain: "Couldn't confirm the agent was created.",
    credits: "Add credits to resume this sandbox.",
    settings: "Repair the sandbox's settings to continue.",
    "not-sent": "Couldn't resume this sandbox.",
    model: "Waiting for a model…",
    provider: "Waiting for the agent…",
    delivered: "Agent ready.",
  };
  return (
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
      <span>{copy[view.line]}</span>
      {view.line === "credits" || view.line === "settings" ? (
        <PendingDispatchRemedy
          id={props.dispatch.delivery.sandboxId}
          userId={props.userId}
          row={row.row}
          failure={view.line}
        />
      ) : null}
      {view.canRetry ? (
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
  );
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
      {props.failure === "credits" ? "Add credits" : "Repair settings"}
    </Button>
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
    fallbackName: stagedSandboxFallbackName(send.text),
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
      returnStoppedPendingSend(id);
    }
    return;
  }
  const boundary =
    usePendingSandboxSendStore.getState().sends[id]?.stopRequestedAt ?? null;
  requested();
  void refresh();
  stopsInFlight.add(id);
  try {
    const outcome = await stop();
    const host = stoppedHostObservation(outcome);
    const settled = pendingStopDecision(id, "stop-result", host, boundary);
    if (settled?.effects.includes("remove")) returnStoppedPendingSend(id);
  } catch {
    // The mutation owns the line's error. Its existing persisted latch holds
    // the only message copy, and the row watcher keeps polling for rest.
    pendingStopDecision(id, "stop-failed", "unknown", boundary);
  } finally {
    stopsInFlight.delete(id);
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

function PendingStopLine(props: {
  readonly costLine: string;
  readonly pending: boolean;
  readonly error: Error | null;
  readonly canWithdraw: boolean;
  readonly stop: () => void;
  readonly giveBack: () => void;
}): ReactNode {
  return (
    <div data-testid="sandbox-setup-line" className="flex flex-col gap-2">
      <p className="m-0">{props.costLine}</p>
      <span>{props.error?.message ?? "Waiting for the sandbox to stop."}</span>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="link"
          size="inline-xs"
          data-testid="sandbox-setup-stop"
          disabled={props.pending || !props.canWithdraw}
          onClick={props.stop}
        >
          Stop
        </Button>
        <Button
          type="button"
          variant="link"
          size="inline-xs"
          data-testid="sandbox-setup-cancel"
          disabled={!props.canWithdraw}
          onClick={props.giveBack}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="link"
          size="inline-xs"
          data-testid="sandbox-setup-choose-another-host"
          disabled={!props.canWithdraw}
          onClick={props.giveBack}
        >
          Choose another host
        </Button>
      </div>
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
  const observedStage = useStagedSandbox(surfaceKey);
  const stage = observedStage ?? send.stopStage ?? null;
  const attention = useRef<{
    readonly userId: string | null;
    readonly giveBack: () => void;
  } | null>(null);
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
  const verb = useSandboxVerb(stage?.createdSandboxId ?? "");
  const sandboxList = useSandboxList();
  const { openTile } = useEpicTileNavigation();
  const providersOpener = useConfigurationProvidersOpener(
    stage?.target.configuration.kind === "team",
  );
  const epicId = send.epicId;
  const text = send.text;
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
        fallbackName: stagedSandboxFallbackName(text),
        taskId: epicId,
        resume: false,
      });
    },
    [epicId, runner, send.id, surfaceKey, text],
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
  const stop = (): void => {
    void stopPendingSend(
      send.id,
      () => verb.mutateAsync("stop"),
      () => {
        attention.current = {
          userId: send.userId,
          giveBack: () => backToComposer(false),
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
  return (
    <div
      className="flex w-full flex-col gap-2"
      data-testid="pending-sandbox-send"
    >
      {pendingSendState(send, stageBlocker(stage)).blocker === "stop" ? (
        <PendingStopLine
          costLine={facts.costLine}
          pending={verb.isPending}
          error={verb.error}
          canWithdraw={canWithdraw}
          stop={stop}
          giveBack={() => backToComposer(false)}
        />
      ) : (
        <SandboxSetupLine
          withdrawalAllowed={canWithdraw}
          stage={stage}
          name={name}
          facts={facts}
          actions={{
            onKeepWaiting: () => retrySend("keep-waiting"),
            onCancel: () => backToComposer(false),
            onChooseAnotherHost: () => backToComposer(false),
            onRetryCreation: () => retrySend("retry-creation"),
            onRetry: () => retrySend("retry-stage"),
            onSendAgain: () => retrySend("send-again"),
            onChangeShape: () => backToComposer(true),
            onRetryApplying: newHost.onRetryApplying,
            onStop: stop,
            onOpenTerminal: newHost.onOpenTerminal,
            // The configuration's own Providers, a team's included.
            onOpenProviders: providersOpener(stage.target.configuration),
          }}
        />
      )}
      {send.request.kind === "chat" ? (
        <PendingSandboxMessage text={send.text} />
      ) : null}
    </div>
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
