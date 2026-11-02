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

/** What the router was shown and what it answered, for one utterance. */
export interface RouteSeen {
  /** The router's answer as it gave it. */
  readonly route: RouterResult;
  /** The kind of page in front when the router was asked. */
  readonly viewKind: VoicePage["kind"];
  /** The ids of the page's actions the router was offered; never their labels. */
  readonly rowIds: ReadonlyArray<string>;
  /** The utterance the router was given, segment by segment, as said. */
  readonly segments: ReadonlyArray<string>;
}

/**
 * The words the route points at, never more than the utterance the router was
 * given: the route's span, held inside the utterance, or the whole utterance
 * when the span names none of it. `null` when the route also named a bot or a
 * thread: then the words were a message mis-routed, not a request to the page.
 */
function spanOf(seen: RouteSeen): string | null {
  const { route, segments } = seen;
  if (route.target.botId !== null || route.target.threadId !== null) {
    return null;
  }
  const last = segments.length - 1;
  const from = Math.max(0, route.span.fromSegment);
  const to = Math.min(last, route.span.toSegment);
  const words = from <= to ? segments.slice(from, to + 1) : segments;
  return words.join("").trim();
}

/**
 * Files one spoken request the page could not serve, so it reaches the issue
 * triage grouped by page and kind, where its count is the signal. Nothing is
 * filed where reporting is off. `counts` adds numbers about the page beside the
 * event's own extras, which win over a count of the same name.
 */
export function reportVoiceMiss(
  missKind: VoiceMissKind,
  seen: RouteSeen,
  counts: Readonly<Record<string, number>> | null,
): void {
  if (!isInitialized()) return;
  captureMessage("voice.route.miss", {
    level: "info",
    tags: {
      viewKind: seen.viewKind,
      missKind,
      routerAction: seen.route.action,
      uncertain: seen.route.uncertain ? "true" : "false",
    },
    fingerprint: ["voice.route.miss", seen.viewKind, missKind],
    extra: {
      ...counts,
      rows: seen.rowIds,
      route: seen.route,
      span: spanOf(seen),
    },
  });
}
