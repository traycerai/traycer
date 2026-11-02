import { captureMessage, isInitialized } from "@sentry/browser";
import type { RouterResult } from "@/lib/voice/router";
import type { VoicePage } from "@/lib/voice/view";

/**
 * Why a spoken request to the page is reported: the router found nothing on
 * the page that does it (`missing`), the act it chose could not run on the page
 * it was chosen for (`refused`), the person said the act that ran was not what
 * they meant (`not-meant`), or the voice could not answer a question about the
 * page (`unanswered`). Open, so a new kind needs no change here.
 */
export type VoiceMissKind =
  | "missing"
  | "refused"
  | "not-meant"
  | "unanswered"
  | (string & Record<never, never>);

/**
 * What the report is about: nothing on the page did it, the router chose an
 * action the page does not offer, or the router chose one of the page's
 * actions (one that could not run, or one the person did not mean).
 */
export type VoiceMissCause = "missing" | "unknown-action" | "chosen-act";

/** What the router was shown and what it answered, for one utterance. */
export interface RouteSeen {
  /** The router's answer as it gave it; only its ids leave the app. */
  readonly route: RouterResult;
  /** The kind of page in front when the router was asked. */
  readonly viewKind: VoicePage["kind"];
  /** The ids of the page's actions the router was offered; never their labels. */
  readonly rowIds: ReadonlyArray<string>;
  /** Whether the page offered an action that passes the person's words on. */
  readonly pageTakesWords: boolean;
  /** Whether the action the router chose passes the person's words on. */
  readonly actTakesWords: boolean;
  /** The utterance the router was given, segment by segment, as said. */
  readonly segments: ReadonlyArray<string>;
}

/**
 * Why the words were left out of the event: they were for an action that
 * passes them on to someone (`tell`), the answer named a bot, thread or agent
 * (`target`), the page offered an action that passes words on, so they may have
 * been meant for it (`agent-page`), the router was unsure (`uncertain`), the
 * event is about an action the router chose, whose words are not the gap
 * (`act`), or they were not left out (`none`).
 */
type SpanDropped =
  | "tell"
  | "target"
  | "agent-page"
  | "uncertain"
  | "act"
  | "none";

/**
 * The words the route points at, never more than the utterance the router was
 * given: the route's span, held inside the utterance, or the whole utterance
 * when the span names none of it.
 */
function spanText(seen: RouteSeen): string {
  const { route, segments } = seen;
  const last = segments.length - 1;
  const from = Math.max(0, route.span.fromSegment);
  const to = Math.min(last, route.span.toSegment);
  const words = from <= to ? segments.slice(from, to + 1) : segments;
  return words.join("").trim();
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}

/**
 * Words leave only for a request nothing on the page served, said where they
 * could have been meant for nobody: no bot, thread or agent named, no action on
 * the page that passes words on, and a router sure of its answer.
 */
function spanDroppedFor(cause: VoiceMissCause, seen: RouteSeen): SpanDropped {
  if (seen.actTakesWords) return "tell";
  if (cause === "chosen-act") return "act";
  const { target } = seen.route;
  if (
    target.botId !== null ||
    target.threadId !== null ||
    target.agentId !== null
  ) {
    return "target";
  }
  if (seen.pageTakesWords) return "agent-page";
  return seen.route.uncertain ? "uncertain" : "none";
}

/**
 * The router's answer by its ids alone. Its question is the model's own text,
 * which can quote the person or a label on the page, so it never leaves.
 */
function routeIds(route: RouterResult): Record<string, unknown> {
  return {
    action: route.action,
    target: route.target,
    uncertain: route.uncertain,
    choice: route.choice,
    control: route.control,
  };
}

/**
 * Files one spoken request the page could not serve, so it reaches the issue
 * triage grouped by page and kind, where its count is the signal. Nothing is
 * filed where reporting is off. `counts` adds numbers about the page beside the
 * event's own extras, which win over a count of the same name.
 */
export function reportVoiceMiss(
  missKind: VoiceMissKind,
  cause: VoiceMissCause,
  seen: RouteSeen,
  counts: Readonly<Record<string, number>> | null,
): void {
  if (!isInitialized()) return;
  const text = spanText(seen);
  const spanDropped = spanDroppedFor(cause, seen);
  captureMessage("voice.route.miss", {
    level: "info",
    tags: {
      viewKind: seen.viewKind,
      missKind,
      routerAction: seen.route.action,
      uncertain: seen.route.uncertain ? "true" : "false",
      spanDropped,
    },
    fingerprint: ["voice.route.miss", seen.viewKind, missKind],
    extra: {
      ...counts,
      rows: seen.rowIds,
      route: routeIds(seen.route),
      span: spanDropped === "none" ? text : null,
      spanWords: wordCount(text),
    },
  });
}
