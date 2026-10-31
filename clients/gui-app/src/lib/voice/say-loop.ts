import type { BotConversationSendResponse } from "@traycer/protocol/host/bot/conversation-schemas";
import type { StoreApi } from "zustand";
import { executeDeferredVerb } from "@/lib/voice/deferred-verbs";
import type { BoundTarget } from "@/lib/voice/directory";
import type {
  ControlVerb,
  RouteRefusal,
  RoutedDecision,
} from "@/lib/voice/router";
import {
  joinSegments,
  type TranscriptSegment,
  type VoiceFocus,
  type VoiceSessionState,
  type VoiceTargetTuple,
} from "@/stores/voice/voice-session-store";

/**
 * The say loop (Tracy Bots voice, VT2, routed in VT3): words become one
 * action.
 *
 * The vendor's delegation event closes the utterance. Each delegation makes
 * one ACTION, which reserves the segments open at that moment: they are its
 * alone, so a second delegation arriving while the first is in flight posts
 * only the words said since, and an acceptance consumes exactly what its
 * action reserved. A boundary is handled once per engine generation: the
 * same delegation id arriving again changes nothing. The router (`decide`)
 * chooses the action, its target and the span of the reserved words it acts
 * on; what posts is always that span of the person's own words, verbatim,
 * and the rest of the reservation is spent with it (a greeting before the
 * request, the answer to the voice's own question). `fragment` and `ask`
 * return the words to the open utterance for the next boundary. Without a
 * focus nothing is reserved, and the words wait for one. The commit
 * boundary is the send's acceptance: a thread the answer opens becomes the
 * focus if the person has not moved since, and a queued delivery is said as
 * "queued", never "paused". The app appends nothing for the acknowledgement:
 * the model's own automatic one is what the person hears.
 *
 * Every action carries the user session's token and the engine generation it
 * was made under. An acceptance after the session ENDED changes nothing in
 * the app (the post exists, as work) and says nothing. One after the engine
 * was REPLACED completes as pending work of the continuing session: its
 * thread is adopted under the selection fence, its request is bound for the
 * reply, and what the voice says about it goes under no delegation, since the
 * old engine's ids mean nothing to the new one.
 *
 * Every routed action binds its target as one tuple the directory vouched
 * for, and the selection generation; the tuple is checked again before it
 * executes. A manual selection change from the first segment through the
 * route to the send's acceptance interrupts: a route still out is dropped
 * (its completion navigates nothing and posts nothing) and its words join
 * the interruption, as does a post waiting for its confirmation.
 *
 * A manual selection change while an utterance is open interrupts it: the
 * words so far are held in `pendingAction`, never posted, and the voice asks
 * the person to say the request again. Until the person has HEARD that ask,
 * every boundary adds its words to the held ones (nothing told them to start
 * over, so their words are not a fresh request and are not thrown away); the
 * first boundary after the ask was heard closes the interruption, and the
 * one after that is a fresh request. If the ask can never be delivered, the
 * interruption resolves itself: the held words are let go, since the voice
 * cannot say anything about them, and the next request posts as usual. An
 * action already in flight lands where it was sent, and its acceptance says
 * so without reopening the old rail.
 */

export interface SayLoopDeps {
  readonly store: StoreApi<VoiceSessionState>;
  /** Posts `text` to the focus; rejects when the host refuses. */
  readonly send: (
    focus: VoiceFocus,
    text: string,
  ) => Promise<BotConversationSendResponse>;
  /**
   * What the voice tells the person about the request once it is quiet:
   * where the post landed when they moved, that it is queued. Under the
   * request's delegation while its engine lives, under none after a
   * replacement. Goes through the speech scheduler like every app-requested
   * utterance.
   */
  readonly notify: (text: string, delegationId: string | null) => void;
  /**
   * A question the voice puts to the person: after a move (under no
   * delegation), or before a routed post (under its request's). The
   * scheduler reports whether it was heard, or given up on.
   */
  readonly ask: (
    text: string,
    delegationId: string | null,
    outcome: AskOutcome,
  ) => void;
  /**
   * The router: one action for the reserved words, checked against the
   * directory. Rejects only on a transport failure, which is refused.
   */
  readonly decide: (request: RouteRequest) => Promise<RoutedDecision>;
  /** Whether a bound tuple still holds against the directory as it is now. */
  readonly recheck: (tuple: VoiceTargetTuple) => boolean;
  /** Opens the target's tab and sets its rail; the loop writes the focus. */
  readonly navigate: (target: BoundTarget) => void;
  /**
   * State the voice needs about a request and need not say as an answer:
   * where the person is now, after a navigation.
   */
  readonly think: (text: string, delegationId: string) => void;
  /** The strip's own actions, by voice. */
  readonly control: (verb: ControlVerb) => void;
  /**
   * Whether a post to `focus` can be sent now: the bot's channel is known.
   * A post that cannot waits, and is sent on {@link SayLoop.onFocusResolved}.
   */
  readonly canSend: (focus: VoiceFocus) => boolean;
  /** Runs `fn` after `ms`; the returned function cancels it. */
  readonly schedule: (fn: () => void, ms: number) => () => void;
  /** Opens the rail on the thread a post's answer landed in. */
  readonly openThread: (
    focus: VoiceFocus,
    response: BotConversationSendResponse,
    text: string,
  ) => void;
  /** The bot's name, for what the voice says about where a post landed. */
  readonly botTitle: (botId: string) => string;
  /**
   * A request was accepted and is now awaited: whoever watches the records
   * reconciles rows already loaded against it (the answer may have landed in
   * a snapshot before the acceptance came back).
   */
  readonly onAccepted: (request: AcceptedRequest) => void;
}

/** What the router is given: the reserved words, segment by segment, as said. */
export interface RouteRequest {
  readonly segments: ReadonlyArray<string>;
  /** The question the voice asked about these words, when it just asked one. */
  readonly askedQuestion: string | null;
}

export interface AskOutcome {
  readonly onDelivered: () => void;
  readonly onGivenUp: () => void;
}

/** An accepted request, as the records will name it. */
export interface AcceptedRequest {
  readonly requestId: string;
  readonly botId: string;
  readonly hostId: string;
  readonly threadId: string | null;
}

/** The loop's answer to where a reply belongs; see {@link SayLoop.placementFor}. */
export type ReplyPlacement =
  | { readonly kind: "placed"; readonly delegationId: string | null }
  | { readonly kind: "pending" };

/** Where a bot's reply was found, for the loop to name the request it answers. */
export interface ReplyPlace {
  readonly botId: string;
  readonly hostId: string;
  /** The thread the reply is in; `null` at the channel's top level. */
  readonly threadId: string | null;
  /**
   * The request the records say it resolved, when the records already say
   * (the member row whose request resolved to it); `null` when they do not
   * yet, or the reply answers no request.
   */
  readonly requestId: string | null;
}

export interface SayLoop {
  onDelegationCreated(delegationId: string): Promise<void>;
  /** The person selected another channel or thread by hand. */
  onSelectionChanged(): void;
  /**
   * The focus became sendable: the thread list resolved the focused anchor
   * (to its thread, or to none yet), or the channel of a bot the voice
   * navigated to became known. Requests closed while it was not post now,
   * in order, each under its own delegation, to the focus as it stands.
   */
  onFocusResolved(): Promise<void>;
  /**
   * Where a reply belongs: `placed` with the delegation of the request this
   * session accepted and still awaits an answer to (named by its id when the
   * records name it; else, for a thread that an accepted post OPENED, that
   * post, whose first reply answers it before the channel's row says so),
   * spending that binding; `placed` with `null` when the binding belongs to
   * a replaced engine, which knows no such delegation; `pending` when no
   * binding fits yet (the records do not tie the reply to a request, or its
   * request's acceptance has not come back), spending nothing: the caller
   * places it again when they do. A top-level row is never placed by the
   * requests awaiting there alone: the channel carries announcements too.
   */
  placementFor(place: ReplyPlace): ReplyPlacement;
  /**
   * What this session awaits in `threadId` (the channel, for `null`):
   * `"opened"` when an accepted post OPENED that thread (every row the
   * thread has is newer than the post), `"joined"` when one was posted into
   * a thread or channel that already existed (only the rows answering it are
   * new), `"none"` otherwise.
   */
  awaitedIn(threadId: string | null): "opened" | "joined" | "none";
  /** Whether `requestId` is a request this session accepted and still awaits an answer to. */
  isAwaiting(requestId: string): boolean;
  /** Actions whose send has not settled. */
  inFlightCount(): number;
}

interface Action {
  readonly actionId: string;
  readonly delegationId: string;
  /** The destination the route bound; re-checked before every send. */
  readonly tuple: VoiceTargetTuple;
  readonly focus: VoiceFocus;
  readonly text: string;
  readonly seqs: ReadonlyArray<number>;
  readonly selectionGeneration: number;
  readonly sessionToken: number;
  readonly engineGeneration: number;
  /** The person moved while the send was out: it is said, not opened. */
  movedWhileSending: boolean;
}

/** An accepted request awaiting its reply, and what the voice said it under. */
interface RequestBinding {
  readonly requestId: string;
  readonly delegationId: string;
  readonly engineGeneration: number;
  readonly botId: string;
  readonly hostId: string;
  /** The thread the post is in, or `null` for a top-level post the bot answers in the channel. */
  readonly threadId: string | null;
  /**
   * A top-level post opened `threadId`, so the thread has no row older than
   * it. `false` for a post into a thread, and for a reply under an anchor,
   * whose thread may have existed before the list showed it.
   */
  readonly openedThread: boolean;
}

/** Reserved words while the router decides what they are. */
interface RoutingEntry {
  readonly actionId: string;
  readonly delegationId: string;
  readonly seqs: ReadonlyArray<number>;
  /** The reserved segments, in order: the router's segments, by index. */
  readonly segments: ReadonlyArray<TranscriptSegment>;
  readonly selectionGeneration: number;
  readonly sessionToken: number;
  readonly engineGeneration: number;
}

/** A routed post held for the person's yes. */
interface Confirming {
  readonly entry: RoutingEntry;
  readonly target: BoundTarget;
  readonly text: string;
  /** The question was confirmed spoken; only then is a boundary its answer. */
  heard: boolean;
  /** Cancels the wait for an answer once the question was heard. */
  cancelWait: () => void;
}

/**
 * How long a post waits for its yes or no once the question was heard. A
 * spoken "yes" may close no utterance of its own, so the wait is bounded:
 * the post is never left for an unrelated later request to answer.
 */
export const CONFIRM_ANSWER_WINDOW_MS = 15_000;

export const MOVED_ASK_TEXT =
  "You moved while you were talking, so I did not post that. When you are ready, say the whole request again.";

/** Why a routed request is refused by the loop, beyond the route's own refusals. */
type LoopRefusal =
  | RouteRefusal
  /** The bound destination no longer holds against the directory. */
  | "gone"
  /** The request was bound to the focus, and the voice has since moved elsewhere. */
  | "moved-on"
  /** Another post is already waiting for the person's yes or no. */
  | "confirm-busy";

const REFUSAL_TEXT: Record<LoopRefusal, string> = {
  unparseable:
    "Nothing was posted: the request was not clear enough to act on. The person can say it again.",
  "unknown-target":
    "Nothing was posted: the bot or thread named was not one the person has. The person can say it again.",
  "invalid-span":
    "Nothing was posted: the request was not clear enough to act on. The person can say it again.",
  unavailable:
    "Nothing was posted: the request could not be routed just now. The person can say it again.",
  gone: "Nothing was posted: that bot or thread is no longer available. The person can say it again.",
  "moved-on":
    "Nothing was posted: that request was for where the person was before the voice moved to another bot. The person can say it again.",
  "confirm-busy":
    "Nothing was posted: an earlier post is still waiting for the person's yes or no. The person can say this one again after answering.",
};

const DECLINED_TEXT = "Okay, I did not post it.";
const UNANSWERED_TEXT =
  "Nothing was posted: no yes came for it. The person can say it again.";

/** The destination as the voice names it: a channel, or a thread by its post. */
function placeName(target: BoundTarget): string {
  if (target.tuple.threadId === null) return target.botTitle;
  if (target.anchorExcerpt === null) return `a thread with ${target.botTitle}`;
  return `${target.botTitle}'s thread about "${target.anchorExcerpt}"`;
}

/** What the voice asks before a routed post it confirms. */
export function confirmQuestion(
  target: BoundTarget,
  uncertain: boolean,
): string {
  const scoped = `${placeName(target)} in ${target.environmentLabel}`;
  return uncertain
    ? `Did you mean ${scoped}? Say yes to post it there, or no.`
    : `Should I post that to ${scoped}? Say yes or no.`;
}

/** Where the person is after a navigation, for the voice to keep. */
function landedText(target: BoundTarget): string {
  const where =
    target.tuple.threadId === null
      ? `${target.botTitle}'s channel`
      : placeName(target);
  return `The person is now in ${where}, in ${target.environmentLabel}.`;
}

/**
 * Whether the focus now is still the destination a route bound to the focus:
 * the same bot, host and anchor, the anchor's thread at most resolved since.
 */
function stillDestination(now: VoiceFocus, bound: VoiceFocus): boolean {
  return (
    now.botId === bound.botId &&
    now.hostId === bound.hostId &&
    now.anchorMessageId === bound.anchorMessageId &&
    (bound.threadId === null || now.threadId === bound.threadId)
  );
}

const AFFIRMATIVE = new Set([
  "yes",
  "yeah",
  "yep",
  "yup",
  "sure",
  "correct",
  "right",
  "ok",
  "okay",
  "absolutely",
  "definitely",
  "affirmative",
]);
const AFFIRMATIVE_PHRASES = [
  "go ahead",
  "do it",
  "post it",
  "please do",
  "send it",
];
const NEGATIVE = new Set([
  "no",
  "nope",
  "nah",
  "don't",
  "dont",
  "not",
  "cancel",
  "stop",
  "never",
]);
/** Words an answer may carry around its yes or no and still be only an answer. */
const ANSWER_FILLER = new Set([
  "please",
  "it",
  "that",
  "that's",
  "thats",
  "go",
  "ahead",
  "do",
  "post",
  "send",
  "thanks",
  "thank",
  "you",
  "oh",
  "um",
  "uh",
  "yes",
  "is",
  "fine",
  "thing",
  "sounds",
  "good",
]);

/**
 * The person's words at a confirmation, read locally and exactly: `"yes"` or
 * `"no"` only when every word is an answer's (a yes or no and the words
 * around one), so a later request that merely starts with "yes" is never
 * taken for an answer. Anything else is `"not-an-answer"`: a new request.
 * Never posted itself.
 */
export function confirmationAnswer(
  text: string,
): "yes" | "no" | "not-an-answer" {
  const words = text
    .toLowerCase()
    .replace(/[^a-z' ]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const answerOnly =
    words.length > 0 &&
    words.every(
      (word) =>
        AFFIRMATIVE.has(word) || NEGATIVE.has(word) || ANSWER_FILLER.has(word),
    );
  if (!answerOnly) return "not-an-answer";
  if (words.some((word) => NEGATIVE.has(word))) return "no";
  const joined = words.join(" ");
  if (
    words.some((word) => AFFIRMATIVE.has(word)) ||
    AFFIRMATIVE_PHRASES.some((phrase) => joined.includes(phrase))
  ) {
    return "yes";
  }
  return "not-an-answer";
}

export function createSayLoop(deps: SayLoopDeps): SayLoop {
  const { store } = deps;
  const inFlight = new Map<string, Action>();
  /** Boundaries already handled, by `${engineGeneration}:${delegationId}`. */
  const handledBoundaries = new Set<string>();
  /** Accepted requests awaiting a reply, by request id. */
  const awaiting = new Map<string, RequestBinding>();
  /**
   * Requests closed while the focused anchor's thread was unresolved, in
   * the order they were said: posted once the list resolves it (see
   * {@link SayLoop.onFocusResolved}), released into the interruption when
   * the person moves first.
   */
  const unresolved: Action[] = [];
  /** A resume is posting them, one at a time. */
  let resuming = false;
  /** Routes out, by action id; a move takes them away, and their completion is dropped. */
  const routing = new Map<string, RoutingEntry>();
  /** The routed post waiting for the person's yes; mirrored by the store's `pendingAction`. */
  let confirming: Confirming | null = null;
  /** The question the voice just asked about words it handed back, for the next route. */
  let askedQuestion: {
    readonly text: string;
    readonly sessionToken: number;
  } | null = null;

  const delegationOf = (
    binding: Pick<RequestBinding, "engineGeneration" | "delegationId">,
  ): string | null =>
    binding.engineGeneration === store.getState().engineGeneration
      ? binding.delegationId
      : null;

  /**
   * The focus follows where the post landed. A post into a thread keeps its
   * thread's anchor and the rail is left where it is; one under an anchor
   * follows the thread it landed in by that anchor; one from the channel
   * opens the rail on the thread it opened.
   */
  function adoptDestination(
    action: Action,
    response: BotConversationSendResponse,
  ): void {
    const { focus } = action;
    if (focus.threadId !== null || response.threadId === null) return;
    const state = store.getState();
    if (focus.anchorMessageId !== null) {
      state.setFocus({
        ...focus,
        threadId: response.threadId,
        anchorThread: null,
      });
      return;
    }
    state.setFocus({
      ...focus,
      threadId: response.threadId,
      anchorMessageId: response.messageId,
      anchorThread: null,
    });
    deps.openThread(focus, response, action.text);
  }

  /** Sends one action and settles it: its words are spent either way. */
  async function post(action: Action): Promise<void> {
    const { actionId, delegationId, focus } = action;
    let response: BotConversationSendResponse;
    try {
      response = await deps.send(focus, action.text);
    } catch {
      inFlight.delete(actionId);
      const after = store.getState();
      // The words are not reposted on their own later with whatever was
      // said since: the voice says so, and the person says them again.
      after.consumeReservation(action.seqs);
      if (after.sessionToken !== action.sessionToken) return;
      if (after.pendingDelegationId === delegationId) {
        after.setPendingDelegation(null);
      }
      deps.notify(
        "The message was not posted. The person can say it again.",
        delegationOf(action),
      );
      return;
    }
    inFlight.delete(actionId);
    const after = store.getState();
    // The action's own words are spent either way. A post of an ended
    // session is work that exists; it changes nothing else.
    after.consumeReservation(action.seqs);
    if (after.sessionToken !== action.sessionToken) return;
    if (after.pendingDelegationId === delegationId) {
      after.setPendingDelegation(null);
    }
    // Only a top-level post proves the thread it landed in is new: the host
    // keys that thread by the post. A reply under an anchor the list had no
    // thread for may have joined one the list was behind on, so its thread
    // is joined, and its first snapshot is history but for the exact answer.
    const openedThread =
      focus.threadId === null &&
      focus.anchorMessageId === null &&
      response.threadId !== null;
    awaiting.set(response.requestId, {
      requestId: response.requestId,
      delegationId,
      engineGeneration: action.engineGeneration,
      botId: focus.botId,
      hostId: focus.hostId,
      threadId: response.threadId,
      openedThread,
    });
    const moved =
      action.movedWhileSending ||
      after.selectionGeneration !== action.selectionGeneration;
    const landed =
      response.threadId === null
        ? `${deps.botTitle(focus.botId)}'s channel`
        : `a thread with ${deps.botTitle(focus.botId)}`;
    if (!moved) adoptDestination(action, response);
    // One notice covers both facts: the voice says nothing about an ordinary
    // post beyond the reply itself.
    const notice = [
      moved ? `Posted in ${landed} before the person moved on.` : null,
      response.delivery === "queued"
        ? `The post is queued until the bot's machine takes it.`
        : null,
    ].filter((line) => line !== null);
    if (notice.length > 0) deps.notify(notice.join(" "), delegationOf(action));
    // Last: the answer may already be in a loaded snapshot.
    deps.onAccepted({
      requestId: response.requestId,
      botId: focus.botId,
      hostId: focus.hostId,
      threadId: response.threadId,
    });
  }

  /** Clears the request's delegation when it is still the pending one. */
  function settleDelegation(delegationId: string): void {
    const state = store.getState();
    if (state.pendingDelegationId === delegationId) {
      state.setPendingDelegation(null);
    }
  }

  /** The words are spent and nothing is posted; the voice says why. */
  function refuse(
    entry: Pick<RoutingEntry, "seqs" | "delegationId" | "engineGeneration">,
    reason: LoopRefusal,
  ): void {
    store.getState().consumeReservation(entry.seqs);
    settleDelegation(entry.delegationId);
    deps.notify(REFUSAL_TEXT[reason], delegationOf(entry));
  }

  /** The words go back to the open utterance, for the next boundary. */
  function handBack(entry: RoutingEntry): void {
    store.getState().releaseReservation(entry.seqs);
    settleDelegation(entry.delegationId);
  }

  /**
   * Opens the target and makes it the focus; the selection follows, so the
   * generation does not move. A post still waiting for a destination the
   * voice is leaving can no longer be sent there: it is dropped, and the
   * voice says so.
   */
  function goTo(target: BoundTarget): void {
    const token = store.getState().sessionToken;
    for (const waiting of unresolved.splice(0)) {
      if (
        waiting.sessionToken === token &&
        !stillDestination(target.focus, waiting.focus)
      ) {
        refuse(waiting, "moved-on");
      } else {
        unresolved.push(waiting);
      }
    }
    deps.navigate(target);
    store.getState().setFocus(target.focus);
  }

  /**
   * Posts the span to its bound target: the tuple is checked again, the
   * target opened when it is not the focus, and the send leaves once the
   * focus can carry it.
   */
  async function postRouted(
    entry: RoutingEntry,
    target: BoundTarget,
    text: string,
  ): Promise<void> {
    if (!deps.recheck(target.tuple)) {
      refuse(entry, "gone");
      return;
    }
    // The destination is the one the route bound, never the focus as it is
    // now: another request may have navigated since. A request bound to the
    // focus takes the focus only while it is still that destination (its
    // anchor's thread may have resolved meanwhile); once the voice has moved
    // elsewhere it is not sent there, and the voice says so.
    let focus = target.focus;
    if (target.isFocus) {
      const now = store.getState().focus;
      if (now === null || !stillDestination(now, target.focus)) {
        refuse(entry, "moved-on");
        return;
      }
      focus = now;
    } else {
      goTo(target);
    }
    const action: Action = {
      actionId: entry.actionId,
      delegationId: entry.delegationId,
      tuple: target.tuple,
      focus,
      text,
      seqs: entry.seqs,
      selectionGeneration: entry.selectionGeneration,
      sessionToken: entry.sessionToken,
      engineGeneration: entry.engineGeneration,
      movedWhileSending: false,
    };
    // The anchor's thread is not known yet, or the bot's channel is not: the
    // request is complete, its words are its own, and it posts under this
    // delegation once the focus can carry it. A later utterance reserves
    // only its own words.
    if (
      action.focus.anchorThread === "resolving" ||
      !deps.canSend(action.focus)
    ) {
      unresolved.push(action);
      return;
    }
    inFlight.set(action.actionId, action);
    await post(action);
  }

  /** Carries out one routed decision for the words `entry` reserved. */
  async function execute(
    entry: RoutingEntry,
    decision: RoutedDecision,
  ): Promise<void> {
    switch (decision.kind) {
      case "refused":
        refuse(entry, decision.reason);
        return;
      case "fragment":
        handBack(entry);
        return;
      case "ask":
        handBack(entry);
        askedQuestion = {
          text: decision.question,
          sessionToken: entry.sessionToken,
        };
        deps.notify(decision.question, delegationOf(entry));
        return;
      case "control":
        store.getState().consumeReservation(entry.seqs);
        settleDelegation(entry.delegationId);
        deps.control(decision.verb);
        return;
      case "deferred": {
        store.getState().consumeReservation(entry.seqs);
        settleDelegation(entry.delegationId);
        const outcome = executeDeferredVerb(
          decision.verb,
          decision.target,
          decision.span,
        );
        if (outcome.kind === "refused") {
          deps.notify(outcome.say, delegationOf(entry));
        }
        return;
      }
      case "navigate":
      case "switch": {
        const { target } = decision;
        if (!deps.recheck(target.tuple)) {
          refuse(entry, "gone");
          return;
        }
        store.getState().consumeReservation(entry.seqs);
        settleDelegation(entry.delegationId);
        if (!target.isFocus) goTo(target);
        const delegationId = delegationOf(entry);
        if (delegationId === null) deps.notify(landedText(target), null);
        else deps.think(landedText(target), delegationId);
        return;
      }
      case "post": {
        const text = joinSegments(
          entry.segments.slice(decision.span.from, decision.span.to + 1),
        );
        if (text.length === 0) {
          refuse(entry, "invalid-span");
          return;
        }
        if (decision.confirm === null) {
          await postRouted(entry, decision.target, text);
          return;
        }
        // One confirmation at a time: a second route that needs one while an
        // earlier question waits is dropped, so a yes can only ever answer
        // the question the person heard.
        if (confirming !== null) {
          refuse(entry, "confirm-busy");
          return;
        }
        const held: Confirming = {
          entry,
          target: decision.target,
          text,
          heard: false,
          cancelWait: () => undefined,
        };
        confirming = held;
        store.getState().setPendingAction({
          kind: "confirming",
          target: decision.target.tuple,
          text,
          delegationId: entry.delegationId,
          selectionGeneration: entry.selectionGeneration,
          askState: "asking",
        });
        deps.ask(
          confirmQuestion(decision.target, decision.confirm === "uncertain"),
          delegationOf(entry),
          {
            onDelivered: () => {
              if (confirming !== held || held.heard) return;
              held.heard = true;
              held.cancelWait = deps.schedule(() => {
                if (confirming !== held) return;
                dropConfirmation(held);
                deps.notify(UNANSWERED_TEXT, delegationOf(held.entry));
              }, CONFIRM_ANSWER_WINDOW_MS);
              const pending = store.getState().pendingAction;
              if (pending?.kind === "confirming") {
                store
                  .getState()
                  .setPendingAction({ ...pending, askState: "heard" });
              }
            },
            // The person never heard the question, so no answer is coming:
            // the post is dropped, and words said since stand on their own.
            onGivenUp: () => {
              if (confirming !== held) return;
              dropConfirmation(held);
            },
          },
        );
        return;
      }
    }
  }

  /** The held post goes, with its words; nothing is said. */
  function dropConfirmation(held: Confirming): void {
    held.cancelWait();
    confirming = null;
    const state = store.getState();
    state.consumeReservation(held.entry.seqs);
    if (state.pendingAction?.kind === "confirming")
      state.setPendingAction(null);
    settleDelegation(held.entry.delegationId);
  }

  /**
   * A boundary while a post waits for its yes. Words that are only an answer
   * are consumed by the held post and never posted (and answer nothing when
   * said before the question was heard). Words that are not an answer are a
   * new request: the held post is dropped, the voice says so, and they are
   * routed as usual (`"route"`).
   */
  async function answerConfirmation(
    boundary: string,
  ): Promise<"handled" | "route"> {
    const held = confirming;
    const state = store.getState();
    if (held === null) {
      if (state.pendingAction?.kind === "confirming") {
        state.setPendingAction(null);
      }
      return "route";
    }
    const answer = state.reserveOpenSpan(`answer:${boundary}`);
    // A boundary with no words answers nothing yet.
    if (answer === null) return "handled";
    const verdict = confirmationAnswer(answer.text);
    if (verdict === "not-an-answer") {
      state.releaseReservation(answer.seqs);
      dropConfirmation(held);
      deps.notify(DECLINED_TEXT, delegationOf(held.entry));
      return "route";
    }
    state.consumeReservation(answer.seqs);
    // An answer said before the question was heard answers nothing: the
    // post waits for one to the question once it is heard.
    if (!held.heard) return "handled";
    held.cancelWait();
    confirming = null;
    state.setPendingAction(null);
    if (held.entry.sessionToken !== store.getState().sessionToken) {
      return "handled";
    }
    if (verdict === "yes") {
      await postRouted(held.entry, held.target, held.text);
      return "handled";
    }
    state.consumeReservation(held.entry.seqs);
    settleDelegation(held.entry.delegationId);
    deps.notify(DECLINED_TEXT, delegationOf(held.entry));
    return "handled";
  }

  /**
   * A boundary while an interruption is pending. Unheard ask: the words are
   * held with the interrupted ones. Heard, or given up with an utterance
   * under way: this boundary closes the interruption; the next is a fresh
   * request.
   */
  function holdInterruptedBoundary(): void {
    const state = store.getState();
    const pending = state.pendingAction;
    if (pending?.kind !== "interrupted") return;
    const more = state.dropOpenSpan();
    if (pending.askState !== "asking") {
      state.setPendingAction(null);
      return;
    }
    if (more !== null) {
      state.setPendingAction({ ...pending, text: `${pending.text} ${more}` });
    }
  }

  return {
    async onDelegationCreated(delegationId) {
      const state = store.getState();
      const boundary = `${state.engineGeneration}:${delegationId}`;
      if (handledBoundaries.has(boundary)) return;
      handledBoundaries.add(boundary);
      if (state.pendingAction?.kind === "interrupted") {
        holdInterruptedBoundary();
        return;
      }
      if (
        (state.pendingAction?.kind === "confirming" || confirming !== null) &&
        (await answerConfirmation(boundary)) === "handled"
      ) {
        return;
      }
      const now = store.getState();
      // No destination yet: the words stay open for the request that has one.
      if (now.focus === null) return;
      const actionId = `${now.sessionToken}:${boundary}`;
      const reservation = now.reserveOpenSpan(actionId);
      if (reservation === null) return;
      now.setPendingDelegation(delegationId);
      const entry: RoutingEntry = {
        actionId,
        delegationId,
        seqs: reservation.seqs,
        segments: store
          .getState()
          .segments.filter((segment) => segment.reservedBy === actionId),
        selectionGeneration: now.selectionGeneration,
        sessionToken: now.sessionToken,
        engineGeneration: now.engineGeneration,
      };
      const asked =
        askedQuestion !== null &&
        askedQuestion.sessionToken === entry.sessionToken
          ? askedQuestion.text
          : null;
      askedQuestion = null;
      routing.set(actionId, entry);
      let decision: RoutedDecision;
      try {
        decision = await deps.decide({
          segments: entry.segments.map((segment) => segment.text),
          askedQuestion: asked,
        });
      } catch {
        decision = { kind: "refused", reason: "unavailable" };
      }
      // A move took the words while the route was out: the completion is
      // stale, and navigates and posts nothing. An ended session forgot them.
      if (!routing.delete(actionId)) return;
      if (store.getState().sessionToken !== entry.sessionToken) return;
      await execute(entry, decision);
    },

    async onFocusResolved() {
      // One resume at a time keeps the posts in the order they were said.
      if (resuming) return;
      resuming = true;
      try {
        // Each request is taken against the store as it stands when its turn
        // comes: an End or a move while an earlier resumed send is out is
        // seen here, and a request not taken yet stays in the list, where
        // the move releases its words into the interruption.
        for (;;) {
          const action = unresolved.at(0);
          if (action === undefined) return;
          const state = store.getState();
          if (
            action.sessionToken !== state.sessionToken ||
            action.selectionGeneration !== state.selectionGeneration
          ) {
            // Its session ended (its words went with it), or the person
            // moved (the move released them): nothing left to post.
            unresolved.shift();
            continue;
          }
          const focus = state.focus;
          // Not resolved yet, or not the anchor it was said under (the
          // anchor changes only with the generation): it waits.
          if (
            focus === null ||
            focus.anchorThread === "resolving" ||
            !stillDestination(focus, action.focus) ||
            !deps.canSend(focus)
          ) {
            return;
          }
          unresolved.shift();
          // Checked again at execution: the destination may have stopped
          // holding while the request waited.
          if (!deps.recheck(action.tuple)) {
            refuse(action, "gone");
            continue;
          }
          const resumed: Action = { ...action, focus };
          inFlight.set(resumed.actionId, resumed);
          await post(resumed);
        }
      } finally {
        resuming = false;
      }
    },

    onSelectionChanged() {
      // Routes still out are dropped and a post waiting for its yes is let
      // go: their words return to the open utterance, which the move
      // interrupts below with everything else said.
      const before = store.getState();
      for (const entry of Array.from(routing.values())) {
        if (entry.sessionToken !== before.sessionToken) continue;
        routing.delete(entry.actionId);
        before.releaseReservation(entry.seqs);
      }
      if (confirming !== null) {
        confirming.cancelWait();
        before.releaseReservation(confirming.entry.seqs);
        confirming = null;
      }
      if (before.pendingAction?.kind === "confirming") {
        before.setPendingAction(null);
      }
      askedQuestion = null;
      const state = store.getState();
      for (const action of inFlight.values()) {
        if (action.sessionToken === state.sessionToken) {
          action.movedWhileSending = true;
        }
      }
      // A request held for an unresolved destination is interrupted like
      // the open words: they are released into them, and go with them.
      for (const action of unresolved.splice(0)) {
        if (action.sessionToken === state.sessionToken) {
          state.releaseReservation(action.seqs);
        }
      }
      // A move during an interruption already pending adds nothing: the
      // words are held and the ask is out.
      const interrupted = state.pendingAction;
      if (interrupted?.kind === "interrupted") {
        const more = state.dropOpenSpan();
        if (more !== null) {
          state.setPendingAction({
            ...interrupted,
            text: `${interrupted.text} ${more}`,
          });
        }
        return;
      }
      const held = state.dropOpenSpan();
      if (held === null) return;
      const sessionToken = state.sessionToken;
      // The open delegation, if any, belongs to an action in flight; the
      // held words had none of their own yet.
      state.setPendingAction({
        kind: "interrupted",
        text: held,
        delegationId: inFlight.size === 0 ? state.pendingDelegationId : null,
        selectionGeneration: state.selectionGeneration,
        askState: "asking",
      });
      if (inFlight.size === 0) state.setPendingDelegation(null);
      deps.ask(MOVED_ASK_TEXT, null, {
        onDelivered: () => {
          const now = store.getState();
          if (now.sessionToken !== sessionToken) return;
          const pending = now.pendingAction;
          if (pending?.kind !== "interrupted" || pending.askState === "heard") {
            return;
          }
          now.setPendingAction({ ...pending, askState: "heard" });
        },
        onGivenUp: () => {
          // The voice could not ask: the interruption resolves itself and
          // the held words go. An utterance already under way (words open
          // with no boundary yet) is still the interrupted one, and closes
          // the interruption at its boundary without posting; a request
          // begun after this is a fresh one.
          const now = store.getState();
          if (now.sessionToken !== sessionToken) return;
          const pending = now.pendingAction;
          if (pending?.kind !== "interrupted") return;
          if (pending.askState === "heard") return;
          if (now.openSpan().length > 0) {
            now.setPendingAction({ ...pending, askState: "closing" });
          } else {
            now.setPendingAction(null);
          }
        },
      });
    },

    placementFor(place) {
      let binding: RequestBinding | null = null;
      if (place.requestId !== null) {
        binding = awaiting.get(place.requestId) ?? null;
      } else if (place.threadId !== null) {
        // Only a thread an accepted post OPENED answers it with its first
        // reply before the channel's row says so; a row in a thread that
        // already existed is placed once the records tie it to a request.
        binding =
          Array.from(awaiting.values()).find(
            (candidate) =>
              candidate.openedThread &&
              candidate.threadId === place.threadId &&
              candidate.botId === place.botId &&
              candidate.hostId === place.hostId,
          ) ?? null;
      }
      // At the channel's top level a row the records do not tie to a request
      // is not placed, even with one request of the bot awaiting there: the
      // channel carries the bot's announcements too, which answer nothing,
      // so one awaiting request makes no association unambiguous. The row is
      // placed once the records name its request.
      if (binding === null) return { kind: "pending" };
      awaiting.delete(binding.requestId);
      return { kind: "placed", delegationId: delegationOf(binding) };
    },

    awaitedIn(threadId) {
      const here = Array.from(awaiting.values()).filter(
        (binding) => binding.threadId === threadId,
      );
      if (here.length === 0) return "none";
      return here.some((binding) => binding.openedThread) ? "opened" : "joined";
    },

    isAwaiting: (requestId) => awaiting.has(requestId),

    inFlightCount: () => inFlight.size,
  };
}
