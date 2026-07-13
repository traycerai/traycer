import type { GuiHarnessId } from "@traycer/protocol/host/index";
import {
  isChatSessionSettled,
  type ChatSessionState,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import { reconcileStoreSubscriptions } from "@/lib/registries/reconcile-store-subscriptions";

const CHAT_REGISTRY = getChatSessionRegistry();

export interface ChatTurnCompletion {
  readonly epicId: string;
  readonly chatId: string;
  readonly chatTitle: string | null;
  readonly harnessId: GuiHarnessId | null;
}

type ChatRunInputs = Pick<
  ChatSessionState,
  "runStatus" | "activeTurn" | "queue" | "connectionStatus"
>;

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

export interface TurnNotifyState {
  readonly armed: boolean;
  readonly stopRequested: boolean;
}

export const INITIAL_TURN_NOTIFY_STATE: TurnNotifyState = {
  armed: false,
  stopRequested: false,
};

export function seedTurnNotifyState(phase: ChatTurnPhase): TurnNotifyState {
  return { armed: phase.runningTurn, stopRequested: phase.stopping };
}

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
