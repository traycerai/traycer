import type { BotConversationSendResponse } from "@traycer/protocol/host/bot/conversation-schemas";
import type { StoreApi } from "zustand";
import type {
  VoiceFocus,
  VoiceSessionState,
} from "@/stores/voice/voice-session-store";
import { isUtteranceOpen } from "@/stores/voice/voice-session-store";

/**
 * The say loop, first cut (Tracy Bots voice, VT2): words become one action.
 * The vendor's delegation event closes the utterance; with no router yet, the
 * whole span since the last consumed one posts to the focus as the person's
 * own words. The commit boundary is the send's acceptance: the span is
 * consumed then, a thread the answer opens becomes the focus if the person
 * has not moved since, and a queued delivery is said as "queued", never
 * "paused". The app appends nothing for the acknowledgement: the model's own
 * automatic one is what the person hears.
 *
 * A manual selection change while an utterance is open interrupts: the
 * bound request is dropped unposted, the words stay in the buffer, and the
 * voice asks where they belong. The next boundary posts them to the focus
 * the person settled on. Nothing is ever posted to the old destination after
 * the app has moved; a send already in flight when they move lands where it
 * was sent and is said so, without reopening the old rail.
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
}

interface Binding {
  readonly delegationId: string;
  readonly selectionGeneration: number;
}

export const MOVED_ASK_TEXT =
  "You moved before I posted that. Say it again where you want it, or tell me where it should go.";

export function createSayLoop(deps: SayLoopDeps): SayLoop {
  const { store } = deps;
  let binding: Binding | null = null;

  return {
    async onDelegationCreated(delegationId) {
      const state = store.getState();
      const text = state.openSpan();
      const focus = state.focus;
      state.setPendingDelegation(delegationId);
      if (text.length === 0 || focus === null) return;
      const bound: Binding = {
        delegationId,
        selectionGeneration: state.selectionGeneration,
      };
      binding = bound;
      let response: BotConversationSendResponse;
      try {
        response = await deps.send(focus, text);
      } catch {
        if (binding === bound) binding = null;
        store.getState().setPendingDelegation(null);
        deps.notify(
          "The message was not posted. The person can say it again.",
          delegationId,
        );
        return;
      }
      const after = store.getState();
      after.consumeSpan();
      after.setPendingDelegation(null);
      if (binding === bound) binding = null;
      const moved = after.selectionGeneration !== bound.selectionGeneration;
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
        deps.openThread(focus, response, text);
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
      // A send already in flight lands where it was sent, and its acceptance
      // says so: asking now would ask about words that are about to post.
      if (binding !== null) return;
      const state = store.getState();
      if (!isUtteranceOpen(state)) return;
      state.setPendingDelegation(null);
      deps.ask(MOVED_ASK_TEXT);
    },
  };
}
