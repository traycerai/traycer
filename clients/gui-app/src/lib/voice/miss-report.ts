import { captureMessage, isInitialized } from "@sentry/browser";
import type { VoiceDirectory } from "@/lib/voice/directory";
import type { RouterResult } from "@/lib/voice/router";
import type { VoicePage, VoiceView } from "@/lib/voice/view";

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

/**
 * How many misses this window has filed. Each event's message carries it, so
 * no two in a row read alike to the client's duplicate filter, which compares
 * the message and the stack and would drop a repeat; the fingerprint, which
 * groups them into one issue, stays the same for every miss of a kind on a page.
 */
let filedMisses = 0;

/**
 * The ids the router was shown, by the field of its answer that names one: a
 * string the answer names that is not among them is the model's own writing.
 */
export interface OfferedIds {
  readonly environmentIds: ReadonlySet<string>;
  readonly botIds: ReadonlySet<string>;
  readonly threadIds: ReadonlySet<string>;
  readonly itemIds: ReadonlySet<string>;
  readonly agentIds: ReadonlySet<string>;
}

/**
 * Every id the directories and the view hold, by the answer field that names
 * it: the bots, threads and queue items, the focus, the page and its agent.
 */
export function offeredIdsOf(
  directories: ReadonlyArray<VoiceDirectory>,
  view: VoiceView,
): OfferedIds {
  const environmentIds = new Set<string>();
  const botIds = new Set<string>();
  const threadIds = new Set<string>();
  const itemIds = new Set<string>();
  const agentIds = new Set<string>();
  const addBot = (botId: string | null): void => {
    if (botId !== null) botIds.add(botId);
  };
  const addThread = (threadId: string | null): void => {
    if (threadId !== null) threadIds.add(threadId);
  };
  for (const directory of directories) {
    for (const bot of directory.bots) {
      botIds.add(bot.botId);
      environmentIds.add(bot.environmentId);
    }
    for (const thread of directory.threads) {
      threadIds.add(thread.threadId);
      botIds.add(thread.botId);
      environmentIds.add(thread.environmentId);
    }
    for (const item of directory.queue) {
      itemIds.add(item.itemId);
      botIds.add(item.botId);
      addThread(item.threadId);
    }
    if (directory.focus !== null) {
      botIds.add(directory.focus.botId);
      addThread(directory.focus.threadId);
    }
  }
  if (view.page.kind === "tracy") {
    addBot(view.page.botId);
    addThread(view.page.threadId);
  }
  if (view.agent !== null) agentIds.add(view.agent.chatId);
  return { environmentIds, botIds, threadIds, itemIds, agentIds };
}

/** What the router was shown and what it answered, for one utterance. */
export interface RouteSeen {
  /** The router's answer as it gave it; only its ids leave the app. */
  readonly route: RouterResult;
  /** The kind of page in front when the router was asked. */
  readonly viewKind: VoicePage["kind"];
  /** The ids of the page's actions the router was offered; never their labels. */
  readonly rowIds: ReadonlyArray<string>;
  /** The other ids the router was shown, which its answer may name. */
  readonly offered: OfferedIds;
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

/** A string the answer names, if it is an id the router was shown. */
function listed(
  id: string | null,
  offered: ReadonlySet<string>,
): string | null {
  if (id === null) return null;
  return offered.has(id) ? id : "unlisted";
}

/**
 * The router's answer by its ids alone. Its question is the model's own text,
 * which can quote the person or a label on the page, so it never leaves; nor
 * does an id it names that the router was not shown, which is the model's
 * writing too.
 */
function routeIds(seen: RouteSeen): Record<string, unknown> {
  const { route, offered } = seen;
  const { target } = route;
  return {
    action: route.action,
    target: {
      environmentId: listed(target.environmentId, offered.environmentIds),
      botId: listed(target.botId, offered.botIds),
      threadId: listed(target.threadId, offered.threadIds),
      itemId: listed(target.itemId, offered.itemIds),
      actionId: listed(target.actionId, new Set(seen.rowIds)),
      agentId: listed(target.agentId, offered.agentIds),
    },
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
  filedMisses += 1;
  captureMessage(
    `voice.route.miss ${seen.viewKind} ${missKind} #${filedMisses}`,
    {
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
        route: routeIds(seen),
        span: spanDropped === "none" ? text : null,
        spanWords: wordCount(text),
      },
    },
  );
}
