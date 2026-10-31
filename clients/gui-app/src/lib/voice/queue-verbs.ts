import { useVoiceSessionStore } from "@/stores/voice/voice-session-store";

/**
 * The five spoken verbs the queue answers (Tracy Bots voice, VT4), the same
 * for the router and the strip's Waiting control. `itemId` `null`: the
 * newest waiting item. `status` with `botId` `null`: the focused bot.
 * `switch` takes a bot instead of an item for "open it" after a status.
 * `delegationId` is the spoken request this answers, `null` for a button.
 */
export type QueueVerb =
  | {
      readonly kind: "read";
      readonly itemId: string | null;
      readonly delegationId: string | null;
    }
  | {
      readonly kind: "switch";
      readonly target:
        | { readonly kind: "item"; readonly itemId: string | null }
        | { readonly kind: "bot"; readonly botId: string };
    }
  | { readonly kind: "later"; readonly itemId: string | null }
  | { readonly kind: "brief"; readonly delegationId: string | null }
  | {
      readonly kind: "status";
      readonly botId: string | null;
      readonly delegationId: string | null;
    };

/**
 * What a verb did: `appended`, something was given to the voice to say;
 * `navigated`, the app moved; `dismissed`, an item was set aside;
 * `nothing`, it applied to nothing (no such item, an empty queue, no bot);
 * `not-live`, no session runs.
 */
export type QueueVerbOutcome =
  | "appended"
  | "navigated"
  | "dismissed"
  | "nothing"
  | "not-live";

/**
 * The one executor for `read`, `switch`, `later`, `brief` and `status`: the
 * router calls it for a spoken verb and the Waiting control's buttons call
 * it for a click, so a button and a spoken verb run the same code (the
 * system page's invariant). It reaches the queue the controller owns; with
 * no live session nothing runs.
 */
export function runVoiceQueueVerb(verb: QueueVerb): QueueVerbOutcome {
  const { phase, queueDriver } = useVoiceSessionStore.getState();
  if (phase !== "live" || queueDriver === null) return "not-live";
  return queueDriver.run(verb);
}
