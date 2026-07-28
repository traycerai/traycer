import type { GuiAgentCommandOption } from "@traycer/protocol/host/index";
import type {
  ChatQueuedItem,
  ChatQueueState,
} from "@traycer/protocol/host/agent/gui/subscribe";

import { isOptimisticQueuedItem } from "@/stores/chats/optimistic-queue";

/**
 * Whether the user can trigger compaction on this harness, as opposed to the
 * harness only ever compacting on its own.
 *
 * `providerKind: "compaction"` is the marker every adapter stamps on its native
 * compaction command - hardcoded for codex/opencode/traycer/openrouter/omp/pi,
 * derived from the ACP handshake list for grok/kimi/kiro/qwen/kilocode/hermes/
 * devin, and from the SDK command catalog for claude.
 *
 * Copilot deliberately reads `false`: it compacts automatically and advertises
 * no command, so it supports compaction but not on demand. amp, droid and
 * cursor have no compaction at all.
 */
export function findManualCompactCommand(
  commands: ReadonlyArray<GuiAgentCommandOption>,
): GuiAgentCommandOption | null {
  return (
    commands.find(
      (command) => command.metadata.providerKind === "compaction",
    ) ?? null
  );
}

/**
 * How long to wait for the host to acknowledge a freshly queued message before
 * giving up on reordering it. Generous: the only cost of waiting is that the
 * message sits at the back of the queue for longer than intended.
 */
const QUEUE_PROMOTION_TIMEOUT_MS = 15_000;

function isAuthoritative(item: ChatQueuedItem): boolean {
  return !isOptimisticQueuedItem(item);
}

/**
 * Moves a just-sent queued message to the front of the queue.
 *
 * `sendMessage` appends its item optimistically and the host assigns the real
 * `queueItemId` only when the `queueChanged` frame lands, so the reorder cannot
 * be issued inline - `queueReorder` against an optimistic id has no server-side
 * target. This watches the queue until the authoritative item appears, issues a
 * single reorder, and stops.
 *
 * Failure is deliberately inert: if the frame never arrives the watch expires
 * and the message simply stays where it was queued - last rather than first,
 * which is a worse ordering but never a lost or duplicated message.
 *
 * The reorder can also land after its target has drained (the turn ends and
 * the host works through the head of the queue between the read below and the
 * frame arriving). The host's own reorder handler falls back to appending at
 * the end when `beforeQueueItemId` no longer exists, so in that narrow window
 * the message can end up behind work queued after the promotion was
 * requested - bounded and rare, never lost or duplicated.
 *
 * Returns a cancel function; call it if the surface unmounts first.
 */
export function promoteQueuedMessageToFront<
  TState extends { readonly queue: ChatQueueState },
>(input: {
  /**
   * Structural rather than the concrete `ChatSessionStoreHandle["store"]`: this
   * only ever reads `queue`, and narrowing the surface is what lets the tests
   * drive it without standing up a whole chat session.
   */
  readonly store: {
    readonly getState: () => TState;
    readonly subscribe: (listener: (state: TState) => void) => () => void;
  };
  readonly messageId: string;
  readonly reorder: (
    queueItemId: string,
    beforeQueueItemId: string | null,
  ) => string | null;
}): () => void {
  let settled = false;
  let unsubscribe: (() => void) | null = null;
  let timer: number | null = null;

  const finish = (): void => {
    if (settled) return;
    settled = true;
    if (timer !== null) window.clearTimeout(timer);
    unsubscribe?.();
  };

  // Returns true once there is nothing further to do - either the reorder was
  // issued, or the message is already first, or it can never be reordered.
  const attempt = (state: TState): boolean => {
    // Optimistic rows are skipped on BOTH sides: our own row is unreorderable
    // until the host names it, and an optimistic row belonging to some other
    // in-flight send is an invalid `beforeQueueItemId` to aim at.
    const settledItems = state.queue.items.filter(isAuthoritative);
    // Only prompt items carry a `messageId`; a managed-command delivery is
    // content-free and can never be the compaction message we are hunting for.
    // It stays in `settledItems` because it is still a valid reorder TARGET.
    const index = settledItems.findIndex(
      (item) => item.kind === "prompt" && item.messageId === input.messageId,
    );
    if (index === -1) return false;
    // Index >= 1 guarantees a distinct item at 0 to insert ahead of, right
    // now - see the reorder-can-land-late note above for what can change
    // between this read and the frame reaching the host.
    if (index === 0) return true;
    input.reorder(settledItems[index].queueItemId, settledItems[0].queueItemId);
    return true;
  };

  // The store has no `subscribeWithSelector`, so this fires on every state
  // change - including the rAF-cadence stream-flush delta while a turn is
  // running. `queue` is only ever replaced wholesale on a real queue
  // mutation, so a reference check skips `attempt()`'s filter+scan on every
  // unrelated notification for the (up to 15s) life of the watch.
  let lastQueue = input.store.getState().queue;
  unsubscribe = input.store.subscribe((state) => {
    if (settled) return;
    if (state.queue === lastQueue) return;
    lastQueue = state.queue;
    if (attempt(state)) finish();
  });
  timer = window.setTimeout(finish, QUEUE_PROMOTION_TIMEOUT_MS);
  // The host may already have acknowledged the send by the time this runs.
  if (attempt(input.store.getState())) finish();

  return finish;
}
