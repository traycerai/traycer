import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type {
  AcceptedChatAction,
  FailedSendRestorationState,
} from "@/stores/chats/chat-session-store";
import type { InitialChatHandoff } from "@/stores/epics/initial-chat-handoff-store";

/**
 * Pure policy for the initial-chat-handoff state machine.
 *
 * The chat tile drives the machine forward by feeding it `(handoff,
 * ctx)` after every render. The function returns one of a small fixed
 * set of `HandoffStep` actions; the driver hook executes the side
 * effects. Splitting the policy out makes each transition unit-testable
 * without mounting a React component.
 *
 * Policy summary (matches the in-flight machine in the store):
 *
 *   pending → waitingProjection → waitingChat
 *      └── (driver may be terminated by markFailed at any of the above)
 *   waitingChat (here) → tile mounts → "send"
 *   "send" → markSending → driver returns "noop" until the host acks
 *   "sending" + acceptedAction("send") → "consume"
 *   "sending" + message in messages[] → "consume"
 *   any state + failedSendRestoration matches → "markFailedByAction"
 *   failedSendRestoration exists → "restoreAndAckFailed" (idempotent;
 *      the chat-session-store's ackFailedSendRestoration clears the slot)
 */
export type HandoffStep =
  | { readonly kind: "noop" }
  | { readonly kind: "send" }
  | { readonly kind: "consume"; readonly clientActionId: string | null }
  | {
      readonly kind: "markFailedByAction";
      readonly clientActionId: string;
      readonly reason: string;
    }
  | {
      readonly kind: "restoreAndAckFailed";
      readonly clientActionId: string;
      readonly content: FailedSendRestorationState["content"];
    };

export interface HandoffTransitionContext {
  readonly nodeId: string;
  readonly snapshotLoaded: boolean;
  readonly canAct: boolean;
  readonly acceptedActions: Readonly<Record<string, AcceptedChatAction>>;
  readonly messages: ReadonlyArray<Message>;
  readonly failedSendRestoration: FailedSendRestorationState | null;
}

/**
 * The chat-tile renders frequently; for ordering we evaluate the
 * `failedSendRestoration` branch FIRST so a stale failed send is
 * cleared before any send→consume transition runs.
 */
export function nextHandoffTransition(
  handoff: InitialChatHandoff | null,
  ctx: HandoffTransitionContext,
): HandoffStep {
  // Failed-send restoration is one-shot: the chat-session-store clears
  // the slot when `ackFailedSendRestoration` runs, so the next render
  // sees `failedSendRestoration === null`. The two-step transition fires
  // `markFailedByAction` first (only when the handoff has not already
  // been moved to `failed`) so the originating handoff sees the failure
  // before the prompt restore consumes the slot.
  if (ctx.failedSendRestoration !== null) {
    return failedSendStep(handoff, ctx, ctx.failedSendRestoration);
  }

  if (handoff === null || handoff.chatId !== ctx.nodeId) {
    return { kind: "noop" };
  }

  if (handoff.status === "waitingChat") {
    if (!ctx.snapshotLoaded || !ctx.canAct) {
      return { kind: "noop" };
    }
    return { kind: "send" };
  }

  if (handoff.status === "sending") {
    return sendingStep(handoff, ctx);
  }

  return { kind: "noop" };
}

function failedSendStep(
  handoff: InitialChatHandoff | null,
  ctx: HandoffTransitionContext,
  failed: FailedSendRestorationState,
): HandoffStep {
  if (
    handoff !== null &&
    handoff.chatId === ctx.nodeId &&
    handoff.status !== "failed" &&
    handoff.clientActionId === failed.clientActionId
  ) {
    return {
      kind: "markFailedByAction",
      clientActionId: failed.clientActionId,
      reason: failed.reason,
    };
  }
  return {
    kind: "restoreAndAckFailed",
    clientActionId: failed.clientActionId,
    content: failed.content,
  };
}

function sendingStep(
  handoff: InitialChatHandoff,
  ctx: HandoffTransitionContext,
): HandoffStep {
  if (handoff.clientActionId !== null) {
    const ack = Object.hasOwn(ctx.acceptedActions, handoff.clientActionId)
      ? ctx.acceptedActions[handoff.clientActionId]
      : null;
    if (ack?.action === "send") {
      return { kind: "consume", clientActionId: handoff.clientActionId };
    }
  }
  if (
    ctx.messages.some(
      (message) =>
        message.role === "user" && message.messageId === handoff.messageId,
    )
  ) {
    return { kind: "consume", clientActionId: handoff.clientActionId };
  }
  return { kind: "noop" };
}
