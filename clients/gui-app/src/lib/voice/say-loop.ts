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
 * A manual selection change while an utterance is open interrupts it for
 * the rest of that utterance: the words so far are let go into
 * `pendingAction`, the voice asks once, and the next boundary - the
 * continuation of the interrupted sentence, or the person's answer to the
 * ask - is consumed by that pending action and never posted. Only the
 * boundary after that is a fresh request. An action already in flight lands
 * where it was sent, and its acceptance says so without reopening the old
 * rail.
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
  /** Something the voice says on its own: here, the question after a move. */
  readonly ask: (text: string) => void;
  /** Opens the rail on the thread a post's answer landed in. */
  readonly openThread: (
    focus: VoiceFocus,
    response: BotConversationSendResponse,
    text: string,
  ) => void;
  /** The bot's name, for what the voice says about where a post landed. */
  readonly botTitle: (botId: string) => string;
}

/** Where a bot's reply was found, for the loop to name the request it answers. */
export interface ReplyPlace {
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
   * The delegation a reply answers, or `null`: a request this session
   * accepted and still awaits an answer to, named by its id when the records
   * name it, else by the thread the accepted post opened (its first reply
   * answers it), else, at the channel's top level, the one request awaiting
   * an answer there. The binding is spent by a match; a reply the loop
   * cannot place spends nothing. `null` also for a request of a replaced
   * engine: the new one knows no such delegation.
   */
  delegationForReply(place: ReplyPlace): string | null;
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
  /** The thread the post is in, or `null` for a top-level post the bot answers in the channel. */
  readonly threadId: string | null;
  /** The post opened `threadId`: the thread has no row older than it. */
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

  const delegationOf = (
    binding: Pick<RequestBinding, "engineGeneration" | "delegationId">,
  ): string | null =>
    binding.engineGeneration === store.getState().engineGeneration
      ? binding.delegationId
      : null;

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
    awaiting.set(response.requestId, {
      requestId: response.requestId,
      delegationId,
      engineGeneration: action.engineGeneration,
      threadId: response.threadId,
      openedThread: focus.threadId === null && response.threadId !== null,
    });
    const moved =
      action.movedWhileSending ||
      after.selectionGeneration !== action.selectionGeneration;
    const landed =
      response.threadId === null
        ? `${deps.botTitle(focus.botId)}'s channel`
        : `a thread with ${deps.botTitle(focus.botId)}`;
    if (!moved && response.threadId !== null) {
      after.setFocus({
        ...focus,
        threadId: response.threadId,
        anchorMessageId: response.messageId,
      });
      deps.openThread(focus, response, action.text);
    }
    // One notice covers both facts: the voice says nothing about an ordinary
    // post beyond the reply itself.
    const notice = [
      moved ? `Posted in ${landed} before the person moved on.` : null,
      response.delivery === "queued"
        ? `The post is queued until the bot's machine takes it.`
        : null,
    ].filter((line) => line !== null);
    if (notice.length > 0) deps.notify(notice.join(" "), delegationOf(action));
  }

  return {
    async onDelegationCreated(delegationId) {
      const state = store.getState();
      const boundary = `${state.engineGeneration}:${delegationId}`;
      if (handledBoundaries.has(boundary)) return;
      handledBoundaries.add(boundary);
      // The interrupted utterance's own boundary: its continuation, or the
      // person's answer to the ask. Consumed by the pending action, never
      // posted; the boundary after this one is a fresh request.
      if (state.pendingAction !== null) {
        state.dropOpenSpan();
        state.setPendingAction(null);
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
      inFlight.set(actionId, action);
      await post(action);
    },

    onSelectionChanged() {
      const state = store.getState();
      for (const action of inFlight.values()) {
        if (action.sessionToken === state.sessionToken) {
          action.movedWhileSending = true;
        }
      }
      const held = state.dropOpenSpan();
      if (held === null) return;
      // The open delegation, if any, belongs to an action in flight; the
      // held words had none of their own yet.
      state.setPendingAction({
        kind: "interrupted",
        text: held,
        delegationId: inFlight.size === 0 ? state.pendingDelegationId : null,
        selectionGeneration: state.selectionGeneration,
      });
      if (inFlight.size === 0) state.setPendingDelegation(null);
      deps.ask(MOVED_ASK_TEXT);
    },

    delegationForReply(place) {
      let binding: RequestBinding | null = null;
      if (place.requestId !== null) {
        binding = awaiting.get(place.requestId) ?? null;
      } else if (place.threadId !== null) {
        // The thread an accepted post opened: its first reply answers it,
        // before the channel's row says so.
        binding =
          Array.from(awaiting.values()).find(
            (candidate) => candidate.threadId === place.threadId,
          ) ?? null;
      } else {
        // A bot answering in its channel: unambiguous only while one request
        // waits there.
        const atTopLevel = Array.from(awaiting.values()).filter(
          (candidate) => candidate.threadId === null,
        );
        binding = atTopLevel.length === 1 ? atTopLevel[0] : null;
      }
      if (binding === null) return null;
      awaiting.delete(binding.requestId);
      return delegationOf(binding);
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
