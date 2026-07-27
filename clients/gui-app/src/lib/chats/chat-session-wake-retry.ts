import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import {
  subscribeWakeSignals,
  type WakeSignalReason,
} from "@/lib/host/stream-wake-reconnect";
import { onWakeReconnect } from "@/lib/host/wake-reconnect";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { appLogger, describeLogError } from "@/lib/logger";

/**
 * One physical wake fans out as several pulses: the desktop shell fires the
 * resume AND unlock-screen bridges, and the `online` event lands after its own
 * ~250ms debounce. A live session absorbs that (`forceReconnect` is cheap and
 * idempotent), but a retry is a full stream-client rebuild, and a permanently
 * fatal session (e.g. INCOMPATIBLE) re-closes fast enough to be re-attempted
 * by every pulse. Handles attempted within this window are skipped, folding
 * the burst into one dial per wake.
 */
export const WAKE_RETRY_EPISODE_MS = 5_000;

/**
 * Re-dials warm chat sessions whose stream went TERMINALLY closed, on the OS
 * wake pulse. Every non-closed status self-heals on wake (the durable
 * transport's `subscribeStreamWakeReconnect` force-reconnects live sessions),
 * but a `closed` session's `StreamSession` is disposed - no timer will ever
 * fire again - and the tile only surfaces a retry affordance while the
 * snapshot never loaded. A warm tile (snapshot on screen) whose stream went
 * terminal during a sleep - e.g. the transport's bounded UNAUTHORIZED give-up,
 * whose own log says "reload required" - therefore kept its composer, next
 * steps, and approvals dead until an app relaunch. Waking is exactly the
 * moment the conditions that killed the stream (frozen timers, an expired
 * bearer, a half-open authn socket) are gone, so give each dead session one
 * fresh dial per wake; `retry()` rebuilds the stream client with live deps.
 * Bounded: a close that is genuinely permanent (e.g. INCOMPATIBLE) re-closes
 * once per wake episode and goes back to rest.
 *
 * Returns the handles that were ATTEMPTED (successfully re-dialed or not), so
 * the caller can stamp them into the episode window. A throwing `retry()` is
 * contained per handle - one broken session must not block the rest of the
 * registry from recovering.
 */
export function retryClosedChatSessions(
  handles: readonly ChatSessionStoreHandle[],
  reason: WakeSignalReason,
): ChatSessionStoreHandle[] {
  const attempted: ChatSessionStoreHandle[] = [];
  for (const handle of handles) {
    const state = handle.store.getState();
    if (state.connectionStatus !== "closed") {
      continue;
    }
    appLogger.info("[chat-session] wake retry for closed session", {
      reason,
      epicId: handle.epicId,
      chatId: handle.chatId,
      fatalCode: state.fatalClose?.code ?? null,
    });
    attempted.push(handle);
    try {
      state.retry();
    } catch (cause) {
      // `retry()` restored the session to a retryable closed state before
      // rethrowing; a later pulse can attempt it again.
      appLogger.warn("[chat-session] wake retry failed", {
        epicId: handle.epicId,
        chatId: handle.chatId,
        error: describeLogError(cause),
      });
    }
  }
  return attempted;
}

/**
 * Wires `retryClosedChatSessions` over the live registry to the two OS-wake
 * triggers, with the per-wake episode dedupe. Returns a disposer. Mounted once
 * per window by `ChatSessionWakeRetryController`. The OS-resume wiring is
 * best-effort (mirroring the auth service's wake refresh): with no runner host
 * (host-less test harness) or a throwing resume subscription, the `online`
 * listener alone still nudges dead sessions when the network returns.
 */
export function subscribeChatSessionWakeRetry(
  runnerHost: IRunnerHost | null,
): () => void {
  const lastAttemptAt = new WeakMap<ChatSessionStoreHandle, number>();
  const onWake = (reason: WakeSignalReason): void => {
    const now = Date.now();
    const due = getChatSessionRegistry()
      .listHandles()
      .filter((handle) => {
        const last = lastAttemptAt.get(handle);
        return last === undefined || now - last >= WAKE_RETRY_EPISODE_MS;
      });
    for (const handle of retryClosedChatSessions(due, reason)) {
      lastAttemptAt.set(handle, now);
    }
  };
  if (runnerHost !== null) {
    try {
      return subscribeWakeSignals(runnerHost, onWake);
    } catch (cause) {
      appLogger.warn("[chat-session] OS-resume wake retry unavailable", {
        error: describeLogError(cause),
      });
    }
  }
  return onWakeReconnect(() => {
    onWake("wake-online");
  });
}
