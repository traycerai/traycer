import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { accountContextSchema } from "@traycer/protocol/common/schemas";
import { SandboxRetryApplyingButton } from "@/components/sandboxes/sandbox-retry-applying-button";
import { SandboxOperationFailure } from "@/components/hosts/sandbox-operation-failure";
import { unnamedTeamCreditsRanOut } from "@/components/hosts/sandbox-card-model";
import {
  useComposerSurfaceHostKey,
  useComposerSurfaceHostPin,
} from "@/hooks/host/use-composer-surface-host-pin";
import { useSurfaceHostPinWithDefault } from "@/hooks/host/use-surface-host-pin";
import { useSandboxOperation } from "@/hooks/sandboxes/use-sandbox-operation";
import { useStageFallbackHostLine } from "@/hooks/sandboxes/use-stage-fallback-host-line";
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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  cancelSandboxWakeReads,
  knownSandboxRowCurrent,
  knownSandboxRowQueryOptions,
  sandboxListObservationId,
  sandboxRowNotFound,
  type SandboxRowRead,
} from "@/lib/sandboxes/sandbox-row-read";
import type { AuthService } from "@/lib/auth/auth-service";
import { useIsMutatingOf } from "@/hooks/use-mutation-state-of";
import { v4 as uuidv4, v5 as uuidv5 } from "uuid";
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
import {
  pendingStageAttemptCurrent,
  type PendingStagePress,
  type PendingStageRetryRequest,
} from "@/lib/sandboxes/pending-stage-storage";
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
import { RestedTaskMessageLine } from "@/components/sandboxes/rested-task-message-line";
import {
  StoppedSandboxSendReceipts,
  StoppedSandboxSendReceiptStrip,
} from "@/components/sandboxes/stopped-sandbox-send-receipts";
import {
  openStagedShapeSheet,
  restingVerb,
  stagedShapeChangeAction,
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
  pendingSandboxTerminalId,
  type TerminalLaunchTarget,
} from "@/components/epic-canvas/sidebar/new-terminal-tile-ref";
import { useFolderlessTerminalTarget } from "@/components/epic-canvas/sidebar/use-folderless-terminal-target";
import { findDefaultModel } from "@/components/home/data/landing-options";
import { chatForkTargetSupport } from "@/components/chat/chat-fork-target";
import { resolveBase64ByHash } from "@/components/home/hooks/use-landing-composer-actions";
import {
  useEpicCreateChatForPendingSandbox,
  type PendingSandboxCreateChatMutationInput,
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
import {
  getEpicTerminalDurableCreateJobsSnapshot,
  subscribeEpicTerminalDurableCreates,
  type PendingTerminalCreateIssue,
} from "@/lib/terminals/epic-terminal-durable-create-coordinator";
import { fetchIsolatedLegacyTerminalList } from "@/lib/terminals/epic-terminal-silent-create";
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
  usePendingSandboxStop,
  type SandboxVerbOutcome,
} from "@/hooks/sandboxes/use-sandbox-verb-mutation";
import { SandboxOperationError } from "@/hooks/sandboxes/sandbox-failure-copy";
import { useBillingUrlOf } from "@/hooks/sandboxes/use-configuration-billing-url";
import { useOffersAddCredits } from "@/hooks/sandboxes/use-team-billing-admin";
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
  useStoppedSandboxSendReceiptStore,
} from "@/stores/sandboxes/stopped-sandbox-send-receipt-store";
import { startPendingSandboxWake } from "@/lib/sandboxes/sandbox-wake";
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
import {
  removedProfilesForProvider,
  type RemovedProviderProfile,
} from "@/components/providers/provider-profile-model";
import { startVisibleInterval } from "@/lib/dom/visible-interval";
import { currentDraftBlobOwnerId } from "@/lib/drafts/draft-blob-transport";
import { draftImageByteTargetForHost } from "@/lib/drafts/draft-image-byte-target";
import type {
  NestedFocusProvenance,
  NavigateNestedFocus,
} from "@/lib/epic-nested-focus-navigation";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import { readLocalHostIdSnapshot } from "@/lib/host/local-host-id-snapshot";
import { readNegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";
import { guiHarnessIdToProviderId } from "@/lib/provider-ordering";
import { useBrowserSandboxCancelComposer } from "@/lib/sandboxes/browser-sandbox-cancel-composer";
import {
  canWithdrawPendingSandboxSend,
  readPendingSandboxReturnReceipt,
  resolvePendingSandboxBrowserCancel,
  returnPendingSandboxSend,
  returnPendingSandboxAfterHeldHostEnd,
  subscribeToPendingSandboxReturnTargetAdmission,
  returnPendingSandboxWithEvidence,
  resumePendingSandboxMessageReturn,
  returnPendingSandboxMessage,
  returnPendingSandboxSendToDraft,
  returnPendingSandboxSendToSandbox,
  returnPendingSandboxSendOnItsSandbox,
  pendingSandboxRecoveryDraftId,
  requestedAgentReadiness,
  stagedSandboxDestination,
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
  teamCreditsRanOutLine,
} from "@/lib/sandboxes/sandbox-strings";
import { sandboxSupportReference } from "@traycer/protocol/host/sandbox-control";
import { sandboxMutationKeys } from "@/lib/query-keys";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { toastFromHostError } from "@/lib/host-error-toast";
import { REMOVED_PROFILE_PIN_TEXT } from "@/components/providers/profile-sync-copy";
import {
  holdPendingSandboxSendOwnership,
  ownsPendingSandboxSend,
  ownsPendingSandboxSendExclusively,
} from "@/lib/sandboxes/pending-sandbox-send-ownership";
import {
  acceptedSandboxSetupFailure,
  settleVerdict,
  stagedRunActive,
} from "@/lib/sandboxes/staged-sandbox-run";
import {
  captureDraftAuthorityActor,
  draftAuthorityActorIsCurrent,
} from "@/lib/drafts/draft-authority-session";
import type { DraftAuthorityActor } from "@/lib/drafts/draft-authority-types";
import type {
  DraftAuthorityHostEndEvidence,
  DraftAuthorityIssueReceipt,
  DraftAuthorityReturnDisposition,
  DraftAuthorityStopOutcome,
} from "@/lib/drafts/draft-authority-pending";
import {
  cancelPendingSandboxIdleOutbox,
  claimPendingSandboxOutboxEffect,
  finishPendingSandboxTerminal,
  holdPendingSandboxOutboxEnd,
  holdPendingSandboxOutboxStop,
  loadPendingSandboxOutbox,
  materializePendingSandboxBoundWire,
  readPendingSandboxBoundSubmission,
  pendingSandboxBrowserCancelCanRetry,
  pendingSandboxBrowserCancelInFlight,
  pendingSandboxDispatchEffect,
  pendingSandboxStopSettlement,
  reconcilePendingSandboxDispatch,
  resumePendingSandboxOutboxReturn,
  restorePendingSandboxOutboxCustody,
  retainPendingSandboxDispatchRetry,
  settlePendingSandboxOutboxEffect,
  settlePendingSandboxOutboxEnd,
  settlePendingSandboxOutboxStop,
  startPendingSandboxOutboxProjection,
  subscribeToPendingSandboxBrowserCancel,
  subscribeToPendingSandboxDestroy,
  transferPendingSandboxOutbox,
  verifyPendingSandboxOutboxGrant,
  verifyPendingSandboxOutboxStop,
  type PendingSandboxBoundWire,
} from "@/lib/sandboxes/pending-sandbox-authority";
import { useAccountContextStore } from "@/stores/auth/account-context-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  holdHandoffOwner,
  readStagedSandbox,
  newStagedSandboxKey,
  sameStagedSandboxAttempt,
  stagedCancelStartsOver,
  stagedCreateAttemptKey,
  stagedCreateRetryPayload,
  stagedFailedSandboxId,
  stagedRetryKey,
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
import { useEpicSessionHostIdForEpic } from "@/lib/registries/epic-session-registry";
import {
  pendingSendSurfaceKey,
  readPendingSandboxSend,
  usePendingSandboxSendStore,
  type PendingSandboxSend,
  type PendingSandboxSendDispatch,
  type PendingSandboxSendRequest,
  pendingSandboxSendFacts,
  pendingSandboxStopCurrent,
  pendingSandboxDispatchCurrent,
  pendingDispatchWakeCurrent,
  completePendingDispatchWake,
} from "@/stores/sandboxes/pending-sandbox-send-store";

import {
  pendingSendState,
  transitionPendingSend,
  UNKNOWN_PENDING_SEND_FACTS,
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
interface PendingStopAttempt {
  readonly operationId: string;
  returned: boolean;
}

const stopsInFlight = new Map<string, PendingStopAttempt>();
interface StopAttention {
  readonly userId: string | null;
  readonly tabId: string;
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

const stoppedReturnsInFlight = new Set<string>();

type LegacyStopRestEvidence = Extract<
  NonNullable<DraftAuthorityReturnDisposition["evidence"]>,
  { kind: "legacy-stop-rest" }
>;

interface LegacyStopRestReturn {
  readonly actor: DraftAuthorityActor;
  readonly expectedGeneration: number;
  readonly evidence: LegacyStopRestEvidence;
  readonly isRowCurrent: () => boolean;
}

/** Attention is local to the requesting mounted strip and never persisted. */
async function returnStoppedPendingSend(
  id: string,
  rowState: HostSandboxState | null,
  legacy: LegacyStopRestReturn | undefined,
): Promise<void> {
  if (stoppedReturnsInFlight.has(id)) return;
  const send = readPendingSandboxSend(id);
  const actor = legacy?.actor ?? captureDraftAuthorityActor();
  if (
    send === undefined ||
    actor === null ||
    actor.accountId !== send.userId ||
    !draftAuthorityActorIsCurrent(actor)
  )
    return;
  const attention = stopAttention.get(id);
  const localAttention = attention?.userId === actor.accountId ? attention : undefined;
  const stage = readStagedSandbox(pendingSendSurfaceKey(id)) ?? send.stopStage;
  const destinationState =
    localAttention === undefined || rowState === "suspended" ? rowState : "stopped";
  const pick =
    send.request.kind !== "message" &&
    stage !== undefined &&
    (localAttention !== undefined || rowState === "suspended")
      ? returnedSandboxPick(send, stage, destinationState)
      : null;
  const saveInDrafts = localAttention === undefined && pick === null;
  stoppedReturnsInFlight.add(id);
  try {
    const outbox = await loadPendingSandboxOutbox(actor, send);
    if (outbox === null || !draftAuthorityActorIsCurrent(actor)) return;
    let returned: ReturnedPendingSandboxSend;
    if (outbox.decision.kind === "stopping") {
      if (pendingSandboxStopSettlement(outbox) === undefined) return;
      const { stop } = outbox.decision;
      if (
        send.stopOperationId !== stop.operationId ||
        (stage !== undefined &&
          (stage.attemptId !== stop.attemptId ||
            stage.createdHostId !== stop.hostId ||
            stage.createdSandboxId !== stop.sandboxId))
      )
        return;
      returned = await returnPendingSandboxWithEvidence({
        actor,
        sendId: id,
        expectedGeneration: outbox.generation,
        saveInDrafts,
        pick,
        evidence: { kind: "stop", operationId: stop.operationId },
      });
    } else if (outbox.decision.kind === "held" && outbox.decision.reason === "stop") {
      if (
        legacy === undefined ||
        outbox.generation !== legacy.expectedGeneration ||
        !legacy.isRowCurrent() ||
        !stageObservationCurrent(pendingSendSurfaceKey(id), stage ?? null, outbox.send.stopStage)
      )
        return;
      returned = await returnPendingSandboxWithEvidence({
        actor,
        sendId: id,
        expectedGeneration: legacy.expectedGeneration,
        saveInDrafts,
        pick,
        evidence: legacy.evidence,
      });
    } else if (legacy !== undefined) {
      return;
    } else if (send.request.kind === "message") {
      returned = await returnPendingSandboxMessage(id, saveInDrafts, false);
    } else if (pick !== null) {
      returned = await returnPendingSandboxSendToSandbox(id, pick);
    } else {
      returned = await returnPendingSandboxSendToDraft(id);
    }
    if (
      !draftAuthorityActorIsCurrent(actor) ||
      returned.kind === "none" ||
      returned.kind === "dispatching"
    )
      return;
    const attempt = stopsInFlight.get(id);
    if (attempt !== undefined) attempt.returned = true;
    if (stage !== undefined) {
      recordStopReceipt(send, stage, returned, rowState);
      if (localAttention !== undefined && returned.kind === "task") {
        openReturnedPendingComposer({
          send,
          stage,
          tabId: localAttention.tabId,
          restage: false,
          modelPickerHarnessId: undefined,
          returned,
        });
      }
    }
    if (stopAttention.get(id) === attention) stopAttention.delete(id);
  } finally {
    stoppedReturnsInFlight.delete(id);
  }
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
  useEffect(() => {
    if (userId !== null) return startPendingSandboxOutboxProjection(userId);
  }, [userId]);
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
    const mounted = (): boolean => !disposed;
    const alreadyOwned = ownsPendingSandboxSend(props.id);
    const ownership = holdPendingSandboxSendOwnership(props.id);
    void ownership.ready.then(async (granted) => {
      if (!mounted() || !granted) return;
      const actor = captureDraftAuthorityActor();
      const send = readPendingSandboxSend(props.id);
      const stillExclusive = (): boolean =>
        !disposed && ownsPendingSandboxSendExclusively(props.id);
      if (!alreadyOwned && actor !== null && send?.userId === actor.accountId &&
          stillExclusive())
        await restorePendingSandboxOutboxCustody(actor, send, stillExclusive);
      if (mounted()) setOwned(true);
    }).catch(() => {
      if (mounted() && ownsPendingSandboxSend(props.id)) setOwned(true);
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
  if (send?.outboxReturnId !== undefined)
    return (
      <PendingOutboxReturnDriver send={send} returnId={send.outboxReturnId} />
    );
  if (send?.outboxHeldHostEnd === true)
    return <PendingHeldHostEndDriver send={send} />;
  if (send?.outboxStopSettlement !== undefined)
    return <PendingOutboxStopReturnDriver send={send} />;
  if (send?.returnRequested !== undefined)
    return <PendingMessageReturnDriver send={send} />;
  return <ActivePendingSendDriver {...props} />;
}

function isTerminalSandboxRow(row: SandboxSummary): boolean {
  return row.state === "destroyed" || row.state === "failed";
}

function PendingHeldHostEndDriver(props: {
  readonly send: PendingSandboxSend;
}): ReactNode {
  const { send } = props;
  const binding = useHostBinding();
  const auth = binding?.auth ?? null;
  useEffect(() => {
    const actor = captureDraftAuthorityActor();
    if (actor === null || actor.accountId !== send.userId || auth === null) return;
    let mounted = true;
    let running = false;
    let requested = false;
    const current = (): boolean =>
      mounted && draftAuthorityActorIsCurrent(actor) &&
      ownsPendingSandboxSend(send.id);
    const attemptReturn = async (): Promise<void> => {
      const outbox = await loadPendingSandboxOutbox(actor, send);
      if (
        !current() ||
        outbox === null ||
        outbox.generation !== send.outboxGeneration ||
        outbox.decision.kind !== "held" ||
        outbox.decision.reason !== "host-end"
      )
        return;
      const { evidence } = outbox.decision;
      const row = await auth.getSandbox(evidence.sandboxId);
      if (!current()) return;
      if (row.kind === "ok") {
        if (
          row.sandbox.id !== evidence.sandboxId ||
          row.sandbox.hostId !== evidence.hostId ||
          !isTerminalSandboxRow(row.sandbox)
        )
          return;
      } else if (!sandboxRowNotFound(row) || evidence.kind !== "settled-destroy") {
        return;
      }
      const verified = await loadPendingSandboxOutbox(actor, send);
      if (
        !current() ||
        verified === null ||
        verified.generation !== outbox.generation ||
        JSON.stringify(verified.decision) !== JSON.stringify(outbox.decision)
      )
        return;
      const stage = readStagedSandbox(pendingSendSurfaceKey(send.id));
      const returned = await returnPendingSandboxAfterHeldHostEnd({
        actor,
        sendId: send.id,
        expectedGeneration: verified.generation,
      });
      if (
        stage !== null &&
        send.request.kind === "chat" &&
        returned.kind !== "none" &&
        returned.kind !== "dispatching" &&
        draftAuthorityActorIsCurrent(actor)
      )
        recordSandboxStateSend(send, stage, returned, "ended");
    };
    const wake = (): void => {
      requested = true;
      if (running) return;
      running = true;
      void (async () => {
        while (requested && current()) {
          requested = false;
          await attemptReturn().catch(() => undefined);
        }
      })().finally(() => { running = false; });
    };
    const unsubscribe = subscribeToPendingSandboxReturnTargetAdmission(
      { accountId: actor.accountId, sendId: send.id },
      wake,
    );
    wake();
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [auth, send]);
  return null;
}

const mountedOutboxReturns = new Map<string, Promise<boolean | null>>();

function resumeMountedOutboxReturn(
  actor: DraftAuthorityActor,
  send: PendingSandboxSend,
  returnId: string,
  retryBrowser: boolean,
): Promise<boolean | null> {
  const sendId = send.id;
  const inBrowser = pendingSandboxBrowserCancelInFlight(actor, sendId, returnId);
  const expectedGeneration = send.outboxGeneration;
  if (
    inBrowser &&
    (!retryBrowser ||
      expectedGeneration === undefined ||
      !pendingSandboxBrowserCancelCanRetry(actor, sendId, returnId, expectedGeneration))
  )
    return Promise.resolve(null);
  const key = JSON.stringify([actor.accountId, actor.sessionGeneration, sendId, returnId]);
  const running = mountedOutboxReturns.get(key);
  if (running !== undefined) return running;
  const resume = (): Promise<boolean | null> => {
    if (inBrowser && expectedGeneration !== undefined)
      return resolvePendingSandboxBrowserCancel({
        actor, sendId, returnId, expectedGeneration,
      }).then((outcome) =>
        outcome === "unverified"
          ? null
          : outcome === "installed" ||
            !Object.hasOwn(usePendingSandboxSendStore.getState().sends, sendId),
      );
    return resumePendingSandboxOutboxReturn(actor, sendId, returnId)
      .then(async ({ publication, retired }) => {
        if (
          !retired ||
          !draftAuthorityActorIsCurrent(actor) ||
          (publication.kind !== "committed" && publication.kind !== "replayed")
        )
          return false;
        const returned = await readPendingSandboxReturnReceipt({
          actor,
          sendId,
          returnId,
          receipt: publication.receipt,
        }).catch(() => null);
        if (
          returned !== null &&
          draftAuthorityActorIsCurrent(actor) &&
          !Object.hasOwn(useStoppedSandboxSendReceiptStore.getState().receipts, sendId)
        )
          recordRecoveredSandboxSend(send, returned);
        return true;
      });
  };
  const attempt = resume().finally(() => mountedOutboxReturns.delete(key));
  mountedOutboxReturns.set(key, attempt);
  return attempt;
}

function PendingOutboxReturnDriver(props: {
  readonly send: PendingSandboxSend;
  readonly returnId: string;
}): ReactNode {
  const { send, returnId } = props;
  useEffect(() => {
    const resume = (retryBrowser: boolean): void => {
      const actor = captureDraftAuthorityActor();
      if (actor === null || actor.accountId !== send.userId) return;
      void resumeMountedOutboxReturn(actor, send, returnId, retryBrowser)
        .catch(() => undefined);
    };
    const retryOnFocus = (): void => resume(true);
    resume(false);
    window.addEventListener("focus", retryOnFocus);
    return () => window.removeEventListener("focus", retryOnFocus);
  }, [send, returnId]);
  return null;
}

function PendingOutboxStopReturnDriver(props: {
  readonly send: PendingSandboxSend;
}): ReactNode {
  const { send } = props;
  useEffect(() => {
    const actor = captureDraftAuthorityActor();
    if (actor === null || actor.accountId !== send.userId) return;
    void loadPendingSandboxOutbox(actor, send)
      .then((outbox) => {
        if (outbox === null) return;
        const settled = pendingSandboxStopSettlement(outbox);
        if (settled !== undefined && draftAuthorityActorIsCurrent(actor))
          return returnStoppedPendingSend(send.id, settled === "gone" ? null : settled, undefined);
      })
      .catch(() => undefined);
  }, [send]);
  return null;
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
    executePendingStageRun(send, current, runner, null);
  }, [runner, send, stage, surfaceKey]);
}

/** The kernel's run-stage effect preserves the original terminal/send intent and key. */
function executePendingStageRun(
  send: PendingSandboxSend,
  stage: StagedSandbox,
  runner: StagedSandboxRunner,
  press: (PendingStagePress & { readonly retryRequestId?: string }) | null,
): void {
  const surfaceKey = pendingSendSurfaceKey(send.id);
  if (send.request.kind === "terminal" && !stage.openTerminal)
    useStagedSandboxStore.getState().report(surfaceKey, { openTerminal: true });
  runner(surfaceKey, {
    taskId: send.epicId,
    resume:
      press === null && stage.phase === "creating" && stage.failure === null,
    createKey: press?.createKey ?? null,
    retryCreate: press?.retryCreate,
    observedCreateKey: press?.observedCreateKey,
    observedAttemptId: press?.observedAttemptId,
    retryRequestId: press?.retryRequestId,
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
      void returnPendingSendOnItsSandbox(send, stage).then((returned) => {
        if (
          !send.epicConfirmed &&
          send.ended !== true &&
          returned.kind === "landing-draft"
        )
          recordRecoveredSandboxSend(send, returned);
      }).catch(() => undefined);
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
    stage.createdSandboxId ??
      (stage.target.kind === "existing" ? stage.target.sandboxId : null),
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
        removedProfiles: requested.removedProfiles,
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
    requested.removedProfiles,
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
  readonly press: PendingStagePress | null;
  readonly retryRequestId?: string;
  readonly decision: PendingSendTransition;
  /** The row the decision observed; a withdrawal keeps a resting sandbox. */
  readonly rowState: HostSandboxState | null;
}

function stageObservationCurrent(
  surfaceKey: string,
  shown: StagedSandbox | null,
  stopStage: StagedSandbox | undefined,
): boolean {
  const current = readStagedSandbox(surfaceKey);
  const stage = current ?? stopStage ?? null;
  if (stage === null || shown === null) return stage === shown;
  return (
    sameStagedSandboxAttempt(stage, shown) &&
    (current === null ||
      pendingStageAttemptCurrent(
        surfaceKey,
        current.clientRequestId,
        stagedCreateAttemptKey(current),
        current.attemptId,
      ))
  );
}

/** The old client minted a different identity for a fresh retry. */
function legacyMailboxAttemptMatches(
  stage: StagedSandbox,
  retry: PendingStageRetryRequest,
  currentKey: string | null,
): boolean {
  if (retry.action === "retry-creation" || retry.action === "retry-stage")
    return (
      stage.lastCreateKey === undefined &&
      stage.clientRequestId !== null &&
      !stage.clientRequestId.startsWith("stage:") &&
      (retry.createKey === undefined ||
        retry.createKey === null ||
        retry.createKey === stagedRetryKey(stage))
    );
  if (retry.createKey !== null && retry.createKey !== undefined)
    return retry.createKey === currentKey;
  return retry.action !== "keep-waiting" || stage.lastCreateKey === undefined;
}

/** A mailbox press names what the other window saw, independent of its arrival time. */
function mailboxAttemptMatches(
  stage: StagedSandbox,
  retry: PendingStageRetryRequest,
): boolean {
  if ((retry.observedAttemptId ?? null) !== (stage.attemptId ?? null))
    return false;
  const currentKey = stagedCreateAttemptKey(stage);
  if (retry.observedCreateKey === undefined)
    return legacyMailboxAttemptMatches(stage, retry, currentKey);
  // A receipt from before attempt IDs cannot identify a rowless refusal
  // after the fixed key was reused. A newly pressed legacy stage can.
  return (
    retry.observedCreateKey === currentKey &&
    (retry.observedAttemptId !== undefined ||
      stage.failure?.kind !== "unavailable")
  );
}

function retryStartsStageCreate(
  stage: StagedSandbox,
  createKey: string | null,
): boolean {
  return (
    stage.target.kind === "new" &&
    stage.phase !== "handoff" &&
    ((stage.createdSandboxId === null && stage.createdHostId === null) ||
      (stagedFailedSandboxId(stage) !== null &&
        createKey !== null &&
        createKey !== stagedCreateAttemptKey(stage)))
  );
}

function stagePressCreateKey(
  stage: StagedSandbox,
  action: PendingStageRetryAction,
): string | null {
  return action === "retry-stage" || action === "retry-creation"
    ? stagedRetryKey(stage)
    : stagedCreateAttemptKey(stage);
}

function mailboxStagePress(
  stage: StagedSandbox,
  retry: PendingStageRetryRequest,
  action: PendingStageRetryAction,
): PendingStagePress | null {
  if (!mailboxAttemptMatches(stage, retry)) return null;
  if (
    action === "retry-creation" &&
    stage.failure?.acceptedRowNotFound === true
  )
    return null;
  const createKey = stagePressCreateKey(stage, action);
  const retryCreate = stagedCreateRetryPayload(stage, createKey);
  const legacy = retry.observedCreateKey === undefined;
  if (
    !legacy &&
    ((retry.createKey !== undefined && retry.createKey !== createKey) ||
      (retry.retryCreate !== undefined &&
        JSON.stringify(retry.retryCreate) !== JSON.stringify(retryCreate)))
  )
    return null;
  return {
    createKey,
    retryCreate: retryCreate ?? (legacy ? retry.retryCreate : undefined),
    observedCreateKey: retry.observedCreateKey ?? stagedCreateAttemptKey(stage),
    observedAttemptId: retry.observedAttemptId ?? stage.attemptId ?? null,
  };
}

/** Resolve the current mailbox without writing its acknowledgement yet. */
function pendingStageObservation(
  id: string,
  captured: StagedSandbox,
  environment: PendingSendFacts,
  rowState: HostSandboxState | null,
): PendingStageObservation | null {
  const { sends } = usePendingSandboxSendStore.getState();
  if (!Object.hasOwn(sends, id)) return null;
  const send = sends[id];
  if ((send.dispatch ?? null) !== null) return null;
  const surfaceKey = pendingSendSurfaceKey(id);
  const stage = readStagedSandbox(surfaceKey);
  if (
    stage === null ||
    !stageObservationCurrent(surfaceKey, captured, undefined)
  )
    return null;
  const retry = stage.retryRequest;
  const requestedRetry =
    retry !== undefined &&
    retry.userId === send.userId &&
    retry.clientRequestId === stage.clientRequestId &&
    retry.id !== stage.retryHandledId;
  const action = retry?.action ?? "send-again";
  const press = requestedRetry ? mailboxStagePress(stage, retry, action) : null;
  const event = sandboxObservation(stageBlocker(stage), environment);
  const decision = transitionPendingSend(
    pendingSendState(send, stageBlocker(stage)),
    requestedRetry ? "consume-retry" : event,
    pendingSandboxSendFacts(id, {
      ...environment,
      stageStatus: stage.phase,
      stageCurrent: stage.phase === "handoff",
      retryAction: action,
      retryObservation: event,
      retryAttemptSuperseded: requestedRetry && press === null,
      retryStartsCreate: retryStartsStageCreate(
        stage,
        press?.createKey ?? null,
      ),
    }),
  );
  return {
    send,
    stage,
    press,
    retryRequestId: requestedRetry ? retry.id : undefined,
    decision,
    rowState,
  };
}

/** Stage work needs the captured failure; readiness retries may clear only its projection. */
function executePendingStageDecision(
  plan: PendingStageObservation,
  runner: StagedSandboxRunner,
): boolean {
  const { send, stage, press, decision, rowState } = plan;
  const retry = decision.effects.includes("retry");
  if (
    retry &&
    usePendingSandboxSendStore
      .getState()
      .holdObservation(send.id, decision, plan.retryRequestId) === null
  )
    return true;
  const running = decision.effects.includes("run-stage");
  const surfaceKey = pendingSendSurfaceKey(send.id);
  const retryRequestId = decision.effects.includes("acknowledge-retry")
    ? plan.retryRequestId
    : undefined;
  if (retryRequestId !== undefined && !(retry && running)) {
    const saved = useStagedSandboxStore
      .getState()
      .acknowledgeRetry(surfaceKey, retryRequestId, retry);
    if (!saved && retry) return true;
  } else if (retry && !running) {
    useStagedSandboxStore.getState().report(surfaceKey, { failure: null });
  }
  if (running) {
    // Accepted run intent stays in the mailbox until begin commits its key,
    // payload, and acknowledgement to the stage's record together.
    executePendingStageRun(
      send,
      stage,
      runner,
      retry && press !== null ? { ...press, retryRequestId } : null,
    );
    return true;
  }
  if (
    decision.effects.includes("return-message") ||
    decision.effects.includes("remove")
  ) {
    void returnWatchedSend(send, stage, rowState).catch(() => undefined);
    return true;
  }
  return decision.effects.includes("present-setup-failure");
}

/** Executes the query and preparation effects after the owner checked identity and mailbox. */
function executePendingReadiness(input: {
  readonly decision: PendingSendTransition;
  readonly send: PendingSandboxSend;
  readonly stage: StagedSandbox;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly requested: Pick<
    PendingAgentReadiness,
    "readiness" | "profiles" | "removedProfiles"
  >;
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
    removedProfiles: requested.removedProfiles,
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
  readonly removedProfiles: readonly RemovedProviderProfile[];
  readonly opencodeLine: OpencodeLine | null;
}): void {
  const { send, stage, client } = input;
  const settings = {
    ...send.settings,
    model: input.model ?? send.settings.model,
    profileId: resolveSeededProfileId(
      send.settings.profileId,
      input.profiles,
      input.removedProfiles,
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
      stage,
      hostId,
      client,
      settings,
      opencodeLine: input.opencodeLine,
    });
}

interface PendingAgentReadiness {
  readonly readiness: RequestedAgentReadiness | null;
  readonly profiles: ReadonlyArray<ProviderProfile> | undefined;
  readonly removedProfiles: readonly RemovedProviderProfile[];
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
  const providerId = guiHarnessIdToProviderId(harnessId);
  const profiles = useMemo(
    () =>
      providerId === null
        ? undefined
        : providerRows?.find((provider) => provider.providerId === providerId)
            ?.profiles,
    [providerId, providerRows],
  );
  const removedProfiles = useMemo(
    () => removedProfilesForProvider(providers.data, providerId),
    [providers.data, providerId],
  );
  const refetchHarnesses = harnesses.refetch;
  const refetchProviders = providers.refetch;
  const refetch = useCallback((): void => {
    void refetchHarnesses();
    void refetchProviders();
  }, [refetchHarnesses, refetchProviders]);
  return { readiness, profiles, removedProfiles, refetch };
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
    profileId: null,
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
    input.currentUserId === null ||
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

interface PendingSandboxByIdInput {
  readonly auth: AuthService | null;
  readonly sandboxId: string | null;
  readonly hostId: string | null;
  readonly userId: string | null;
  readonly send: PendingSandboxSend | null;
  readonly stage: StagedSandbox | null;
  readonly omission: number | undefined;
}

function pendingSandboxByIdOptions(input: PendingSandboxByIdInput) {
  const { auth, sandboxId, hostId, userId, send, stage, omission } = input;
  return knownSandboxRowQueryOptions({
    auth,
    userId,
    sandboxId,
    hostId,
    sendId: send?.id,
    stageId: stage?.clientRequestId,
    attemptId: stage?.attemptId,
    observationRequestedAt: send?.observationRequestedAt,
    observationRetryId: send?.observationRetryId,
    stopRequestedAt: send?.stopRequestedAt,
    omission,
  });
}

function usePendingSandboxById(
  input: PendingSandboxByIdInput,
): SandboxRowRead | null {
  const { hostId, omission } = input;
  const { data, isFetching, refetch } = useQuery(
    pendingSandboxByIdOptions(input),
  );
  const current =
    data !== undefined && knownSandboxRowCurrent(data, omission, hostId);
  useEffect(() => {
    if (omission !== undefined && data !== undefined && !current && !isFetching)
      void refetch({ cancelRefetch: false });
  }, [omission, data, current, isFetching, refetch]);
  return omission !== undefined && current ? data.read : null;
}

/** Only a successful fresh read made for this account can settle its sandbox. */
function usePendingSandboxRowFacts(
  sandboxId: string | null,
  userId: string | null,
  hostId: string | null,
  sendId: string | null,
): PendingSandboxRowFacts {
  const sessionGeneration = useSyncExternalStore(
    useAuthStore.subscribe,
    () => captureDraftAuthorityActor()?.sessionGeneration ?? null,
    () => null,
  );
  const [rowScope, setRowScope] = useState(() => ({
    sessionGeneration,
    mountedAt: Date.now(),
  }));
  useLayoutEffect(() => {
    if (rowScope.sessionGeneration !== sessionGeneration)
      setRowScope({ sessionGeneration, mountedAt: Date.now() });
  }, [rowScope.sessionGeneration, sessionGeneration]);
  const activeUserId = useAuthStore((state) => state.profile?.userId ?? null);
  const currentUserId =
    sessionGeneration !== null && sessionGeneration === rowScope.sessionGeneration
      ? activeUserId
      : null;
  const { mountedAt } = rowScope;
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
  const listed =
    rows === null ? null : (rows.find((item) => item.id === sandboxId) ?? null);
  const sentAt = sandboxListReadSentAt(sandboxList.data);
  const binding = useHostBinding();
  const auth = binding?.auth ?? null;
  const list = sandboxList.data;
  const omission =
    list && rows !== null && listed === null
      ? sandboxListObservationId(list)
      : undefined;
  const stage = useStagedSandbox(
    sendId === null ? "" : pendingSendSurfaceKey(sendId),
  );
  const read = usePendingSandboxById({
    auth,
    sandboxId,
    hostId,
    userId,
    send,
    stage,
    omission,
  });
  const row = listed ?? read?.row ?? null;
  const observation = useMemo<PendingSandboxObservation>(() => {
    if (read !== null && sandboxId !== null)
      return { kind: "by-id", sandboxId, sentAt: read.sentAt, mountedAt };
    if (listed !== null) return { kind: "list", sentAt, mountedAt };
    return { kind: "none" };
  }, [read, sandboxId, mountedAt, listed, sentAt]);
  const identityMatches = row !== null ? row.hostId === hostId : read !== null;
  useEffect(() => {
    if (
      sendId !== null &&
      sandboxId !== null &&
      row !== null &&
      identityMatches
    )
      usePendingSandboxSendStore
        .getState()
        .markSandboxRowSeen(sendId, sandboxId, observation);
  }, [sendId, sandboxId, row, identityMatches, observation]);
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
  const provenRow =
    identityMatches && (row !== null || observation.kind === "by-id");
  const host = provenRow ? pendingRowHost(row) : "unknown";
  const observedHost =
    send === null
      ? decodePendingSandboxObservation(null, host, observation)
      : pendingSandboxSendFacts(send.id, {
          ...UNKNOWN_PENDING_SEND_FACTS,
          host,
          observation,
        }).host;
  const matching = provenRow && observedHost !== "unknown";
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

function watchedSetupFailure(
  stage: StagedSandbox | null,
  sandboxId: string | null,
  row: SandboxSummary | null,
  terminal: boolean,
): StagedSandboxFailure | null {
  if (
    stage?.target.kind !== "new" ||
    (stage.phase !== "creating" && stage.phase !== "handoff") ||
    sandboxId === null ||
    stage.createdSandboxId !== sandboxId ||
    !terminal
  )
    return null;
  return acceptedSandboxSetupFailure(sandboxId, row);
}

interface PendingSetupObservationAuthority {
  readonly actor: DraftAuthorityActor;
  readonly generation: number;
}

async function readPendingSetupObservationAuthority(
  send: PendingSandboxSend,
  stage: StagedSandbox,
  environment: PendingSendFacts,
): Promise<PendingSetupObservationAuthority | null> {
  const actor = captureDraftAuthorityActor();
  if (actor === null || actor.accountId !== send.userId) return null;
  const outbox = await loadPendingSandboxOutbox(actor, send);
  const surfaceKey = pendingSendSurfaceKey(send.id);
  if (
    outbox === null ||
    outbox.ownership !== "setup" ||
    outbox.decision.kind !== "waiting" ||
    (send.outboxGeneration !== undefined &&
      send.outboxGeneration !== outbox.generation) ||
    !draftAuthorityActorIsCurrent(actor) ||
    !stageObservationCurrent(surfaceKey, stage, undefined)
  )
    return null;
  const facts = pendingSandboxSendFacts(send.id, environment);
  if (
    !facts.current ||
    !facts.owns ||
    !facts.accountActive ||
    facts.durableClaim ||
    facts.stopRequested ||
    facts.host !== "ended"
  )
    return null;
  return { actor, generation: outbox.generation };
}

async function presentWatchedSetupFailure(
  send: PendingSandboxSend,
  stage: StagedSandbox,
  failure: StagedSandboxFailure,
  environment: PendingSendFacts,
): Promise<void> {
  const authority = await readPendingSetupObservationAuthority(send, stage, environment);
  if (authority === null || !draftAuthorityActorIsCurrent(authority.actor)) return;
  useStagedSandboxStore.getState().presentSetupFailure(
    pendingSendSurfaceKey(send.id),
    stage,
    failure,
  );
}

type PendingHostEndScope = Omit<DraftAuthorityHostEndEvidence, "kind" | "proofId">;

function setupHostEndScope(
  send: PendingSandboxSend | null,
  stage: StagedSandbox | null,
): PendingHostEndScope | null {
  if (send === null || stage === null) return null;
  const existing = stage.target.kind === "existing" ? stage.target : null;
  const hostId = stage.createdHostId ?? existing?.hostId;
  const sandboxId = stage.createdSandboxId ?? existing?.sandboxId;
  const attempt = stage.authoritySetupAttempt ?? send.outboxSetupBinding;
  if (
    hostId === undefined ||
    sandboxId === undefined ||
    attempt === undefined ||
    (stage.authoritySetupAttempt === undefined &&
      send.outboxSetupBinding?.attemptId !== stage.attemptId)
  )
    return null;
  return {
    ownership: "setup",
    hostId,
    sandboxId,
    attemptId: attempt.attemptId,
    observationGeneration: attempt.observationGeneration,
  };
}

function dispatchHostEndScope(
  dispatch: PendingSandboxSendDispatch,
): PendingHostEndScope | null {
  if (dispatch.setupAttempt === undefined) return null;
  return {
    ownership: "dispatch",
    hostId: dispatch.delivery.hostId,
    sandboxId: dispatch.delivery.sandboxId,
    ...dispatch.setupAttempt,
  };
}

function signedHostEndProof(
  scope: PendingHostEndScope | null,
  row: PendingSandboxRowFacts,
): DraftAuthorityHostEndEvidence | null {
  const { observation, row: summary } = row;
  if (
    scope === null ||
    !row.known ||
    summary === null ||
    summary.hostId !== scope.hostId ||
    summary.id !== scope.sandboxId ||
    !isTerminalSandboxRow(summary) ||
    (observation.kind !== "list" && observation.kind !== "by-id") ||
    observation.sentAt === null ||
    observation.sentAt < scope.observationGeneration
  )
    return null;
  return {
    ...scope,
    kind: "signed-terminal",
    proofId: `signed-${summary.state}:${JSON.stringify([
      observation.kind,
      observation.sentAt,
      summary.hostId,
      summary.id,
    ])}`,
  };
}

function pendingHostEndCurrent(
  send: PendingSandboxSend,
  actor: DraftAuthorityActor,
): boolean {
  const current = readPendingSandboxSend(send.id);
  const facts = pendingSandboxSendFacts(send.id, UNKNOWN_PENDING_SEND_FACTS);
  return (
    send.outboxGeneration !== undefined &&
    current?.outboxGeneration === send.outboxGeneration &&
    draftAuthorityActorIsCurrent(actor) &&
    actor.accountId === send.userId &&
    facts.current &&
    facts.owns &&
    facts.accountActive &&
    !facts.stopRequested
  );
}

function usePendingDestroyEnd(
  send: PendingSandboxSend | null,
  scope: PendingHostEndScope | null,
  matchesAttempt: () => boolean,
  observe: ((evidence: DraftAuthorityHostEndEvidence) => void) | undefined,
): void {
  useLayoutEffect(() => {
    if (send === null || send.userId === null || scope === null) return;
    return subscribeToPendingSandboxDestroy(
      send.userId,
      scope.hostId,
      scope.sandboxId,
      ({ actor, proofId }) => {
        const isCurrent = (): boolean =>
          pendingHostEndCurrent(send, actor) && matchesAttempt();
        if (!isCurrent()) return null;
        const evidence: DraftAuthorityHostEndEvidence = {
          ...scope,
          kind: "settled-destroy",
          proofId,
        };
        return () => {
          if (!isCurrent()) return;
          observe?.(evidence);
          void holdPendingSandboxOutboxEnd({ actor, send, evidence, isCurrent })
            .catch(() => undefined);
        };
      },
    );
  }, [send, scope, matchesAttempt, observe]);
}

async function settleWatchedPendingStop(
  send: PendingSandboxSend,
  stage: StagedSandbox | null,
  environment: PendingSendFacts,
  row: PendingSandboxRowFacts,
  isRowCurrent: () => boolean,
): Promise<void> {
  const actor = captureDraftAuthorityActor();
  if (actor === null || actor.accountId !== send.userId || stage === null) return;
  const outbox = await loadPendingSandboxOutbox(actor, send);
  if (
    outbox === null ||
    !draftAuthorityActorIsCurrent(actor) ||
    !stageObservationCurrent(pendingSendSurfaceKey(send.id), stage, send.stopStage)
  )
    return;
  const facts = pendingSandboxSendFacts(send.id, environment);
  if (!facts.current || !facts.accountActive || !facts.owns || !facts.stopRequested)
    return;
  if (outbox.decision.kind === "held" && outbox.decision.reason === "stop") {
    const evidence = signedLegacyStopRest(outbox.send, stage, row);
    if (
      evidence !== null &&
      outbox.generation === send.outboxGeneration &&
      isRowCurrent()
    )
      await returnStoppedPendingSend(send.id, evidence.state, {
        actor,
        expectedGeneration: outbox.generation,
        evidence,
        isRowCurrent,
      });
    return;
  }
  const rowState = row.row?.state ?? null;
  const prior = pendingSandboxStopSettlement(outbox);
  if (prior !== undefined) {
    await returnStoppedPendingSend(send.id, prior === "gone" ? null : prior, undefined);
    return;
  }
  let outcome: DraftAuthorityStopOutcome | null = null;
  if (rowState === "stopped" || rowState === "suspended")
    outcome = { kind: "settled", state: rowState };
  else if (facts.host === "ended") outcome = { kind: "gone" };
  if (outcome === null) return;
  if (outbox.decision.kind === "stopping") {
    const { stop } = outbox.decision;
    if (
      stop.operationId !== send.stopOperationId ||
      outbox.generation !== send.outboxGeneration ||
      stop.sandboxId !== stage.createdSandboxId ||
      stop.hostId !== stage.createdHostId ||
      stop.attemptId !== stage.attemptId ||
      !(await settlePendingSandboxOutboxStop(actor, stop, outcome))
    )
      return;
  }
  if (draftAuthorityActorIsCurrent(actor))
    await returnStoppedPendingSend(send.id, rowState, undefined);
}

function signedLegacyStopRest(
  send: PendingSandboxSend,
  stage: StagedSandbox,
  facts: PendingSandboxRowFacts,
): LegacyStopRestEvidence | null {
  const { observation, row } = facts;
  const stoppedStage = send.stopStage;
  const boundary = send.stopRequestedAt;
  if (
    !facts.known ||
    row === null ||
    (row.state !== "stopped" && row.state !== "suspended") ||
    stoppedStage === undefined ||
    stoppedStage.attemptId === undefined ||
    stoppedStage.attemptId !== stage.attemptId ||
    stoppedStage.createdHostId !== row.hostId ||
    stoppedStage.createdSandboxId !== row.id ||
    stage.createdHostId !== row.hostId ||
    stage.createdSandboxId !== row.id ||
    boundary === undefined ||
    boundary <= 0 ||
    (observation.kind !== "list" && observation.kind !== "by-id") ||
    observation.sentAt === null ||
    observation.sentAt <= Math.max(boundary, send.observationRequestedAt ?? 0)
  )
    return null;
  return {
    kind: "legacy-stop-rest",
    hostId: row.hostId,
    sandboxId: row.id,
    attemptId: stoppedStage.attemptId,
    observationGeneration: observation.sentAt,
    state: row.state,
    proofId: JSON.stringify([
      "legacy-stop-rest", row.hostId, row.id, stoppedStage.attemptId,
      observation.kind, observation.sentAt, row.state,
    ]),
  };
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
  const scope = sandboxId === null ? null : setupHostEndScope(send, stage);
  const matchesAttempt = (): boolean =>
    stageObservationCurrent(surfaceKey, stage, undefined);
  usePendingDestroyEnd(send, scope, matchesAttempt, undefined);
  const row = usePendingSandboxRowFacts(
    sandboxId,
    send?.userId ?? null,
    stage?.createdHostId ?? scope?.hostId ?? null,
    send === null ? null : send.id,
  );
  const latestRow = useRef(row);
  useLayoutEffect(() => {
    latestRow.current = row;
  }, [row]);
  const { row: summary, terminal } = row;
  const settings = useSandboxSettingsStatus(summary);
  const rowState = summary?.state ?? null;
  const setupFailure = useMemo(
    () => watchedSetupFailure(stage, sandboxId, summary, terminal),
    [stage, sandboxId, summary, terminal],
  );
  const environment = sandboxEnvironment(row, {
    ...UNKNOWN_PENDING_SEND_FACTS,
    acceptedSetupFailure: setupFailure !== null,
    settingsReady: settings.ready,
    clientReady: true,
    stageStatus: stage?.phase ?? "missing",
    stageCurrent: stage?.phase === "handoff",
    wakeInFlight: stagedRunActive(surfaceKey),
    stageRested: stageRestedAt(stage, rowState),
  });
  useEffect(() => {
    if (send === null) return;
    const isRowCurrent = (): boolean =>
      latestRow.current.known &&
      latestRow.current.row === row.row &&
      latestRow.current.observation === row.observation;
    const current = readPendingSandboxSend(send.id);
    if (
      current === undefined ||
      (current.dispatch ?? null) !== null ||
      current.delivery !== null ||
      current.returnRequested !== undefined ||
      !stageObservationCurrent(surfaceKey, stage, current.stopStage)
    )
      return;
    const blocker = stageBlocker(
      readStagedSandbox(surfaceKey) ?? current.stopStage ?? null,
    );
    const facts = pendingSandboxSendFacts(send.id, environment);
    const decision = transitionPendingSend(
      pendingSendState(current, blocker),
      sandboxObservation(blocker, facts),
      facts,
    );
    if (decision.effects.includes("present-setup-failure")) {
      if (setupFailure !== null && stage !== null)
        void presentWatchedSetupFailure(
          current,
          stage,
          setupFailure,
          environment,
        ).catch(() => undefined);
      return;
    }
    projectSandboxBlocker(surfaceKey, decision.state.blocker, row.failure);
    if (
      facts.stageRested &&
      !decision.effects.includes("return-message") &&
      facts.host === "resting"
    )
      projectSandboxRest(surfaceKey, stage);
    if (decision.effects.includes("open-terminal"))
      clearPendingSandboxFailure(surfaceKey);
    if (decision.effects.includes("end-host")) {
      if (current.stopRequested === true)
        void settleWatchedPendingStop(current, stage, environment, row, isRowCurrent).catch(
          () => undefined,
        );
      else {
        const actor = captureDraftAuthorityActor();
        const evidence = signedHostEndProof(scope, row);
        if (actor !== null && evidence !== null) {
          const isCurrent = (): boolean =>
            pendingHostEndCurrent(send, actor) &&
            stageObservationCurrent(surfaceKey, stage, undefined) &&
            pendingSandboxSendFacts(send.id, environment).host === "ended";
          if (isCurrent())
            void holdPendingSandboxOutboxEnd({ actor, send, evidence, isCurrent })
              .catch(() => undefined);
        }
      }
      return;
    }
    if (decision.effects.includes("rehydrate"))
      void usePendingSandboxSendStore.persist.rehydrate();
    if (
      decision.effects.includes("return-message") ||
      decision.effects.includes("remove")
    ) {
      if (current.stopRequested === true)
        void settleWatchedPendingStop(current, stage, environment, row, isRowCurrent).catch(
          () => undefined,
        );
      else void returnWatchedSend(current, stage, rowState).catch(() => undefined);
    }
  }, [
    environment,
    row,
    rowState,
    scope,
    send,
    setupFailure,
    stage,
    surfaceKey,
  ]);
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
async function returnPendingSendOnItsSandbox(
  send: PendingSandboxSend,
  stage: StagedSandbox | null,
): Promise<ReturnedPendingSandboxSend> {
  const epicId = send.legacyTaskLossEpicId;
  if (epicId === undefined || epicId !== send.epicId)
    return returnPendingSandboxSendOnItsSandbox(send.id);
  const actor = captureDraftAuthorityActor();
  if (actor === null || actor.accountId !== send.userId) return { kind: "none" };
  const outbox = await loadPendingSandboxOutbox(actor, send);
  if (
    outbox === null ||
    outbox.send.legacyTaskLossEpicId !== epicId ||
    (send.outboxGeneration !== undefined && send.outboxGeneration !== outbox.generation) ||
    !draftAuthorityActorIsCurrent(actor)
  )
    return { kind: "none" };
  return returnPendingSandboxWithEvidence({
    actor,
    sendId: send.id,
    expectedGeneration: outbox.generation,
    saveInDrafts: true,
    pick: stage === null ? null : { kind: "stage", ...stagedSandboxDestination(stage) },
    evidence: { kind: "legacy-task-loss", epicId },
  });
}

async function returnWatchedSend(
  send: PendingSandboxSend,
  stage: StagedSandbox | null,
  rowState: HostSandboxState | null,
): Promise<void> {
  if (send.stopRequested === true) {
    await returnStoppedPendingSend(send.id, rowState, undefined);
    return;
  }
  // A task-loss return keeps the sandbox when the signed observation says it is live.
  if (
    send.ended === true &&
    (rowState === "awake" || restingVerb(rowState) !== null)
  ) {
    await returnPendingSendOnItsSandbox(send, stage);
    return;
  }
  if (send.request.kind !== "chat" || stage === null) {
    await returnPendingSandboxSend(send.id);
    return;
  }
  const actor = captureDraftAuthorityActor();
  if (actor === null || actor.accountId !== send.userId) return;
  const resting = restingVerb(rowState) !== null;
  const returned = resting
    ? await returnPendingSandboxSendToSandbox(
        send.id,
        returnedSandboxPick(send, stage, rowState),
      )
    : await returnPendingSandboxSend(send.id);
  if (
    returned.kind !== "none" &&
    returned.kind !== "dispatching" &&
    draftAuthorityActorIsCurrent(actor)
  )
    recordSandboxStateSend(send, stage, returned, resting ? "rested" : "ended");
}

/**
 * The sandbox a send's message stays on in its task's composer, as that
 * composer's own pick of it would be: an awake one is its host, a resting
 * one is staged to wake, and one not created yet is its own stage again,
 * with the same create key in case the server already accepted it. A
 * created sandbox only wakes, so it needs no key.
 */
function returnedSandboxPick(
  send: PendingSandboxSend,
  stage: StagedSandbox,
  state: HostSandboxState | null,
): ReturnedSandboxPick {
  const { createdSandboxId, createdHostId, target } = stage;
  if (createdSandboxId === null || createdHostId === null)
    return { kind: "stage", ...stagedSandboxDestination(stage) };
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
  readonly stage: StagedSandbox;
  readonly hostId: string;
  readonly client: HostClient<HostRpcRegistry>;
  readonly settings: PendingSandboxSend["settings"];
  readonly opencodeLine: OpencodeLine | null;
}): void {
  const { send, stage, hostId, settings } = input;
  const surfaceKey = pendingSendSurfaceKey(send.id);
  const actor = captureDraftAuthorityActor();
  if (
    actor === null ||
    actor.accountId !== send.userId ||
    deliveriesPreparing.has(send.id)
  )
    return;
  const current = (): boolean =>
    draftAuthorityActorIsCurrent(actor) && preparingSendCurrent(send, stage);
  if (!current()) return;
  deliveriesPreparing.add(send.id);
  void preparePendingSandboxSubmission(actor, input, current)
    .then((prepared) => {
      if (!current()) return;
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
      deliverPendingSend({
        send,
        stage,
        hostId,
        settings,
        content: prepared.content,
        attachmentsByHash: prepared.attachmentsByHash,
        outboxInlineHashes: prepared.outboxInlineHashes,
        opencodeLine: input.opencodeLine,
      });
    })
    .catch(() => {
      if (!current()) return;
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
function preparingSendCurrent(
  send: PendingSandboxSend,
  preparedStage: StagedSandbox,
): boolean {
  const surfaceKey = pendingSendSurfaceKey(send.id);
  if (!stageObservationCurrent(surfaceKey, preparedStage, undefined))
    return false;
  const stage = readStagedSandbox(surfaceKey);
  const current = readPendingSandboxSend(send.id);
  if (
    current === undefined ||
    current.stopRequested === true ||
    (send.outboxGeneration !== undefined &&
      current.outboxGeneration !== send.outboxGeneration)
  )
    return false;
  return transitionPendingSend(
    pendingSendState(current, stageBlocker(stage)),
    "prepared",
    pendingSandboxSendFacts(send.id, {
      ...UNKNOWN_PENDING_SEND_FACTS,
      modelReady: true,
      stageCurrent: stage?.phase === "handoff" && stage.failure === null,
    }),
  ).effects.includes("persist-claim");
}

async function preparePendingSandboxSubmission(
  actor: DraftAuthorityActor,
  input: {
    readonly send: PendingSandboxSend;
    readonly hostId: string;
    readonly client: HostClient<HostRpcRegistry>;
  },
  current: () => boolean,
): Promise<{
  readonly content: JsonContent;
  readonly attachmentsByHash: boolean;
  readonly outboxInlineHashes?: readonly string[];
} | null> {
  const { send, hostId, client } = input;
  const outbox = await loadPendingSandboxOutbox(actor, send);
  if (
    outbox === null ||
    outbox.ownership !== "setup" ||
    outbox.decision.kind !== "waiting" ||
    !outbox.send.epicConfirmed ||
    (send.outboxGeneration !== undefined &&
      outbox.generation !== send.outboxGeneration) ||
    !current()
  )
    return null;
  if (outbox.submission === undefined) {
    const { request } = outbox.send;
    if (
      request.kind === "message" &&
      request.browserAnnotations?.some((record) => record.imageHash !== null)
    )
      return null;
    return contentForHost(hostId, client, send.content, current);
  }
  if (outbox.send.request.kind !== "message") return null;
  const submission = await readPendingSandboxBoundSubmission(
    actor,
    send.id,
    outbox.generation,
  );
  if (submission === null || !current()) return null;
  // The seeded chat stream takes a fully materialized frame. Persist only
  // the exact draft-owned digests and materialize them under its issue grant.
  return {
    content: submission.content,
    attachmentsByHash: false,
    outboxInlineHashes: submission.manifest.digests,
  };
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
  isCurrent: () => boolean,
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
  if (!isCurrent()) return null;
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
  input: PendingSandboxCreateChatMutationInput,
) => Promise<CreateChatResponseV12>;

/** Records the exact chat payload durably before any host request can begin. */
function deliverPendingSend(input: {
  readonly send: PendingSandboxSend;
  readonly stage: StagedSandbox;
  readonly hostId: string;
  readonly settings: PendingSandboxSend["settings"];
  readonly content: JsonContent;
  readonly attachmentsByHash: boolean;
  readonly outboxInlineHashes: readonly string[] | undefined;
  readonly opencodeLine: OpencodeLine | null;
}): void {
  const { send, hostId, settings } = input;
  if (send.request.kind !== "chat" && send.request.kind !== "message") return;
  claimPendingDispatch(
    send,
    input.stage,
    {
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
    },
    input.outboxInlineHashes,
  );
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
  claimPendingDispatch(
    send,
    stage,
    {
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
    },
    undefined,
  );
}

function claimPendingDispatch(
  send: PendingSandboxSend,
  stage: StagedSandbox,
  input: PendingSandboxSendDispatch["input"],
  outboxInlineHashes: readonly string[] | undefined,
): void {
  const actor = captureDraftAuthorityActor();
  if (actor === null || actor.accountId !== send.userId) return;
  const canTransfer = (): boolean =>
    draftAuthorityActorIsCurrent(actor) && preparingSendCurrent(send, stage);
  if (!canTransfer()) return;
  const now = Date.now();
  const setupAttempt = stage.authoritySetupAttempt ?? send.outboxSetupBinding;
  void transferPendingSandboxOutbox({
    actor,
    send,
    dispatch: {
      input,
      status: "sending",
      ...(outboxInlineHashes === undefined ? {} : { outboxInlineHashes }),
      ...(setupAttempt === undefined
        ? {}
        : {
            setupAttempt: {
              attemptId: setupAttempt.attemptId,
              observationGeneration: setupAttempt.observationGeneration,
            },
          }),
      delivery: {
        chatId: input.chatId,
        hostId: input.hostId,
        sandboxId: stage.createdSandboxId ?? "",
        readySeconds: Math.max(
          0,
          Math.round((now - (stage.startedAt ?? now)) / 1000),
        ),
      },
    },
    canTransfer,
  }).catch(() => {
    if (canTransfer()) notSent(pendingSendSurfaceKey(send.id));
  });
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
          readEnvironment: policy.readEnvironment,
          readHostEndProof: policy.readHostEndProof,
        });
      }
    }).catch(() => undefined);
    return () => {
      disposed = true;
      ownership.release();
    };
  }, [
    createChatAsync,
    dispatch,
    navigateNestedFocus,
    policy.dispatchAllowed,
    policy.readEnvironment,
    policy.readHostEndProof,
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
    props.policy.dispatchAllowed || props.send.outboxPrimaryIssuing === true,
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
  const mountedHandle = useRef<ChatSessionStoreHandle | null>(null);
  useLayoutEffect(() => {
    mountedHandle.current = handle;
    return () => {
      mountedHandle.current = null;
    };
  }, [handle]);
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
        attempt: attempt.current,
        handle,
        readHostEndProof: policy.readHostEndProof,
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
    const actor = captureDraftAuthorityActor();
    if (actor === null || actor.accountId !== send.userId) return;
    if (dispatchesInFlight.has(send.id)) return;
    const isCurrent = (): boolean => {
      const live = handle.store.getState();
      return (
        mountedHandle.current === handle &&
        draftAuthorityActorIsCurrent(actor) &&
        pendingPrimaryDispatchCurrent(send, dispatch, policy.readEnvironment()) &&
        live.connectionEpoch === state.connectionEpoch &&
        live.connectionStatus === "open" &&
        live.snapshotLoaded &&
        live.access?.canAct === true
      );
    };
    const canIssue = (): boolean =>
      isCurrent() &&
      pendingMessageCanDispatch({
        send,
        dispatch,
        state: handle.store.getState(),
        handle,
        attempt: attempt.current,
        actionId: message.clientActionId,
      });
    dispatchesInFlight.add(send.id);
    void claimPendingSandboxOutboxEffect({
      actor,
      send,
      operationId: `${send.id}:dispatch`,
      effect: pendingSandboxDispatchEffect(send, dispatch),
      canIssue,
    })
      .then(async (claim) => {
        if (claim === null) return;
        const wire =
          dispatch.outboxInlineHashes === undefined
            ? null
            : await materializePendingSandboxBoundWire({
                actor, send, dispatch, claim,
              }).catch(() => null);
        if (
          (dispatch.outboxInlineHashes !== undefined && wire === null) ||
          !(await verifyPendingSandboxOutboxGrant(actor, claim)) ||
          !canIssue()
        ) {
          await settlePendingSandboxOutboxEffect(actor, claim, "uncertain");
          return;
        }
        const live = handle.store.getState();
        attempt.current = { handle, epoch: live.connectionEpoch, claim };
        if (!sendPendingMessage(live, send, dispatch, message, wire, isCurrent)) {
          attempt.current = null;
          await settlePendingSandboxOutboxEffect(actor, claim, "uncertain");
          usePendingSandboxSendStore.getState().markDispatchUncertain(send.id, dispatch);
        }
      })
      .catch(() => undefined)
      .finally(() => dispatchesInFlight.delete(send.id));
  }, [
    dispatch,
    handle,
    policy.dispatchAllowed,
    policy.environment,
    policy.readEnvironment,
    policy.readHostEndProof,
    send,
    snapshot,
  ]);
  return null;
}

interface PendingMessageAttempt {
  readonly handle: ChatSessionStoreHandle;
  readonly epoch: number;
  readonly claim: DraftAuthorityIssueReceipt;
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
  const rejection = state.failedSendRestoration;
  if (
    rejection?.stated === true &&
    rejection.clientActionId === message.clientActionId &&
    rejection.messageId === message.messageId
  )
    return "rejected";
  return "waiting";
}

function settlePendingMessage(input: {
  readonly send: PendingSandboxSend;
  readonly dispatch: PendingSandboxSendDispatch;
  readonly state: ChatSessionState;
  readonly message: PendingDispatchMessage;
  readonly attempt: PendingMessageAttempt | null;
  readonly handle: ChatSessionStoreHandle;
  readonly readHostEndProof: ReadPendingHostEndProof;
}): boolean {
  const { send, dispatch, state, message, attempt, handle } = input;
  const outcome = pendingMessageOutcome(state, message);
  if (outcome === "waiting") return false;
  const actor = captureDraftAuthorityActor();
  if (actor === null || actor.accountId !== send.userId) return true;
  if (outcome === "accepted") {
    void reconcilePendingSandboxDispatch(actor, send, dispatch, "accepted")
      .then((settled) => {
        if (settled)
          useStagedSandboxStore.getState().clear(pendingSendSurfaceKey(send.id));
      })
      .catch(() => undefined);
  } else if (attempt?.handle === handle && attempt.epoch === state.connectionEpoch) {
    void settlePendingDispatchRefusal({
      actor,
      send,
      dispatch,
      claim: attempt.claim,
      readHostEndProof: input.readHostEndProof,
      refusalId: JSON.stringify(["send-rejected", message.clientActionId, message.messageId]),
    }).then((settled) => {
      if (settled) state.ackRetainedRejectedSend(message.clientActionId);
    }).catch(() => undefined);
  }
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
      const actor = captureDraftAuthorityActor();
      if (actor !== null && actor.accountId === send.userId)
        void reconcilePendingSandboxDispatch(actor, send, dispatch, "uncertain")
          .catch(() => undefined);
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
  wire: PendingSandboxBoundWire | null,
  isCurrent: () => boolean,
): boolean {
  if (send.request.kind !== "message") return false;
  const savedAccount = wire === null ? null : accountContextSchema.safeParse(message.accountContext);
  if (savedAccount !== null && !savedAccount.success) return false;
  return (
    state.sendSeededUserMessage({
      messageId: message.messageId,
      clientActionId: message.clientActionId,
      content: wire?.content ?? message.content,
      ...(wire === null || savedAccount === null
        ? {}
        : {
            pendingOutbox: {
              restoreContent: wire.restoreContent,
              accountContext: savedAccount.data,
              sentFromHostId: message.sentFromHostId ?? null,
              isCurrent,
            },
          }),
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

type ReadPendingHostEndProof = (
  actor: DraftAuthorityActor,
  claim: DraftAuthorityIssueReceipt,
) => DraftAuthorityHostEndEvidence | null;

interface PendingDispatchPolicy {
  readonly dispatchAllowed: boolean;
  readonly environment: PendingSendFacts;
  readonly readEnvironment: () => PendingSendFacts;
  readonly readHostEndProof: ReadPendingHostEndProof;
}

type WakeObservation = Extract<
  PendingSandboxObservation,
  { kind: "wake-result" }
>;

interface PendingDispatchWake {
  readonly observation: WakeObservation;
  readonly priorRow: PendingSandboxObservation | null;
}

function pendingDispatchWakeAwaitingRow(
  wake: PendingDispatchWake,
  row: PendingSandboxRowFacts,
  environment: PendingSendFacts,
): boolean {
  return (
    wake.priorRow === null ||
    wake.priorRow === row.observation ||
    !row.known ||
    (environment.host === "awake" && !environment.clientReady)
  );
}

function observeCompletedDispatchWake(input: {
  readonly send: PendingSandboxSend;
  readonly dispatch: PendingSandboxSendDispatch;
  readonly observation: WakeObservation;
  readonly priorRow: PendingSandboxObservation;
  readonly auth: AuthService;
  readonly queryClient: QueryClient;
  readonly refetch: () => Promise<unknown>;
}): PendingDispatchWake | null {
  const { send, dispatch, observation, auth, queryClient, refetch } = input;
  const oldRow = pendingSandboxByIdOptions({
    auth,
    userId: send.userId,
    sandboxId: dispatch.delivery.sandboxId,
    hostId: dispatch.input.hostId,
    send: usePendingSandboxSendStore.getState().sends[send.id] ?? null,
    stage: readStagedSandbox(pendingSendSurfaceKey(send.id)),
    omission: undefined,
  });
  const observationId = uuidv4();
  const requestedAt = completePendingDispatchWake(
    send.id,
    dispatch,
    observation,
    observationId,
  );
  if (
    requestedAt === null &&
    !pendingDispatchWakeCurrent(send.id, dispatch, observation)
  )
    return null;
  const cancelled = cancelSandboxWakeReads(
    queryClient,
    auth,
    send.userId,
    oldRow.queryKey,
  );
  if (requestedAt === null) {
    usePendingSandboxSendStore
      .getState()
      .dispatchEvent(send.id, "wake-failed", {
        ...UNKNOWN_PENDING_SEND_FACTS,
        observation,
      });
    return null;
  }
  const completed: WakeObservation = {
    kind: "wake-result",
    requestedAt,
    observationId,
  };
  void cancelled.then(() => {
    if (pendingDispatchWakeCurrent(send.id, dispatch, completed))
      void refetch();
  });
  return { observation: completed, priorRow: input.priorRow };
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
  const endScope = useMemo(() => dispatchHostEndScope(dispatch), [dispatch]);
  const matchesDispatch = useCallback(
    () => pendingSandboxDispatchCurrent(send.id, dispatch),
    [send.id, dispatch],
  );
  const settledDestroy = useRef<{
    readonly generation: number | undefined;
    readonly evidence: DraftAuthorityHostEndEvidence;
  } | null>(null);
  const observeDestroy = useCallback((evidence: DraftAuthorityHostEndEvidence) => {
    settledDestroy.current = { generation: send.outboxGeneration, evidence };
  }, [send.outboxGeneration]);
  usePendingDestroyEnd(send, endScope, matchesDispatch, observeDestroy);
  const signedEnd = signedHostEndProof(endScope, row);
  const latestSignedEnd = useRef(signedEnd);
  useLayoutEffect(() => {
    latestSignedEnd.current = signedEnd;
  }, [signedEnd]);
  const readHostEndProof = useCallback<ReadPendingHostEndProof>((actor, claim) => {
    const current = readPendingSandboxSend(send.id);
    if (
      current === undefined ||
      current.outboxGeneration === undefined ||
      claim.outboxGeneration === null ||
      !matchesDispatch() ||
      !pendingHostEndCurrent(current, actor)
    )
      return null;
    const destroy = settledDestroy.current;
    return destroy !== null && destroy.generation === current.outboxGeneration
      ? destroy.evidence
      : latestSignedEnd.current;
  }, [send.id, matchesDispatch]);
  const binding = useHostBinding();
  const queryClient = useQueryClient();
  const wakeRequested = useRef<PendingDispatchWake | null>(null);
  const retryLease = useRef<object | null>(null);
  const releaseRetry = useRef<(() => void) | null>(null);
  const lastRowObservation = useRef<PendingSandboxObservation>(row.observation);
  const [owned, setOwned] = useState(() => ownsPendingSandboxSend(send.id));
  const settings = useSandboxSettingsStatus(row.row);
  useEffect(() => {
    const lease = {};
    retryLease.current = lease;
    const ownership = holdPendingSandboxSendOwnership(send.id);
    void ownership.ready.then((granted) => {
      if (retryLease.current === lease) setOwned(granted);
    });
    return () => {
      retryLease.current = null;
      releaseRetry.current?.();
      releaseRetry.current = null;
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
  const latestEnvironment = useRef(environment);
  useLayoutEffect(() => {
    latestEnvironment.current = environment;
  }, [environment]);
  const readEnvironment = useCallback(() => latestEnvironment.current, []);
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
    lastRowObservation.current = row.observation;
    const wake = wakeRequested.current;
    if (
      wake !== null &&
      (!pendingDispatchWakeCurrent(send.id, dispatch, wake.observation) ||
        !pendingDispatchWakeAwaitingRow(wake, row, environment))
    )
      wakeRequested.current = null;
    const retryRequested =
      send.retryRequest !== undefined && send.retryRequest.id !== send.retryHandledId;
    const decision = usePendingSandboxSendStore
      .getState()
      .dispatchEvent(
        send.id,
        retryRequested ? "consume-retry" : event,
        {
          ...environment,
          retryAction: "send-again",
          retryObservation: event,
          wakeInFlight: wakeRequested.current !== null,
        },
      );
    if (decision === null) return;
    if (retryRequested && decision.effects.includes("retry")) {
      const actor = captureDraftAuthorityActor();
      const lease = retryLease.current;
      releaseRetry.current?.();
      releaseRetry.current =
        actor === null || lease === null
          ? null
          : retainPendingSandboxDispatchRetry(
              actor,
              send,
              () => retryLease.current === lease && ownsPendingSandboxSend(send.id),
            );
    }
    if (decision.effects.includes("rehydrate"))
      void usePendingSandboxSendStore.persist.rehydrate();
    if (decision.effects.includes("end-host")) {
      const actor = captureDraftAuthorityActor();
      const evidence = signedHostEndProof(endScope, row);
      if (actor !== null && evidence !== null) {
        const isCurrent = (): boolean =>
          pendingHostEndCurrent(send, actor) &&
          pendingSandboxDispatchCurrent(send.id, dispatch) &&
          pendingSandboxSendFacts(send.id, readEnvironment()).host === "ended";
        if (isCurrent())
          void holdPendingSandboxOutboxEnd({ actor, send, evidence, isCurrent })
            .catch(() => undefined);
      }
      return;
    }
    if (
      decision.effects.includes("return-message") ||
      decision.effects.includes("remove")
    )
      void returnPendingSandboxSend(send.id).catch(() => undefined);
    if (!decision.effects.includes("wake") || wakeRequested.current !== null)
      return;
    const actor = captureDraftAuthorityActor();
    if (actor === null || actor.accountId !== send.userId) return;
    const observationId = uuidv4();
    const wakeBoundary = usePendingSandboxSendStore
      .getState()
      .holdObservation(send.id, decision, observationId);
    if (wakeBoundary === null) return;
    const observation: WakeObservation = {
      kind: "wake-result",
      requestedAt: wakeBoundary,
      observationId,
    };
    const canIssue = (): boolean =>
      draftAuthorityActorIsCurrent(actor) &&
      pendingDispatchWakeCurrent(send.id, dispatch, observation);
    if (!canIssue()) return;
    wakeRequested.current = { observation, priorRow: null };
    const abandonRetry = releaseRetry.current;
    void claimPendingSandboxOutboxEffect({
      actor,
      send,
      operationId: `${send.id}:dispatch-wake:${observationId}`,
      effect: {
        kind: "wake",
        phase: "dispatch",
        identity: dispatch.delivery.sandboxId,
        payload: {
          sandboxId: dispatch.delivery.sandboxId,
          hostId: dispatch.input.hostId,
          gesture: "send",
        },
      },
      canIssue,
    })
      .then(async (claim) => {
        if (claim === null) {
          abandonRetry?.();
          if (wakeRequested.current?.observation === observation)
            wakeRequested.current = null;
          return;
        }
        if (!canIssue()) {
          abandonRetry?.();
          await settlePendingSandboxOutboxEffect(actor, claim, "uncertain");
          return;
        }
        const outcome = await startPendingSandboxWake(
          queryClient,
          binding,
          dispatch.input.hostId,
          "send",
          {
            sandboxId: dispatch.delivery.sandboxId,
            verify: () => verifyPendingSandboxOutboxGrant(actor, claim),
            isCurrent: canIssue,
          },
        );
        if (!canIssue()) return;
        let settlement: "accepted" | "refused" | "uncertain" = "uncertain";
        if (outcome?.kind === "awake") settlement = "accepted";
        else if (outcome?.kind === "refused" || outcome?.kind === "credit-gate")
          settlement = "refused";
        if (settlement !== "accepted") abandonRetry?.();
        const settled = await settlePendingSandboxOutboxEffect(actor, claim, settlement);
        if (!settled || !canIssue()) {
          abandonRetry?.();
          return;
        }
        if (outcome?.kind === "awake" && binding !== null) {
          wakeRequested.current = observeCompletedDispatchWake({
            send,
            dispatch,
            observation,
            priorRow: lastRowObservation.current,
            auth: binding.auth,
            queryClient,
            refetch,
          });
          if (wakeRequested.current === null) abandonRetry?.();
          return;
        }
        abandonRetry?.();
        wakeRequested.current = null;
        const plan = usePendingSandboxSendStore
          .getState()
          .dispatchEvent(send.id, "wake-failed", {
            ...environment,
            wakeInFlight: true,
            observation,
          });
        if (plan?.effects.includes("poll")) void refetch();
      })
      .catch(() => {
        abandonRetry?.();
        if (wakeRequested.current?.observation === observation)
          wakeRequested.current = null;
      });
  }, [
    binding,
    dispatch,
    endScope,
    environment,
    event,
    owned,
    queryClient,
    readEnvironment,
    refetch,
    row,
    send,
  ]);
  return {
    dispatchAllowed: owned && plan.effects.includes("dispatch"),
    environment,
    readEnvironment,
    readHostEndProof,
  };
}

function pendingPrimaryDispatchCurrent(
  send: PendingSandboxSend,
  dispatch: PendingSandboxSendDispatch,
  environment: PendingSendFacts,
): boolean {
  const facts = pendingSandboxSendFacts(send.id, environment);
  return (
    facts.current &&
    facts.owns &&
    facts.accountActive &&
    facts.durableClaim &&
    !facts.terminalDisposition &&
    facts.host === "awake" &&
    !facts.frozen &&
    facts.settingsReady &&
    facts.clientReady &&
    pendingSandboxDispatchCurrent(send.id, dispatch)
  );
}

async function settlePendingDispatchRefusal(input: {
  readonly actor: DraftAuthorityActor;
  readonly send: PendingSandboxSend;
  readonly dispatch: PendingSandboxSendDispatch;
  readonly claim: DraftAuthorityIssueReceipt;
  readonly readHostEndProof: ReadPendingHostEndProof;
  readonly refusalId: string;
}): Promise<boolean> {
  const { actor, send, dispatch, claim } = input;
  const evidence = input.readHostEndProof(actor, claim);
  if (
    evidence !== null &&
    await settlePendingSandboxOutboxEnd({
      actor,
      claim,
      evidence,
      undeliveredProofId: JSON.stringify([
        claim.operationId,
        claim.issueGeneration,
        claim.executorId,
        input.refusalId,
      ]),
    })
  )
    return true;
  if (!(await settlePendingSandboxOutboxEffect(actor, claim, "refused"))) return false;
  refusePendingDispatch(send, dispatch);
  return true;
}

/** A refusal is definite; every other failed response may have accepted the create. */
async function runPendingDispatch(
  send: PendingSandboxSend,
  dispatch: PendingSandboxSendDispatch,
  execution: {
    readonly createChat: CreateChatAsync;
    readonly navigateNestedFocus: NavigateNestedFocus;
    readonly readEnvironment: () => PendingSendFacts;
    readonly readHostEndProof: ReadPendingHostEndProof;
  },
): Promise<void> {
  const { createChat, navigateNestedFocus, readEnvironment, readHostEndProof } = execution;
  const actor = captureDraftAuthorityActor();
  if (
    actor === null ||
    actor.accountId !== send.userId ||
    dispatchesInFlight.has(send.id)
  )
    return;
  const canIssue = (): boolean =>
    draftAuthorityActorIsCurrent(actor) &&
    pendingPrimaryDispatchCurrent(send, dispatch, readEnvironment());
  if (!canIssue()) return;
  dispatchesInFlight.add(send.id);
  let claim: DraftAuthorityIssueReceipt | null = null;
  try {
    claim = await claimPendingSandboxOutboxEffect({
      actor,
      send,
      operationId: `${send.id}:dispatch`,
      effect: pendingSandboxDispatchEffect(send, dispatch),
      canIssue,
    });
    if (claim === null) return;
    if (!canIssue()) {
      await settlePendingSandboxOutboxEffect(actor, claim, "uncertain");
      return;
    }
    const issuedClaim = claim;
    const response = await createChat({
      ...dispatch.input,
      pendingIssue: {
        verify: async () =>
          (await verifyPendingSandboxOutboxGrant(actor, issuedClaim)) &&
          canIssue(),
        isCurrent: canIssue,
        isActorCurrent: () => draftAuthorityActorIsCurrent(actor),
      },
    });
    if (response.chatId !== dispatch.input.chatId) {
      await settlePendingSandboxOutboxEffect(actor, claim, "uncertain");
      return;
    }
    if (response.refusal !== undefined) {
      await settlePendingDispatchRefusal({
        actor,
        send,
        dispatch,
        claim,
        readHostEndProof,
        refusalId: JSON.stringify(["create-refused", response.refusal]),
      });
      return;
    }
    if (!(await settlePendingSandboxOutboxEffect(actor, claim, "accepted")))
      return;
    registerDispatchHandoff(send, dispatch);
    if (!ownsPendingSandboxSend(send.id)) return;
    useStagedSandboxStore.getState().clear(pendingSendSurfaceKey(send.id));
    finishDispatchUi(send, dispatch, response, navigateNestedFocus);
  } catch (error: unknown) {
    if (claim === null) return;
    if (
      error instanceof HostRpcError &&
      (error.code === "E_FORK_BOUNDARY_NOT_PUBLISHED" ||
        error.code === "removed-by-person")
    ) {
      if (!(await settlePendingSandboxOutboxEffect(actor, claim, "refused")))
        return;
      refusePendingDispatch(send, dispatch);
      if (error.code === "removed-by-person")
        toastFromHostError(error, REMOVED_PROFILE_PIN_TEXT);
    } else {
      await settlePendingSandboxOutboxEffect(actor, claim, "uncertain");
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
      // NOT the person, though the source is a direct gesture: this queue is
      // persisted and rehydrates, so a fork whose sandbox woke after a reload
      // lands here with nobody at the keyboard. A `"user"` claim would retire
      // an artifact request the route is waiting on in that load.
      provenance: "automatic",
    },
    navigateNestedFocus,
    mobileTarget: null,
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
    send.outboxGeneration !== undefined &&
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
          {view.line === "settings" ? (
            pendingSettingsTitle(row.row, settings.data)
          ) : (
            <PendingDispatchLine
              kind={send.request.kind}
              line={view.line}
              row={row.row}
            />
          )}
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
                .requestDispatchRetry(props.id, send.outboxGeneration);
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

/**
 * Anyone who cannot buy a team's credits is told whose ran out, not to add them.
 * Nothing while ownership is unknown.
 */
function PendingDispatchLine(props: {
  readonly kind: PendingSandboxSendRequest["kind"];
  readonly line: Exclude<PendingSendView["line"], "settings">;
  readonly row: SandboxSummary | null;
}): ReactNode {
  if (props.line === "credits")
    return <PendingDispatchCreditsLine kind={props.kind} row={props.row} />;
  return pendingDispatchLineCopy(props.kind, props.line);
}

function PendingDispatchCreditsLine(props: {
  readonly kind: PendingSandboxSendRequest["kind"];
  readonly row: SandboxSummary | null;
}): ReactNode {
  const configurations = useSandboxConfigurations();
  const configuration =
    props.row === null
      ? null
      : sandboxConfigurationOf(props.row, configurations);
  const offersAddCredits = useOffersAddCredits(configuration);
  // Not known whose: a team's row (only a team agent sandbox names a creator)
  // reads as the sandbox page's header does for a team it cannot name; a row
  // not in hand, or one that may be the person's own, has no line.
  if (configuration === null)
    return props.row !== null && props.row.createdBy !== null
      ? unnamedTeamCreditsRanOut(configurations.complete)
      : null;
  if (configuration.kind === "team" && !offersAddCredits)
    return teamCreditsRanOutLine(configuration.teamName);
  return pendingDispatchLineCopy(props.kind, "credits");
}

/** Repairs a live sandbox without releasing a possibly accepted request. */
function PendingDispatchRemedy(props: {
  readonly id: string;
  readonly userId: string | null;
  readonly row: SandboxSummary | null;
  readonly failure: "credits" | "settings";
}): ReactNode {
  const configurations = useSandboxConfigurations();
  const configuration =
    props.row === null
      ? null
      : sandboxConfigurationOf(props.row, configurations);
  const billingUrlOf = useBillingUrlOf();
  const openLink = useOpenLink();
  const addCredits =
    useOffersAddCredits(configuration) && props.failure === "credits";
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
        if (addCredits && configuration !== null)
          void openLink(billingUrlOf(configuration), "account", null);
        else openSandboxDetails(props.id);
      }}
    >
      {addCredits ? "Add credits" : "Details"}
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
      {ids.length === 0 ? (
        <RestedTaskMessageLine epicId={props.epicId} tabId={props.tabId} />
      ) : (
        <div
          className="flex w-full flex-col gap-3 px-4 py-3"
          data-testid="pending-sandbox-sends"
        >
          {ids.map((id) => (
            <PendingSendItem key={id} id={id} tabId={props.tabId} />
          ))}
        </div>
      )}
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
  if (send.outboxReturnId !== undefined || send.returnRequested !== undefined)
    return (
      <PendingMessageReturnItem key={send.outboxReturnId ?? send.id} send={send} />
    );
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
  const subscribe = useCallback(
    (listener: () => void) => subscribeToPendingSandboxBrowserCancel(send.id, listener),
    [send.id],
  );
  const canRetryBrowser = useSyncExternalStore(
    subscribe,
    () => {
      const actor = captureDraftAuthorityActor();
      return actor !== null &&
        actor.accountId === send.userId &&
        send.outboxReturnId !== undefined &&
        send.outboxGeneration !== undefined &&
        pendingSandboxBrowserCancelCanRetry(
          actor, send.id, send.outboxReturnId, send.outboxGeneration,
        );
    },
    () => false,
  );
  // As it was decided when it began, sandbox and all.
  const giveBack = useCallback(async (retryBrowser: boolean): Promise<boolean | null> => {
    if (send.outboxReturnId === undefined) {
      await resumePendingSandboxMessageReturn(send.id);
      return !Object.hasOwn(usePendingSandboxSendStore.getState().sends, send.id);
    }
    const actor = captureDraftAuthorityActor();
    if (actor === null || actor.accountId !== send.userId) return null;
    return resumeMountedOutboxReturn(actor, send, send.outboxReturnId, retryBrowser);
  }, [send]);
  useEffect(() => {
    let disposed = false;
    void giveBack(attempt > 0).then(
      (completed) => {
        if (
          !disposed &&
          completed === false &&
          !browserCancelSuppressesReturn(send)
        )
          setFailed(true);
      },
      () => {
        if (!disposed && !browserCancelSuppressesReturn(send))
          setFailed(true);
      },
    );
    return () => {
      disposed = true;
    };
  }, [attempt, giveBack, send]);
  return (
    <PendingReturnNotice
      send={send}
      failed={failed}
      retryAvailable={canRetryBrowser}
      retry={() => {
        setFailed(false);
        setAttempt((value) => value + 1);
      }}
    />
  );
}

function browserCancelSuppressesReturn(send: PendingSandboxSend): boolean {
  const actor = captureDraftAuthorityActor();
  return actor !== null && send.outboxReturnId !== undefined &&
    pendingSandboxBrowserCancelInFlight(actor, send.id, send.outboxReturnId);
}

function PendingReturnNotice(props: {
  readonly send: PendingSandboxSend;
  readonly failed: boolean;
  readonly retryAvailable?: boolean;
  readonly retry: () => void;
}): ReactNode {
  const { send, failed, retry } = props;
  const retryEnabled = failed || props.retryAvailable === true;
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
        aria-busy={!retryEnabled}
        disabled={!retryEnabled}
        onClick={retry}
      >
        Cancel the message
      </Button>
      <PendingSendMessage send={send} />
    </div>
  );
}

/** A queued strip publishes intent; only the owning window runs stage or host effects. */
function usePendingStagedSendRetry(
  send: PendingSandboxSend,
  shownStage: StagedSandbox | null,
): (action: PendingStageRetryAction) => void {
  return useCallback(
    (action: PendingStageRetryAction) => {
      const surfaceKey = pendingSendSurfaceKey(send.id);
      const current = readStagedSandbox(surfaceKey);
      const { sends } = usePendingSandboxSendStore.getState();
      if (
        shownStage === null ||
        current === null ||
        !stageObservationCurrent(surfaceKey, shownStage, undefined) ||
        shownStage.phase !== current.phase ||
        JSON.stringify(shownStage.failure) !== JSON.stringify(current.failure) ||
        (action === "retry-creation" &&
          current.failure?.acceptedRowNotFound === true) ||
        !Object.hasOwn(sends, send.id)
      )
        return;
      const createKey = stagePressCreateKey(shownStage, action);
      const press: PendingStagePress = {
        createKey,
        retryCreate: stagedCreateRetryPayload(shownStage, createKey),
        observedCreateKey: stagedCreateAttemptKey(shownStage),
        observedAttemptId: shownStage.attemptId ?? null,
      };
      const plan = transitionPendingSend(
        pendingSendState(sends[send.id], stageBlocker(current)),
        "request-retry",
        pendingSandboxSendFacts(send.id, {
          ...UNKNOWN_PENDING_SEND_FACTS,
          retryAction: action,
          stageStatus: current.phase,
        }),
      );
      if (plan.effects.includes("request-retry"))
        void useStagedSandboxStore
          .getState()
          .requestRetry(surfaceKey, send.userId, action, press);
    },
    [send, shownStage],
  );
}

/** Stop holds the unsent copy until the mutation or a fresh row proves rest. */
async function stopPendingSend(input: {
  readonly send: PendingSandboxSend;
  readonly stage: StagedSandbox;
  readonly actor: DraftAuthorityActor | null;
  readonly stop: (issue: {
    readonly sandboxId: string;
    readonly hostId: string;
    readonly verify: () => Promise<boolean>;
    readonly isCurrent: () => boolean;
  }) => Promise<SandboxVerbOutcome>;
  readonly requested: () => void;
  readonly refresh: () => Promise<unknown>;
}): Promise<void> {
  const { send, stage, actor, stop, requested, refresh } = input;
  const id = send.id;
  const surfaceKey = pendingSendSurfaceKey(id);
  if (
    actor === null ||
    actor.accountId !== send.userId ||
    !draftAuthorityActorIsCurrent(actor) ||
    !stageObservationCurrent(surfaceKey, stage, send.stopStage)
  )
    return;
  const plan = pendingStopDecision(id, "stop", "unknown", null);
  if (!plan?.effects.includes("stop-host")) {
    if (plan?.effects.includes("remove")) {
      requested();
      await returnStoppedPendingSend(id, null, undefined);
    }
    return;
  }
  const { createdSandboxId: sandboxId, createdHostId: hostId, attemptId } = stage;
  if (sandboxId === null || hostId === null || attemptId === undefined) return;
  const attempt: PendingStopAttempt = { operationId: uuidv4(), returned: false };
  const stageIsCurrent = (): boolean =>
    draftAuthorityActorIsCurrent(actor) &&
    stageObservationCurrent(surfaceKey, stage, send.stopStage);
  const held = await holdPendingSandboxOutboxStop({
    actor,
    send,
    operationId: attempt.operationId,
    sandboxId,
    hostId,
    attemptId,
    observationBoundary: Date.now(),
    isCurrent: stageIsCurrent,
  });
  if (held === null || !stageIsCurrent()) return;
  const boundary = held.observationBoundary;
  if (
    !usePendingSandboxSendStore
      .getState()
      .holdStop(id, stage, held.operationId, boundary)
  )
    return;
  try {
    useStagedSandboxStore.getState().report(surfaceKey, {
      failure: { kind: "settings", code: STOP_INTENT_CODE },
    });
  } catch {
    // The canonical Stop still owns the message if this projection fails.
  }
  requested();
  void refresh();
  const isCurrent = (): boolean =>
    stageIsCurrent() &&
    pendingSandboxStopCurrent(id, stage, held.operationId);
  if (!isCurrent()) return;
  stopsInFlight.set(id, attempt);
  try {
    const outcome = await stop({
      sandboxId,
      hostId,
      verify: () => verifyPendingSandboxOutboxStop(actor, held),
      isCurrent,
    });
    const settled = await settlePendingSandboxOutboxStop(
      actor,
      held,
      pendingStopOutcome(outcome),
    );
    if (
      (settled || readPendingSandboxSend(id) === undefined) &&
      draftAuthorityActorIsCurrent(actor) &&
      stopsInFlight.get(id) === attempt
    )
      await observePendingStopResult(send, stage, attempt, boundary, outcome);
  } catch (error: unknown) {
    if (!isCurrent()) return;
    const knownFailure =
      error instanceof SandboxOperationError && error.failure.kind === "refused";
    const settled = await settlePendingSandboxOutboxStop(actor, held, {
      kind: knownFailure ? "failed" : "unknown",
    });
    if (!settled || !isCurrent()) return;
    const failed = pendingStopDecision(id, "stop-failed", "unknown", boundary);
    if (failed?.outcome === "applied")
      useStagedSandboxStore.getState().report(surfaceKey, {
        failure: { kind: "settings", code: STOP_FAILED_CODE },
      });
  } finally {
    if (stopsInFlight.get(id) === attempt) stopsInFlight.delete(id);
  }
}

function pendingStopOutcome(outcome: SandboxVerbOutcome): DraftAuthorityStopOutcome {
  if (
    outcome.kind === "settled" &&
    (outcome.state === "stopped" || outcome.state === "suspended")
  )
    return { kind: "settled", state: outcome.state };
  return { kind: outcome.kind === "gone" ? "gone" : "moving" };
}

/** A stop completion either gives back the held copy or points at task-loss recovery. */
async function observePendingStopResult(
  originalSend: PendingSandboxSend,
  originalStage: StagedSandbox,
  attempt: PendingStopAttempt,
  boundary: number | null,
  outcome: SandboxVerbOutcome,
): Promise<void> {
  const id = originalSend.id;
  const host = stoppedHostObservation(outcome);
  const rowState = outcome.kind === "settled" ? outcome.state : null;
  const current = readPendingSandboxSend(id);
  if (
    current !== undefined &&
    (!stageObservationCurrent(pendingSendSurfaceKey(id), originalStage, current.stopStage) ||
      !pendingSandboxStopCurrent(id, originalStage, attempt.operationId))
  )
    return;
  const settled = pendingStopDecision(id, "stop-result", host, boundary);
  if (settled?.effects.includes("remove"))
    await returnStoppedPendingSend(id, rowState, undefined);
  else if (
    settled === null &&
    !attempt.returned &&
    host === "resting" &&
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
  "onChooseModel" | "onChooseAnotherHost" | "chooseAnotherHostLabel"
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
      void returnPendingSandboxMessage(send.id, false, true).then((returned) => {
        if (returned.kind === "chat")
          openActiveModelPickerForHarness("traycer", null, offeredAgents);
      }).catch(() => undefined);
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
    chooseAnotherHostLabel: CHOOSE_ANOTHER_HOST,
  };
}

/**
 * What the line calls giving the send back with no sandbox, named for the host
 * of the composer that shows it: its task's, or the Start Page's when the
 * message goes to Drafts. A sandbox staged there stays staged, so that
 * composer's chip will not show its host.
 */
function usePendingGiveBackLabel(
  send: PendingSandboxSend,
  taskDraftOccupied: boolean,
): string {
  const taskKey = newConversationSurfaceKey(send.epicId);
  const startPageKey = useComposerSurfaceHostKey();
  const taskPin = useSurfaceHostPinWithDefault(
    taskKey,
    useEpicSessionHostIdForEpic(send.epicId),
  );
  const startPagePin = useComposerSurfaceHostPin();
  const toDrafts =
    !send.epicConfirmed || (send.request.kind === "chat" && taskDraftOccupied);
  const destinationStage = useStagedSandbox(toDrafts ? startPageKey : taskKey);
  const destinationPin = toDrafts ? startPagePin : taskPin;
  return useStageFallbackHostLine(
    destinationStage === null ? destinationPin.resolvedHostId : null,
  );
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
    void endSendBackToComposer({
      send: input.send,
      stage: input.stage,
      tabId: input.tabId,
      restage: false,
      pick: input.pick,
      modelPickerHarnessId: "traycer",
    }).catch(() => undefined);
  };
}

function PendingStagedSendItem(props: {
  readonly send: PendingSandboxSend;
  readonly tabId: string;
}): ReactNode {
  const { send } = props;
  const actor = captureDraftAuthorityActor();
  const browserComposer = useBrowserSandboxCancelComposer();
  const [cancelRefused, setCancelRefused] = useState<{
    readonly actor: DraftAuthorityActor;
    readonly generation: number | undefined;
    readonly stage: StagedSandbox | null;
  } | null>(null);
  const cancelInFlight = useRef(false);
  const canWithdraw = usePendingSendWithdrawal(send.id);
  const taskDraftOccupied = useNewConversationModalStore((state) =>
    isNewConversationDraftOccupied(state.draftPatchesByEpicId[send.epicId]),
  );
  const giveBackLabel = usePendingGiveBackLabel(send, taskDraftOccupied);
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
  const retrySend = usePendingStagedSendRetry(send, stage);
  const sandboxId = stage?.createdSandboxId ?? "";
  const verb = usePendingSandboxStop(sandboxId);
  const activeVerbs = useIsMutatingOf({
    mutationKey: sandboxMutationKeys.verb(sandboxId),
  });
  const sandboxList = useSandboxList();
  const { openTile } = useEpicTileNavigation();
  const epicId = send.epicId;
  const run = useCallback((): void => {
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
    runner(surfaceKey, {
      taskId: epicId,
      resume: false,
      createKey: null,
    });
  }, [epicId, runner, send.id, surfaceKey]);
  const openTerminal = useCallback(
    (
      target: TerminalLaunchTarget,
      provenance: NestedFocusProvenance,
      issue: PendingTerminalCreateIssue,
    ): void => {
      openTile(
        tileIntent(
          mintPendingSandboxTerminalTile({ ...target, epicId }, send.id, issue),
          { tabId: props.tabId },
          "explicit",
          "direct_ui",
        ),
        provenance,
      );
    },
    [epicId, openTile, send.id, props.tabId],
  );
  const hostId = stage?.createdHostId ?? null;
  const terminalTarget = useFolderlessTerminalTarget(epicId, hostId);
  const terminalRow = usePendingSandboxRowFacts(
    stage?.createdSandboxId ?? null,
    send.userId,
    hostId,
    send.id,
  );
  const latestTerminalRow = useRef(terminalRow);
  useLayoutEffect(() => {
    latestTerminalRow.current = terminalRow;
  }, [terminalRow]);
  const newHost = useNewHostActions(surfaceKey, hostId, null, run);
  useOpenTerminalWhenUp(send, stage, terminalTarget, openTerminal);
  const cancelBoundSend = (): void => {
    if (actor === null) return;
    const current = (): boolean =>
      actor.accountId === send.userId &&
      draftAuthorityActorIsCurrent(actor) &&
      usePendingSandboxSendStore.getState().sends[send.id]?.outboxGeneration ===
        send.outboxGeneration &&
      stageObservationCurrent(surfaceKey, stage, send.stopStage);
    if (cancelInFlight.current || !current()) return;
    cancelInFlight.current = true;
    setCancelRefused(null);
    void returnPendingSandboxMessage(send.id, false, true, {
      browserComposer,
      onStorageRefused: () => {
        if (current()) setCancelRefused({ actor, generation: send.outboxGeneration, stage });
      },
    }).catch(() => undefined).finally(() => { cancelInFlight.current = false; });
  };
  if (
    cancelRefused !== null &&
    send.request.kind === "message" &&
    draftAuthorityActorIsCurrent(cancelRefused.actor) &&
    cancelRefused.generation === send.outboxGeneration &&
    stageObservationCurrent(surfaceKey, cancelRefused.stage, send.stopStage)
  )
    return <PendingReturnNotice send={send} failed retry={cancelBoundSend} />;
  if (stage === null || facts === null) {
    return <PendingSendMessage send={send} />;
  }
  const rowState =
    sandboxList.data?.sandboxes.find((row) => row.id === stage.createdSandboxId)
      ?.state ?? null;
  const backToComposer = (
    restage: boolean,
    pick: ReturnedSandboxPick | null,
  ): Promise<ReturnedPendingSandboxSend> => {
    return endSendBackToComposer({
      send,
      stage,
      tabId: props.tabId,
      restage,
      pick,
    });
  };
  const stop = (): void => {
    void stopPendingSend({
      send,
      stage,
      actor,
      stop: verb.stop,
      requested: () => {
        attention.current = {
          userId: send.userId,
          tabId: props.tabId,
        };
        stopAttention.set(send.id, attention.current);
      },
      refresh: () => sandboxList.refetch({ cancelRefetch: false }),
    }).catch(() => undefined);
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
    onChooseAnotherHost: () => {
      void backToComposer(false, null).catch(() => undefined);
    },
    chooseAnotherHostLabel: giveBackLabel,
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
              if (send.request.kind === "terminal" || send.request.kind === "fork") {
                if (
                  actor !== null &&
                  actor.accountId === send.userId &&
                  send.outboxGeneration !== undefined &&
                  stageObservationCurrent(surfaceKey, stage, send.stopStage)
                )
                  void cancelPendingSandboxIdleOutbox({
                    actor,
                    sendId: send.id,
                    expectedGeneration: send.outboxGeneration,
                  }).catch(() => undefined);
                return;
              }
              if (send.request.kind === "message") {
                cancelBoundSend();
                return;
              }
              const current = readStagedSandbox(surfaceKey);
              if (current === null) return;
              void backToComposer(
                false,
                stagedCancelStartsOver(surfaceKey, current)
                  ? {
                      kind: "stage",
                      target: current.target,
                      clientRequestId: newStagedSandboxKey(),
                    }
                  : returnedSandboxPick(
                      send,
                      current,
                      current.createdSandboxId === stage.createdSandboxId
                        ? rowState
                        : null,
                    ),
              ).then((returned) => {
                if (returned.kind !== "none" && returned.kind !== "dispatching")
                  recordCancelledSandboxSend(send, returned);
              }).catch(() => undefined);
            },
            onChooseAnotherHost: lineRemedies.onChooseAnotherHost,
            chooseAnotherHostLabel: lineRemedies.chooseAnotherHostLabel,
            onRetryCreation: () => retrySend("retry-creation"),
            onRetry: () => retrySend("retry-stage"),
            onSendAgain: () => retrySend("send-again"),
            onChangeShape: stagedShapeChangeAction(surfaceKey, stage, () => {
              void backToComposer(true, null).catch(() => undefined);
            }),
            onRetryApplying: newHost.onRetryApplying,
            onRepairSetup: newHost.onRepairSetup,
            repairSetupPending: newHost.repairSetupPending,
            applyingPending: newHost.applyingPending,
            applyingError: newHost.applyingError,
            onStop: stop,
            onOpenTerminal:
              terminalTarget === null
                ? null
                : () => {
                    void openManualPendingTerminal({
                      actor,
                      send,
                      stage,
                      target: terminalTarget,
                      row: terminalRow,
                      readRow: () => latestTerminalRow.current,
                      openTerminal,
                    }).catch(() => undefined);
                  },
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

type OpenPendingTerminal = (
  target: TerminalLaunchTarget,
  provenance: NestedFocusProvenance,
  issue: PendingTerminalCreateIssue,
) => void;

function pendingTerminalIssue(
  actor: DraftAuthorityActor,
  claim: DraftAuthorityIssueReceipt,
  target: TerminalLaunchTarget,
  terminalId: string,
  isCurrent: () => boolean,
  accepted: () => void,
): PendingTerminalCreateIssue {
  const uncertain = (): void => {
    void settlePendingSandboxOutboxEffect(actor, claim, "uncertain").catch(
      () => undefined,
    );
  };
  return {
    verify: async () =>
      (await verifyPendingSandboxOutboxGrant(actor, claim)) && isCurrent(),
    isCurrent,
    isActorCurrent: () => draftAuthorityActorIsCurrent(actor),
    accepted,
    uncertain,
    denied: () => {
      if (draftAuthorityActorIsCurrent(actor))
        useEpicCanvasStore
          .getState()
          .unmarkTerminalPendingCreate(target.hostId, terminalId);
      uncertain();
    },
  };
}

async function openManualPendingTerminal(input: {
  readonly actor: DraftAuthorityActor | null;
  readonly send: PendingSandboxSend;
  readonly stage: StagedSandbox;
  readonly target: TerminalLaunchTarget;
  readonly row: PendingSandboxRowFacts;
  readonly readRow: () => PendingSandboxRowFacts;
  readonly openTerminal: OpenPendingTerminal;
}): Promise<void> {
  const { actor, send, stage, target, row, openTerminal } = input;
  if (
    actor === null ||
    actor.accountId !== send.userId ||
    send.request.kind === "terminal" ||
    target.hostId !== stage.createdHostId ||
    row.row === null ||
    row.row.id !== stage.createdSandboxId ||
    row.row.hostId !== target.hostId
  )
    return;
  const surfaceKey = pendingSendSurfaceKey(send.id);
  const canIssue = (): boolean => {
    if (
      !draftAuthorityActorIsCurrent(actor) ||
      !stageObservationCurrent(surfaceKey, stage, undefined)
    )
      return false;
    const live = input.readRow();
    if (
      live.row === null ||
      live.row.id !== stage.createdSandboxId ||
      live.row.hostId !== target.hostId
    )
      return false;
    const facts = pendingSandboxSendFacts(
      send.id,
      sandboxEnvironment(live, UNKNOWN_PENDING_SEND_FACTS),
    );
    return facts.current && facts.accountActive && facts.host === "awake";
  };
  if (!canIssue()) return;
  const outbox = await loadPendingSandboxOutbox(actor, send);
  if (
    outbox === null ||
    outbox.decision.kind !== "waiting" ||
    (send.outboxGeneration !== undefined &&
      send.outboxGeneration !== outbox.generation)
  )
    return;
  const operationId = uuidv4();
  const terminalId = pendingSandboxTerminalId(send.id);
  const claim = await claimPendingSandboxOutboxEffect({
    actor,
    send,
    operationId,
    expectedOutboxGeneration: outbox.generation,
    effect: {
      kind: "terminal",
      phase: outbox.ownership,
      identity: operationId,
      payload: { ...target, epicId: send.epicId, terminalId },
    },
    canIssue,
  });
  if (claim === null || !canIssue()) return;
  openTerminal(
    target,
    "user",
    pendingTerminalIssue(actor, claim, target, terminalId, canIssue, () => {
      void settlePendingSandboxOutboxEffect(actor, claim, "accepted").catch(
        () => undefined,
      );
    }),
  );
}

const pendingTerminalAttempts = new Set<string>();

async function pendingTerminalObserved(input: {
  readonly actor: DraftAuthorityActor;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly terminalId: string;
  readonly epicId: string;
  readonly hostId: string;
}): Promise<boolean> {
  const { actor, client, terminalId, epicId, hostId } = input;
  if (
    client === null ||
    client.getActiveHostId() !== hostId ||
    !draftAuthorityActorIsCurrent(actor)
  )
    return false;
  const scope = { kind: "epic" as const, epicId };
  let seen: boolean;
  const version = readNegotiatedMethodVersion(hostId, "terminal.plain.list");
  if (version === null) return false;
  if (version !== false) {
    const list = await client.request("terminal.plain.list", { scope });
    seen = list.terminals.some(
      ({ record }) => record.hostId === hostId && record.terminalId === terminalId,
    );
  } else {
    const list = await fetchIsolatedLegacyTerminalList({ client, scope });
    seen = list.sessions.some((session) => session.sessionId === terminalId);
  }
  return (
    seen &&
    client.getActiveHostId() === hostId &&
    draftAuthorityActorIsCurrent(actor)
  );
}

/** Open once. Retire the request only when the exact terminal is observed. */
function useOpenTerminalWhenUp(
  send: PendingSandboxSend | null,
  stage: StagedSandbox | null,
  target: TerminalLaunchTarget | null,
  openTerminal: OpenPendingTerminal,
): void {
  const sendId = send?.request.kind === "terminal" ? send.id : null;
  const userId = send?.userId ?? null;
  const surfaceKey = sendId === null ? "" : pendingSendSurfaceKey(sendId);
  const owned = usePendingTerminalOwnership(sendId, userId, surfaceKey);
  const sandboxRow = usePendingTerminalSandbox(send, stage, owned);
  const hostId = sandboxRow.hostId;
  const client = useHostClientForHostId(hostId);
  const jobs = useSyncExternalStore(
    subscribeEpicTerminalDurableCreates,
    getEpicTerminalDurableCreateJobsSnapshot,
    getEpicTerminalDurableCreateJobsSnapshot,
  );
  const cwd = target?.cwd ?? null;
  const terminalReady = sandboxRow.ready && target?.hostId === hostId;
  const latestTerminalReadiness = useRef({ sandboxRow, target });
  useLayoutEffect(() => {
    latestTerminalReadiness.current = { sandboxRow, target };
  }, [sandboxRow, target]);
  useEffect(() => {
    if (!owned || send === null || sendId === null || hostId === null) return;
    const actor = captureDraftAuthorityActor();
    if (actor === null || actor.accountId !== send.userId) return;
    const terminalId = pendingSandboxTerminalId(sendId);
    if (pendingTerminalAttempts.has(sendId)) return;
    const canIssue = (): boolean => {
      const latest = latestTerminalReadiness.current;
      if (
        cwd === null ||
        !terminalReady ||
        !latest.sandboxRow.ready ||
        latest.target === null ||
        latest.target.hostId !== hostId ||
        latest.target.cwd !== cwd ||
        !draftAuthorityActorIsCurrent(actor) ||
        !stageObservationCurrent(surfaceKey, stage, undefined)
      )
        return false;
      const current = readPendingSandboxSend(sendId);
      const currentStage = readStagedSandbox(surfaceKey);
      if (current === undefined) return false;
      const facts = pendingSandboxSendFacts(sendId, {
        ...latest.sandboxRow.environment,
        clientReady: true,
        stageStatus: currentStage?.phase ?? "missing",
        stageCurrent:
          currentStage?.createdHostId === hostId &&
          currentStage.phase === "handoff",
      });
      return transitionPendingSend(
        pendingSendState(current, stageBlocker(currentStage)),
        "observe",
        facts,
      ).effects.includes("open-terminal");
    };
    pendingTerminalAttempts.add(sendId);
    void finishPendingSandboxTerminal(actor, send, (effect) => {
      if (effect.identity !== terminalId || effect.payload.hostId !== hostId)
        return Promise.resolve(false);
      return pendingTerminalObserved({
        actor,
        client,
        terminalId,
        epicId: send.epicId,
        hostId,
      });
    })
      .then(async (retired) => {
        if (retired) {
          useStagedSandboxStore.getState().clear(surfaceKey);
          return;
        }
        if (cwd === null || !canIssue()) return;
        const claim = await claimPendingSandboxOutboxEffect({
          actor,
          send,
          operationId: `${sendId}:terminal`,
          effect: {
            kind: "terminal",
            phase: "setup",
            identity: terminalId,
            payload: { hostId, cwd, epicId: send.epicId, terminalId },
          },
          canIssue,
        });
        if (claim === null || !canIssue()) return;
        const launch = { hostId, cwd };
        openTerminal(
          launch,
          "automatic",
          pendingTerminalIssue(actor, claim, launch, terminalId, canIssue, () => {
            void finishPendingSandboxTerminal(actor, send, (effect) => {
              if (effect.identity !== terminalId || effect.payload.hostId !== hostId)
                return Promise.resolve(false);
              return pendingTerminalObserved({
                actor,
                client,
                terminalId,
                epicId: send.epicId,
                hostId,
              });
            })
              .then((retired) => {
                if (retired) useStagedSandboxStore.getState().clear(surfaceKey);
              })
              .catch(() => undefined);
          }),
        );
      })
      .catch(() => undefined)
      .finally(() => pendingTerminalAttempts.delete(sendId));
  }, [
    client,
    cwd,
    hostId,
    jobs,
    openTerminal,
    owned,
    sandboxRow.environment,
    send,
    sendId,
    stage,
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
async function endSendBackToComposer(input: {
  readonly send: PendingSandboxSend;
  readonly stage: StagedSandbox;
  readonly tabId: string;
  readonly restage: boolean;
  readonly pick: ReturnedSandboxPick | null;
  readonly modelPickerHarnessId?: GuiHarnessId;
}): Promise<ReturnedPendingSandboxSend> {
  const { send } = input;
  const actor = captureDraftAuthorityActor();
  if (actor === null || actor.accountId !== send.userId) return { kind: "none" };
  if (
    input.modelPickerHarnessId !== undefined &&
    isNewConversationDraftOccupied(
      useNewConversationModalStore.getState().draftPatchesByEpicId[send.epicId],
    )
  )
    return { kind: "none" };
  const returned =
    input.pick === null
      ? await returnPendingSandboxSend(send.id)
      : await returnPendingSandboxSendToSandbox(send.id, input.pick);
  if (returned.kind === "task" && draftAuthorityActorIsCurrent(actor))
    openReturnedPendingComposer({
      ...input,
      modelPickerHarnessId: input.modelPickerHarnessId,
      returned,
    });
  return returned;
}

function openReturnedPendingComposer(input: {
  readonly send: PendingSandboxSend;
  readonly stage: StagedSandbox;
  readonly tabId: string;
  readonly restage: boolean;
  readonly modelPickerHarnessId: GuiHarnessId | undefined;
  readonly returned: Extract<ReturnedPendingSandboxSend, { kind: "task" }>;
}): void {
  const { send, returned } = input;
  if (input.restage) {
    const key = newConversationSurfaceKey(send.epicId);
    useStagedSandboxStore.getState().stage(key, input.stage.target);
    openStagedShapeSheet(key, input.stage.failure?.kind === "shape");
  }
  useNewConversationModalOpenStore.getState().open({
    epicId: send.epicId,
    tabId: input.tabId,
    placement: returned.placement,
    parentId: returned.parentId,
    // Unnamed: a named host stages nothing, and refuses to send while it rests.
    hostId: null,
    modelPickerHarnessId: input.modelPickerHarnessId,
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
