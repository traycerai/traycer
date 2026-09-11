import { HOST_NOTIFICATION_PENDING_PROMPT_KINDS } from "@traycer/protocol/host/notifications/host-notifications";
import {
  classifyNotificationLifecycle,
  compareAttentionOrder,
  type NotificationAttentionTier,
} from "@/lib/notifications/notification-lifecycle";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";
import { browserTabTitleKey } from "@/lib/home-focus/focus-browsers";
import {
  shallowEqualRow,
  stabilizeRows,
} from "@/lib/home-focus/focus-identity";
import type {
  FocusPromptKind,
  FocusPromptRow,
} from "@/lib/home-focus/focus-model";

/**
 * The three things a task can be waiting on a human for, and the only three the
 * client can currently see across tasks. Mirrors
 * `HOST_NOTIFICATION_PENDING_PROMPT_KINDS`, which is the list the pending-prompt
 * glyph and the host's own indicator SQL both read - so a kind added there and
 * not here degrades to "no Home row", never to a mis-labelled one.
 */
const PROMPT_KIND_BY_HOST_KIND: Readonly<Record<string, FocusPromptKind>> = {
  "approval.requested": "approval",
  "interview.requested": "interview",
  "browser.human.needed": "browser",
};

/**
 * The "Needs you" section: unresolved, unread prompts across every task on the
 * notification feed, in the bell's own attention order.
 *
 * THREE conditions, and all three are load-bearing (the badge
 * counts exactly these rows):
 *
 * 1. The row's kind is a pending-prompt kind. A failure row is attention too,
 *    but it is history, not a question.
 * 2. `resolvedAt === null`. A prompt answered from the chat stays in the feed
 *    with its answer recorded; it is not waiting on anyone.
 * 3. The lifecycle classifier puts it in `attention`, which for a
 *    `needs_action` row means UNREAD. A prompt whose row the user has already
 *    acknowledged is not what Home is for.
 *
 * Ordering is `compareAttentionOrder` - blocking tier first, newest first
 * within a tier, `feedId` ascending as the deterministic tie-break. The
 * provider-pack local-first re-order the bell applies is deliberately not
 * repeated: it discriminates pack-store events, which are never a prompt kind,
 * so applying it here could only be a no-op with a second ordering rule to keep
 * in step.
 *
 * `taskTitle` is resolved by the caller and looked up per row rather than
 * carried on the notification, because a cloud row's own title is the epic's
 * title AT THE TIME THE ROW WAS WRITTEN.
 */
export function buildFocusPrompts(
  rows: ReadonlyArray<MergedNotificationRow>,
  taskTitles: ReadonlyMap<string, string>,
  /** {@link browserTabTitleKey} → the tab's title, from the browser rows this
   * same model is carrying. A browser prompt names a session and a tab and
   * nothing a reader recognises; this is what turns that into a page name. */
  browserTabTitles: ReadonlyMap<string, string>,
  previous: ReadonlyArray<FocusPromptRow>,
): ReadonlyArray<FocusPromptRow> {
  const candidates = selectPromptCandidates(rows);
  candidates.sort((a, b) =>
    compareAttentionOrder(
      { tier: a.tier, createdAt: a.row.createdAt, feedId: a.row.feedId },
      { tier: b.tier, createdAt: b.row.createdAt, feedId: b.row.feedId },
    ),
  );
  const next = candidates.map(({ row, kind }): FocusPromptRow => {
    const target = promptTarget(row);
    return {
      key: row.feedId,
      kind,
      epicId: target.epicId,
      chatId: target.chatId,
      taskTitle:
        target.epicId === null ? null : (taskTitles.get(target.epicId) ?? null),
      title: row.title,
      body: row.body,
      createdAt: row.createdAt,
      originHostId: row.originHostId,
      browserTabTitle:
        target.browserTab === null
          ? null
          : (browserTabTitles.get(
              browserTabTitleKey(
                target.browserTab.sessionId,
                target.browserTab.tabId,
              ),
            ) ?? null),
      activation: row,
    };
  });
  return stabilizeRows(next, previous, sameFocusPromptRow);
}

/**
 * Row equality for {@link buildFocusPrompts}, and the ONE place a focus row is
 * not compared with the generic shallow comparator.
 *
 * `activation` holds a whole `MergedNotificationRow`, and that store re-mints
 * every row object on any notification frame - a row marked read elsewhere, an
 * unrelated agent finishing. Comparing it by reference would therefore give
 * every prompt a new identity several times a minute, in the one section that
 * is non-empty precisely when the badge is non-zero.
 *
 * Comparing by `feedId` instead is safe for the one thing `activation` is used
 * for. The activation handler wants the occurrence AS IT WAS WHEN SHOWN
 * (`notification-activation-result.ts` keeps the captured row for exactly that
 * reason), and an equal-content earlier object with the same feed id IS that.
 * Every field this row derives FROM the notification - title, body,
 * `createdAt`, `originHostId` - is compared normally, so content drift under a
 * stable feed id still mints a new row.
 *
 * Exhaustive BY CONSTRUCTION rather than by a maintained field list: pulling
 * `activation` off with a rest destructure means a field added to
 * `FocusPromptRow` lands in `scalarsA`/`scalarsB` and is compared without
 * anyone remembering to come here. That is the property a hand-written `&&`
 * chain silently loses the first time the contract grows.
 */
function sameFocusPromptRow(a: FocusPromptRow, b: FocusPromptRow): boolean {
  const { activation: activationA, ...scalarsA } = a;
  const { activation: activationB, ...scalarsB } = b;
  return (
    activationA.feedId === activationB.feedId &&
    shallowEqualRow(scalarsA, scalarsB)
  );
}

/**
 * The badge's number, without building a model.
 *
 * `badgeCount === prompts.length` by construction - {@link buildFocusPrompts}
 * maps its candidates one-to-one with no post-filter - so counting the
 * candidates through the SAME selector is provably the same number rather than
 * a second derivation that could drift. That is what lets the Home tab's badge,
 * which is mounted for the life of the window, avoid running the whole
 * cross-task join while Home is closed.
 */
export function countPendingPromptRows(
  rows: ReadonlyArray<MergedNotificationRow>,
): number {
  return selectPromptCandidates(rows).length;
}

/** Epic ids a prompt row points at - the set the task rows read to decide
 * `needsYou` without re-walking the feed. */
export function focusPromptEpicIds(
  prompts: ReadonlyArray<FocusPromptRow>,
): ReadonlySet<string> {
  const epicIds = new Set<string>();
  for (const prompt of prompts) {
    if (prompt.epicId !== null) epicIds.add(prompt.epicId);
  }
  return epicIds;
}

/**
 * The same epic ids, straight from the raw feed - what the hook needs BEFORE it
 * can build a prompt row, because a task whose only presence on this page is a
 * waiting prompt still needs its title fetched.
 */
export function pendingPromptEpicIds(
  rows: ReadonlyArray<MergedNotificationRow>,
): ReadonlySet<string> {
  const epicIds = new Set<string>();
  for (const candidate of selectPromptCandidates(rows)) {
    const epicId = promptTarget(candidate.row).epicId;
    if (epicId !== null) epicIds.add(epicId);
  }
  return epicIds;
}

interface PromptCandidate {
  readonly row: MergedNotificationRow;
  readonly kind: FocusPromptKind;
  readonly tier: NotificationAttentionTier;
}

function selectPromptCandidates(
  rows: ReadonlyArray<MergedNotificationRow>,
): PromptCandidate[] {
  return rows.flatMap((row): PromptCandidate[] => {
    const kind = focusPromptKind(row);
    if (kind === null) return [];
    if (row.resolvedAt !== null) return [];
    const classification = classifyNotificationLifecycle(row);
    if (classification.section !== "attention") return [];
    return [{ row, kind, tier: classification.tier }];
  });
}

function focusPromptKind(row: MergedNotificationRow): FocusPromptKind | null {
  const hostKind = row.hostKind;
  if (hostKind === null) return null;
  if (!HOST_NOTIFICATION_PENDING_PROMPT_KINDS.includes(hostKind)) return null;
  return PROMPT_KIND_BY_HOST_KIND[hostKind] ?? null;
}

/**
 * Where the prompt lives, read from the NAVIGATION payload rather than the
 * row's raw fields: the payload is the second-stage semantic parse, so a row
 * from a newer host whose payload this build cannot understand answers `null`
 * here and renders without a task attribution instead of guessing one.
 *
 * A browser prompt names a session rather than a chat, so its `chatId` is
 * `null` - the row still opens (the activation payload carries the session and
 * tab), it just has no chat to attribute. It names a TAB instead, which is the
 * one thing a reader recognises once the browser plane can put a title on it.
 */
interface PromptTarget {
  readonly epicId: string | null;
  readonly chatId: string | null;
  readonly browserTab: {
    readonly sessionId: string;
    readonly tabId: string;
  } | null;
}

function promptTarget(row: MergedNotificationRow): PromptTarget {
  const payload = row.payload;
  if (payload === null) return NO_PROMPT_TARGET;
  if (payload.kind === "approval") {
    // An approval payload's ids are optional on the wire; absent stays absent
    // rather than becoming an empty-string id nothing can open.
    return {
      epicId: payload.epicId ?? null,
      chatId: payload.chatId ?? null,
      browserTab: null,
    };
  }
  if (payload.kind === "interview") {
    return {
      epicId: payload.epicId,
      chatId: payload.chatId,
      browserTab: null,
    };
  }
  if (payload.kind === "browserSession") {
    return {
      epicId: payload.epicId,
      chatId: null,
      browserTab: { sessionId: payload.sessionId, tabId: payload.tabId },
    };
  }
  return NO_PROMPT_TARGET;
}

const NO_PROMPT_TARGET: PromptTarget = {
  epicId: null,
  chatId: null,
  browserTab: null,
};
