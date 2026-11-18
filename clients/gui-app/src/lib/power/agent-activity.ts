import {
  isChatRunInProgress,
  type ChatSessionState,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import type {
  TerminalSessionState,
  TerminalSessionStoreHandle,
} from "@/stores/terminals/terminal-session-store";
import {
  getChatSessionHandleHostId,
  getChatSessionRegistry,
} from "@/lib/registries/chat-session-registry";
import {
  getTerminalSessionHandleHostId,
  getTerminalSessionRegistry,
} from "@/lib/registries/terminal-session-registry";
import { reconcileStoreSubscriptions } from "@/lib/registries/reconcile-store-subscriptions";

/**
 * "Is any local agent in progress" for this window: a local-host chat turn is
 * running (or stopping), or a local-host terminal-agent PTY has not exited.
 * Plain terminals are excluded - an idle shell left open must not pin the
 * machine awake. Combined with the user's "Prevent sleep while running"
 * setting, this is the signal the `PreventSleepController` pushes to the host
 * so main holds the OS power-save blocker (see desktop `sleep-blocker`).
 *
 * Exposed as a `useSyncExternalStore`-shaped pair. A single subscription has to
 * track two moving targets: which sessions exist (registry membership) and the
 * run state inside each (the per-session store). The registry `subscribe` fires
 * on add / remove; per-store subscriptions, reconciled on every membership
 * change, fire only when the per-session activity predicate changes.
 */

const CHAT_REGISTRY = getChatSessionRegistry();
const TERMINAL_REGISTRY = getTerminalSessionRegistry();

export function getAgentActivitySnapshot(localHostId: string | null): boolean {
  if (localHostId === null) return false;
  for (const handle of CHAT_REGISTRY.listHandles()) {
    if (getChatSessionHandleHostId(handle) !== localHostId) continue;
    if (chatSessionActive(handle.store.getState())) return true;
  }
  for (const handle of TERMINAL_REGISTRY.listHandles()) {
    if (getTerminalSessionHandleHostId(handle) !== localHostId) continue;
    if (terminalSessionActive(handle.store.getState())) return true;
  }
  return false;
}

interface StoreHandle<State> {
  readonly store: {
    getState(): State;
    subscribe(listener: (state: State, prevState: State) => void): () => void;
  };
}

/**
 * Subscribe each live handle to a level predicate, firing `onChange` only when
 * that predicate flips. Membership churn is handled by the shared
 * `reconcileStoreSubscriptions`; this adds the per-handle activity edge.
 */
function reconcileHandleSubs<H extends StoreHandle<State>, State>(
  handles: readonly H[],
  subs: Map<H, () => void>,
  isActive: (state: State) => boolean,
  onChange: () => void,
): void {
  reconcileStoreSubscriptions(handles, subs, (handle) => {
    let previousActive = isActive(handle.store.getState());
    return handle.store.subscribe((state) => {
      const nextActive = isActive(state);
      if (nextActive === previousActive) return;
      previousActive = nextActive;
      onChange();
    });
  });
}

export function subscribeAgentActivity(
  localHostId: string | null,
  onChange: () => void,
): () => void {
  const chatSubs = new Map<ChatSessionStoreHandle, () => void>();
  const terminalSubs = new Map<TerminalSessionStoreHandle, () => void>();

  const resync = (): void => {
    reconcileHandleSubs(
      localHostId === null
        ? []
        : CHAT_REGISTRY.listHandles().filter(
            (handle) => getChatSessionHandleHostId(handle) === localHostId,
          ),
      chatSubs,
      chatSessionActive,
      onChange,
    );
    reconcileHandleSubs(
      localHostId === null
        ? []
        : TERMINAL_REGISTRY.listHandles().filter(
            (handle) => getTerminalSessionHandleHostId(handle) === localHostId,
          ),
      terminalSubs,
      terminalSessionActive,
      onChange,
    );
    onChange();
  };

  const unsubscribeChat = CHAT_REGISTRY.subscribe(resync);
  const unsubscribeTerminal = TERMINAL_REGISTRY.subscribe(resync);
  resync();

  return () => {
    unsubscribeChat();
    unsubscribeTerminal();
    for (const unsubscribe of chatSubs.values()) unsubscribe();
    for (const unsubscribe of terminalSubs.values()) unsubscribe();
    chatSubs.clear();
    terminalSubs.clear();
  };
}

function chatSessionActive(state: ChatSessionState): boolean {
  return isChatRunInProgress(state.runStatus);
}

function terminalSessionActive(state: TerminalSessionState): boolean {
  return state.kind === "terminal-agent" && state.status !== "exited";
}
