import type { BotConversationSendResponse } from "@traycer/protocol/host/bot/conversation-schemas";
import type { StoreApi } from "zustand";
import type {
  VoiceFocus,
  VoiceSessionState,
} from "@/stores/voice/voice-session-store";

/**
 * The say loop, first cut (Tracy Bots voice, VT2): words become one action.
 *
 * The vendor's delegation event closes the utterance. Each delegation makes
 * one ACTION, which reserves the segments open at that moment: they are its
 * alone, so a second delegation arriving while the first is in flight posts
 * only the words said since, and an acceptance consumes exactly what its
 * action reserved. A boundary is handled once per engine generation: the
 * same delegation id arriving again changes nothing. With no router yet, the
 * whole reserved span posts to the focus as the person's own words; without
 * a focus nothing is reserved, and the words wait for one. The commit
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
   * Something the voice says on its own: here, the question after a move.
   * The scheduler reports whether it was heard, or given up on.
   */
  readonly ask: (text: string, outcome: AskOutcome) => void;
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
   * The thread list resolved the focused anchor (to its thread, or to none
   * yet): requests closed while it was unresolved post now, in order, each
   * under its own delegation, to the focus as it stands.
   */
  onFocusResolved(): Promise<void>;
  /**
   * Where a reply belongs: `placed` with the delegation of the request this
   * session accepted and still awaits an answer to (named by its id when the
   * records name it; else, for a thread that an accepted post OPENED, that
   * post, whose first reply answers it before the channel's row says so;
   * else, at the channel's top level of the same bot on the same host, the
   * one request awaiting an answer there), spending that binding; `placed`
   * with `null` when the binding belongs to a replaced engine, which knows
   * no such delegation; `pending` when no binding fits yet (the records do
   * not tie the reply to a request, or its request's acceptance has not
   * come back), spending nothing: the caller places it again when they do.
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

export const MOVED_ASK_TEXT =
  "You moved while you were talking, so I did not post that. When you are ready, say the whole request again.";

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

  /**
   * A boundary while an interruption is pending. Unheard ask: the words are
   * held with the interrupted ones. Heard, or given up with an utterance
   * under way: this boundary closes the interruption; the next is a fresh
   * request.
   */
  function holdInterruptedBoundary(): void {
    const state = store.getState();
    const pending = state.pendingAction;
    if (pending === null) return;
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
      if (state.pendingAction !== null) {
        holdInterruptedBoundary();
        return;
      }
      const focus = state.focus;
      // No destination yet: the words stay open for the request that has one.
      if (focus === null) return;
      const actionId = `${state.sessionToken}:${boundary}`;
      const reservation = state.reserveOpenSpan(actionId);
      if (reservation === null) return;
      state.setPendingDelegation(delegationId);
      const action: Action = {
        actionId,
        delegationId,
        focus,
        text: reservation.text,
        seqs: reservation.seqs,
        selectionGeneration: state.selectionGeneration,
        sessionToken: state.sessionToken,
        engineGeneration: state.engineGeneration,
        movedWhileSending: false,
      };
      // The anchor's thread is not known yet: the request is complete, its
      // words are its own, and it posts under this delegation once the list
      // says where. A later utterance reserves only its own words.
      if (focus.anchorThread === "resolving") {
        unresolved.push(action);
        return;
      }
      inFlight.set(actionId, action);
      await post(action);
    },

    async onFocusResolved() {
      const state = store.getState();
      const focus = state.focus;
      if (focus === null || focus.anchorThread === "resolving") return;
      for (const action of unresolved.splice(0)) {
        // Its session ended, or the person moved (which released its words
        // into the interruption): nothing left to post.
        if (
          action.sessionToken !== state.sessionToken ||
          action.selectionGeneration !== state.selectionGeneration ||
          action.focus.botId !== focus.botId ||
          action.focus.anchorMessageId !== focus.anchorMessageId
        ) {
          continue;
        }
        const resumed: Action = { ...action, focus };
        inFlight.set(resumed.actionId, resumed);
        await post(resumed);
      }
    },

    onSelectionChanged() {
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
      if (state.pendingAction !== null) {
        const more = state.dropOpenSpan();
        if (more !== null) {
          state.setPendingAction({
            ...state.pendingAction,
            text: `${state.pendingAction.text} ${more}`,
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
      deps.ask(MOVED_ASK_TEXT, {
        onDelivered: () => {
          const now = store.getState();
          if (now.sessionToken !== sessionToken) return;
          const pending = now.pendingAction;
          if (pending === null || pending.askState === "heard") return;
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
          if (pending === null) return;
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
      } else {
        // A bot answering in its channel: unambiguous only while one request
        // of that bot on that host waits there.
        const atTopLevel = Array.from(awaiting.values()).filter(
          (candidate) =>
            candidate.threadId === null &&
            candidate.botId === place.botId &&
            candidate.hostId === place.hostId,
        );
        binding = atTopLevel.length === 1 ? atTopLevel[0] : null;
      }
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
