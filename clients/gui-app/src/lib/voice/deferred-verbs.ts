import type { BoundTarget } from "@/lib/voice/directory";
import {
  runVoiceQueueVerb,
  type QueueVerbOutcome,
} from "@/lib/voice/queue-verbs";
import type { DeferredVerb } from "@/lib/voice/router";
import {
  useVoiceSessionStore,
  waitingItems,
} from "@/stores/voice/voice-session-store";

/**
 * What became of a verb the router recognised: done, or refused with what
 * the voice tells the person. Either way nothing is posted and the words are
 * spent.
 */
export type VerbOutcome =
  | { readonly kind: "executed" }
  | { readonly kind: "refused"; readonly say: string };

export const NOTHING_WAITING_NOTICE = "Nothing is waiting to be read.";
export const NO_BOT_NOTICE = "Which bot? Say its name.";
export const NOT_LIVE_NOTICE = "The voice is not connected. Nothing was done.";
export const NOTHING_TO_OPEN_NOTICE = "Nothing is waiting for you to open.";

/**
 * The executor of `read`, `later`, `brief`, `status` and `open`, all run on
 * the voice's queue through `runVoiceQueueVerb`, the same executor the
 * Waiting control's buttons run, under the delegation of the request they
 * answer. `open` (VT5) reads a question or an approval back as the active
 * card; `read` of one does too, in the queue's executor.
 */
export function executeDeferredVerb(input: {
  readonly verb: DeferredVerb;
  readonly target: BoundTarget | null;
  readonly itemId: string | null;
  /** Whether the route named a thread itself, rather than inheriting the focus's. */
  readonly threadNamed: boolean;
  readonly delegationId: string | null;
}): VerbOutcome {
  const { verb, target, delegationId } = input;
  switch (verb) {
    case "read":
    case "later": {
      // A route that names a bot (or thread) and no item means that bot's
      // newest waiting item; with none, nothing, never another bot's. An
      // item the route names is checked against the queue as it is now: the
      // route was made from an earlier snapshot, and the item may have been
      // heard or set aside since.
      const itemId = input.itemId ?? newestWaitingOf(target, input.threadNamed);
      if (input.itemId === null && target !== null && itemId === null) {
        return { kind: "refused", say: NOTHING_WAITING_NOTICE };
      }
      if (input.itemId !== null && !isStillWaiting(input.itemId)) {
        return { kind: "refused", say: NOTHING_WAITING_NOTICE };
      }
      const outcome =
        verb === "read"
          ? runVoiceQueueVerb({ kind: "read", itemId, delegationId })
          : runVoiceQueueVerb({ kind: "later", itemId });
      return outcomeOf(outcome, NOTHING_WAITING_NOTICE);
    }
    case "brief":
      return outcomeOf(
        runVoiceQueueVerb({ kind: "brief", delegationId }),
        NOTHING_WAITING_NOTICE,
      );
    case "status":
      return outcomeOf(
        runVoiceQueueVerb({
          kind: "status",
          botId: target?.tuple.botId ?? null,
          delegationId,
        }),
        NO_BOT_NOTICE,
      );
    case "open":
      return openVerb(input);
  }
}

/**
 * `open`: a route that names no item opens the newest waiting card of the
 * bot (or thread) it names, else of all; with no card waiting, the newest
 * item, which is switched to.
 */
function openVerb(input: {
  readonly target: BoundTarget | null;
  readonly itemId: string | null;
  readonly threadNamed: boolean;
  readonly delegationId: string | null;
}): VerbOutcome {
  const itemId =
    input.itemId ?? newestOpenableOf(input.target, input.threadNamed);
  if (itemId === null || !isStillWaiting(itemId)) {
    return { kind: "refused", say: NOTHING_TO_OPEN_NOTICE };
  }
  return outcomeOf(
    runVoiceQueueVerb({
      kind: "open",
      itemId,
      delegationId: input.delegationId,
    }),
    NOTHING_TO_OPEN_NOTICE,
  );
}

/**
 * The newest waiting card (a question or a surfaced prompt) of the bot and
 * thread a route names, of every bot with none named; else the newest
 * waiting item there. `null` when nothing waits there.
 */
function newestOpenableOf(
  target: BoundTarget | null,
  threadNamed: boolean,
): string | null {
  const waiting = waitingItems(useVoiceSessionStore.getState().queue).filter(
    (candidate) =>
      target === null ||
      (candidate.botId === target.tuple.botId &&
        (!threadNamed || candidate.threadId === target.tuple.threadId)),
  );
  const card = waiting.find(
    (candidate) => candidate.kind === "question" || candidate.kind === "surface",
  );
  return (card ?? waiting.at(0))?.id ?? null;
}

/**
 * The newest waiting item of the bot a route names, of the thread too when
 * the route named one; `null` when it names no bot (the queue then takes
 * the newest waiting item of all) or that bot has none waiting. A bot-only
 * route searches all of the bot's threads: its bound thread is the focus's,
 * not the person's choice.
 */
function newestWaitingOf(
  target: BoundTarget | null,
  threadNamed: boolean,
): string | null {
  if (target === null) return null;
  const { botId, threadId } = target.tuple;
  const item = waitingItems(useVoiceSessionStore.getState().queue).find(
    (candidate) =>
      candidate.botId === botId &&
      (!threadNamed || candidate.threadId === threadId),
  );
  return item?.id ?? null;
}

/** Whether the queue holds `itemId` now, and it still waits (queued or offered). */
function isStillWaiting(itemId: string): boolean {
  const item = useVoiceSessionStore
    .getState()
    .queue.find((candidate) => candidate.id === itemId);
  return item?.state === "queued" || item?.state === "offered";
}

function outcomeOf(outcome: QueueVerbOutcome, nothing: string): VerbOutcome {
  switch (outcome) {
    case "appended":
    case "navigated":
    case "dismissed":
      return { kind: "executed" };
    case "nothing":
      return { kind: "refused", say: nothing };
    case "not-live":
      return { kind: "refused", say: NOT_LIVE_NOTICE };
  }
}
