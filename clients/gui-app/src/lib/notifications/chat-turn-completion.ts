import type { GuiHarnessId } from "@traycer/protocol/host/index";
import {
  isChatSessionSettled,
  type ChatSessionState,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import { reconcileStoreSubscriptions } from "@/lib/registries/reconcile-store-subscriptions";

/**
 * Detect when a chat turn completes so the app can raise an OS notification
 * while it sits in the background. A single registry subscription tracks which
 * sessions exist; a per-session latch tracks the run-state edge inside each.
 */

const CHAT_REGISTRY = getChatSessionRegistry();

export interface ChatTurnCompletion {
  readonly epicId: string;
  readonly chatId: string;
  readonly chatTitle: string | null;
  // Harness the just-completed turn ran on, latched while it was active (the
  // `activeTurn` is null by the settled edge). Lets consumers act only on
  // turns of a given harness - e.g. credit refresh only for `"traycer"`.
  // Null if no running turn was observed (e.g. seeded mid-settle).
  readonly harnessId: GuiHarnessId | null;
}

type ChatRunInputs = Pick<
  ChatSessionState,
  "runStatus" | "activeTurn" | "queue" | "connectionStatus"
>;

/** Narrow projection of the run-state inputs the completion edge depends on. */
export interface ChatTurnPhase {
  readonly runningTurn: boolean;
  readonly stopping: boolean;
  readonly settled: boolean;
  readonly connectionClosed: boolean;
}

export function toChatTurnPhase(state: ChatRunInputs): ChatTurnPhase {
  return {
    runningTurn: state.runStatus === "running" && state.activeTurn !== null,
    stopping: state.runStatus === "stopping",
    settled: isChatSessionSettled(state),
    connectionClosed: state.connectionStatus === "closed",
  };
}

/**
 * Per-session latch: whether a turn we have not yet announced is (or was)
 * actively running, and whether a stop was requested during it.
 */
export interface TurnNotifyState {
  readonly armed: boolean;
  readonly stopRequested: boolean;
}

export const INITIAL_TURN_NOTIFY_STATE: TurnNotifyState = {
  armed: false,
  stopRequested: false,
};

/**
 * Seed the latch from the handle's current state so a turn already running when
 * we subscribe (e.g. opening a chat mid-turn) still counts toward the next
 * completion - its "running" frame predates our subscription and would
 * otherwise never be observed.
 */
export function seedTurnNotifyState(phase: ChatTurnPhase): TurnNotifyState {
  return { armed: phase.runningTurn, stopRequested: phase.stopping };
}

/**
 * Advance the latch by one phase, reporting whether a turn just completed.
 *
 * - A completion is the running→fully-settled edge. `armed` latches the "a turn
 *   ran" fact so it survives the inter-frame gap at the end of a queued run,
 *   where `runStatus` settles in one frame and the queue empties in the next;
 *   without it neither frame is a full edge and the notification is lost.
 * - A `"closed"` socket forces `runStatus`→idle locally without the turn
 *   finishing, so it is never a completion - it drops the latch (a reconnect
 *   snapshot re-arms if the turn is still running).
 * - `stopRequested` (a `"stopping"` phase) suppresses the notification so a
 *   user-aborted turn is not announced as "Done".
 */
export function advanceTurnNotify(
  prev: TurnNotifyState,
  phase: ChatTurnPhase,
): { readonly state: TurnNotifyState; readonly completed: boolean } {
  if (phase.connectionClosed) {
    return { state: INITIAL_TURN_NOTIFY_STATE, completed: false };
  }
  const armed = prev.armed || phase.runningTurn;
  const stopRequested = prev.stopRequested || phase.stopping;
  if (armed && phase.settled) {
    return { state: INITIAL_TURN_NOTIFY_STATE, completed: !stopRequested };
  }
  return { state: { armed, stopRequested }, completed: false };
}

/**
 * True when a store change touched a field the latch reads. Lets the per-session
 * listener skip the hot streaming path (token deltas mutate messages, not
 * run/queue/connection state) without projecting a phase on every emission.
 */
function turnInputsChanged(prev: ChatRunInputs, next: ChatRunInputs): boolean {
  return (
    prev.runStatus !== next.runStatus ||
    prev.connectionStatus !== next.connectionStatus ||
    prev.queue !== next.queue ||
    (prev.activeTurn === null) !== (next.activeTurn === null)
  );
}

function subscribeHandleCompletions(
  handle: ChatSessionStoreHandle,
  onComplete: (completion: ChatTurnCompletion) => void,
): () => void {
  let notifyState = seedTurnNotifyState(
    toChatTurnPhase(handle.store.getState()),
  );
  // Latch the running turn's harness so it survives the running→settled edge,
  // where `activeTurn` (and its `harnessId`) is already cleared.
  let runningHarnessId: GuiHarnessId | null =
    handle.store.getState().activeTurn?.harnessId ?? null;
  return handle.store.subscribe((state, prevState) => {
    if (!turnInputsChanged(prevState, state)) {
      return;
    }
    if (state.activeTurn !== null) {
      runningHarnessId = state.activeTurn.harnessId;
    }
    const result = advanceTurnNotify(notifyState, toChatTurnPhase(state));
    notifyState = result.state;
    if (result.completed) {
      onComplete({
        epicId: state.epicId,
        chatId: state.chatId,
        chatTitle: state.chat?.title ?? null,
        harnessId: runningHarnessId,
      });
      runningHarnessId = null;
    }
  });
}

/**
 * Subscribes to turn completions across every live chat session in this window.
 * Fires `onComplete` once per natural completion. Returns an unsubscribe fn.
 */
export function subscribeChatTurnCompletions(
  onComplete: (completion: ChatTurnCompletion) => void,
): () => void {
  const subs = new Map<ChatSessionStoreHandle, () => void>();
  const reconcile = (): void => {
    reconcileStoreSubscriptions(CHAT_REGISTRY.listHandles(), subs, (handle) =>
      subscribeHandleCompletions(handle, onComplete),
    );
  };
  const unsubscribeRegistry = CHAT_REGISTRY.subscribe(reconcile);
  reconcile();
  return () => {
    unsubscribeRegistry();
    for (const unsubscribe of subs.values()) unsubscribe();
    subs.clear();
  };
}
