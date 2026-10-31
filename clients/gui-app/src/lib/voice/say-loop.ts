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
 * action reserved. With no router yet, the whole reserved span posts to the
 * focus as the person's own words. The commit boundary is the send's
 * acceptance: a thread the answer opens becomes the focus if the person has
 * not moved since, and a queued delivery is said as "queued", never
 * "paused". The app appends nothing for the acknowledgement: the model's own
 * automatic one is what the person hears.
 *
 * Every action carries the session token it was made under; an acceptance
 * that arrives after the session ended or was replaced changes nothing in
 * the app (the post exists, as work) and says nothing.
 *
 * A manual selection change interrupts: words not yet taken by an action are
 * let go and the voice asks where they belong (never silently rerouted,
 * never posted to the old destination); an action already in flight lands
 * where it was sent, and its acceptance says so without reopening the old
 * rail. The next spoken request stands on its own.
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
   * where the post landed when they moved, that it is queued. Goes through
   * the speech scheduler like every app-requested utterance.
   */
  readonly notify: (text: string, delegationId: string) => void;
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

export interface SayLoop {
  onDelegationCreated(delegationId: string): Promise<void>;
  /** The person selected another channel or thread by hand. */
  onSelectionChanged(): void;
  /**
   * The delegation a reply answers: the one bound to the request that
   * `requestId` names, while the session that made it is the current one;
   * `null` for a request of a replaced or ended session, or none the loop
   * made. The binding is spent by the read.
   */
  delegationFor(requestId: string): string | null;
  /** Actions whose send has not settled. */
  inFlightCount(): number;
}

interface Action {
  readonly actionId: string;
  readonly delegationId: string;
  readonly focus: VoiceFocus;
  readonly text: string;
  readonly selectionGeneration: number;
  readonly sessionToken: number;
  /** The person moved while the send was out: it is said, not opened. */
  movedWhileSending: boolean;
}

interface RequestBinding {
  readonly delegationId: string;
  readonly sessionToken: number;
}

export const MOVED_ASK_TEXT =
  "You moved while you were talking, so I did not post that. Say it again where you want it.";

export function createSayLoop(deps: SayLoopDeps): SayLoop {
  const { store } = deps;
  const inFlight = new Map<string, Action>();
  const requestBindings = new Map<string, RequestBinding>();

  return {
    async onDelegationCreated(delegationId) {
      const state = store.getState();
      // A request after an interruption stands on its own: the held words
      // were let go with the ask, and the router that will consume an answer
      // through them is a later ticket's.
      if (state.pendingAction !== null) state.setPendingAction(null);
      const actionId = `${state.sessionToken}:${delegationId}`;
      const reservation = state.reserveOpenSpan(actionId);
      const focus = state.focus;
      if (reservation === null || focus === null) return;
      state.setPendingDelegation(delegationId);
      const action: Action = {
        actionId,
        delegationId,
        focus,
        text: reservation.text,
        selectionGeneration: state.selectionGeneration,
        sessionToken: state.sessionToken,
        movedWhileSending: false,
      };
      inFlight.set(actionId, action);
      let response: BotConversationSendResponse;
      try {
        response = await deps.send(focus, action.text);
      } catch {
        inFlight.delete(actionId);
        const after = store.getState();
        // The words are not reposted on their own later with whatever was
        // said since: the voice says so, and the person says them again.
        after.consumeReservation(actionId);
        if (after.sessionToken !== action.sessionToken) return;
        if (after.pendingDelegationId === delegationId) {
          after.setPendingDelegation(null);
        }
        deps.notify(
          "The message was not posted. The person can say it again.",
          delegationId,
        );
        return;
      }
      inFlight.delete(actionId);
      const after = store.getState();
      // The action's own words are spent either way. A post of an ended or
      // replaced session is work that exists; it changes nothing else in the
      // session that followed.
      after.consumeReservation(actionId);
      if (after.sessionToken !== action.sessionToken) return;
      if (after.pendingDelegationId === delegationId) {
        after.setPendingDelegation(null);
      }
      requestBindings.set(response.requestId, {
        delegationId,
        sessionToken: action.sessionToken,
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
      // One notice covers both facts: the voice says nothing about an
      // ordinary post beyond the reply itself.
      const notice = [
        moved ? `Posted in ${landed} before the person moved on.` : null,
        response.delivery === "queued"
          ? `The post is queued until the bot's machine takes it.`
          : null,
      ].filter((line) => line !== null);
      if (notice.length > 0) deps.notify(notice.join(" "), delegationId);
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

    delegationFor(requestId) {
      const binding = requestBindings.get(requestId);
      if (binding === undefined) return null;
      requestBindings.delete(requestId);
      return binding.sessionToken === store.getState().sessionToken
        ? binding.delegationId
        : null;
    },

    inFlightCount: () => inFlight.size,
  };
}
