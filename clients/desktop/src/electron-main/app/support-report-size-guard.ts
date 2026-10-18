import type { Attachment, Event, EventHint } from "@sentry/core";

/**
 * Keeps a support report's `feedback` event under Sentry's event size limit.
 *
 * Relay checks the serialized feedback item against `max_event_size` (1 MiB;
 * a feedback item is sized as an event) and discards an oversize item AFTER
 * answering the envelope with a 2xx, dropping its attachments as
 * `missing_event` with it. The client never sees that drop: `support.ts`
 * reads the 2xx as `delivered` and the public draft prints a bare report id.
 * Two reports in thirty days went this way (2026-10-01, 2026-10-10;
 * traycer#2461's `rpt_8b8bcd43…` was the second). So the event is bounded
 * here, at the last point this process controls it.
 *
 * Why an event processor and not `beforeSend`: core applies `beforeSend` to
 * error events only (`type === undefined`); a `type: "feedback"` event never
 * reaches it. Event processors run inside `prepareEvent`, before `sendEvent`
 * reads `hint.attachments` to build the envelope, so one hook can both trim
 * the event and add an attachment to the same hint.
 *
 * Order of trimming, re-measuring after each step and stopping as soon as
 * the event fits:
 *
 * 1. The report text (`contexts.feedback.message`) above its keep size moves
 *    into a `report-text.txt` attachment; the message keeps its head plus one
 *    marker line. Attachments are not part of the event size (Relay allows
 *    200 MiB per attachment and per envelope), so the reporter's text is not
 *    discarded; the attachment is capped at {@link REPORT_TEXT_ATTACHMENT_MAX_BYTES}
 *    so it can never be the item that matters either.
 * 2. Breadcrumbs are dropped (the report carries both log tails as
 *    attachments anyway).
 * 3. Every context except `feedback` is a candidate, dropped largest first.
 *    The list is not enumerated by name on purpose: `support.ts` adds
 *    `layer0`, `processMetrics`, `appMetrics`, `errorCause` and `registry`,
 *    the SDK adds `os`, `device`, `app`, `runtime`, `electron`, and a name the
 *    guard did not know about is exactly how an oversize event would get
 *    through. `errorCause` carries an error's message and stack unbounded, so
 *    it is the one that matters in practice; the SDK's contexts are a few
 *    hundred bytes and are only ever reached after everything larger is gone.
 *
 * After step 3 what remains is the message head (at most the keep size plus
 * a marker), the tags, `contexts.feedback`'s name and email, and the SDK's
 * own fields: bounded given today's producers (every tag the report sets is
 * a short hash or version, nothing in this app sets `extra` or `user`), not
 * trimmed by the guard. The steps run against the budget less a reserve for
 * the metadata they add, so the returned event is under the budget whenever
 * step 3 reached it. What was trimmed is recorded as a bounded tag so a
 * reader of the Sentry item knows the shape is not the full one.
 */

/** Headroom under Relay's 1 MiB for normalization and the envelope header. */
export const FEEDBACK_EVENT_BUDGET_BYTES = 768 * 1024;

/**
 * What the trimming steps aim for: the budget less room for the
 * `reportTrimmed` tag and `reportSize` context they add afterwards, so an
 * event that lands just under the budget does not end up just over it.
 */
const TRIM_TARGET_BYTES = FEEDBACK_EVENT_BUDGET_BYTES - 1024;

/** How much of an oversize report text stays inline in the message. */
export const FEEDBACK_MESSAGE_KEEP_BYTES = 32 * 1024;

/**
 * Cap on the `report-text.txt` attachment. Report text is typed or pasted
 * into one textarea with no length limit; this keeps the attachment far
 * inside Relay's 200 MiB limits and inside the headroom of
 * `TOTAL_ATTACHMENT_BUDGET_BYTES`'s neighbours (`image-attachment-guards.ts`).
 */
export const REPORT_TEXT_ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;

export const REPORT_TEXT_ATTACHMENT_FILENAME = "report-text.txt";

/** Never dropped: it is the report. */
const FEEDBACK_CONTEXT = "feedback";

/** Bounded, so it can ride as a Sentry tag. */
export type FeedbackTrim =
  | "message"
  | "breadcrumbs"
  | "contexts"
  | "message+breadcrumbs"
  | "message+contexts"
  | "breadcrumbs+contexts"
  | "message+breadcrumbs+contexts";

export const REPORT_TRIMMED_TAG = "reportTrimmed";

export interface BoundFeedbackEventResult {
  readonly event: Event;
  /** `null` when the event already fit and was returned as given. */
  readonly trimmed: FeedbackTrim | null;
  readonly originalBytes: number;
  /** Serialized size of `event` as returned. */
  readonly sentBytes: number;
  /** Names of the contexts step 3 dropped, largest first. */
  readonly droppedContexts: readonly string[];
}

function serializedBytes(value: unknown): number {
  // `JSON.stringify(undefined)` is `undefined`, which `byteLength` rejects.
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

function feedbackMessageOf(event: Event): string | null {
  const feedback = event.contexts?.[FEEDBACK_CONTEXT];
  const message =
    feedback !== undefined && feedback !== null
      ? (feedback as { message?: unknown }).message
      : undefined;
  return typeof message === "string" ? message : null;
}

/**
 * The first `keepBytes` of `text` with every character kept whole: a
 * multi-byte character split by the byte cut is dropped with the tail rather
 * than left as U+FFFD. Nothing else about the cut is adjusted, so a text that
 * is one long line keeps (almost) all of its first `keepBytes`.
 */
export function headOfBytes(text: string, keepBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= keepBytes) return text;
  const head = bytes.subarray(0, keepBytes).toString("utf8");
  return head.endsWith("�") ? head.slice(0, -1) : head;
}

/**
 * {@link headOfBytes}, cut back to the last line break (or, when the kept
 * head has none, the last space) so an inline head ends on a boundary a
 * reader expects. Not for the attachment: a pasted one-line blob would keep
 * only the lines before it.
 */
export function headOfText(text: string, keepBytes: number): string {
  const head = headOfBytes(text, keepBytes);
  if (head === text) return text;
  const lastBreak = head.lastIndexOf("\n");
  if (lastBreak > 0) return head.slice(0, lastBreak);
  const lastSpace = head.lastIndexOf(" ");
  return lastSpace > 0 ? head.slice(0, lastSpace) : head;
}

function trimName(
  message: boolean,
  breadcrumbs: boolean,
  contexts: boolean,
): FeedbackTrim | null {
  const parts: string[] = [];
  if (message) parts.push("message");
  if (breadcrumbs) parts.push("breadcrumbs");
  if (contexts) parts.push("contexts");
  const joined = parts.join("+");
  return FEEDBACK_TRIMS.find((trim) => trim === joined) ?? null;
}

const FEEDBACK_TRIMS: readonly FeedbackTrim[] = [
  "message",
  "breadcrumbs",
  "contexts",
  "message+breadcrumbs",
  "message+contexts",
  "breadcrumbs+contexts",
  "message+breadcrumbs+contexts",
];

/** Name of the largest context other than `feedback`, or `null` if none. */
function largestDroppableContext(contexts: Event["contexts"]): string | null {
  if (contexts === undefined) return null;
  let largest: string | null = null;
  let largestBytes = -1;
  for (const [name, value] of Object.entries(contexts)) {
    if (name === FEEDBACK_CONTEXT) continue;
    const bytes = serializedBytes(value);
    if (bytes > largestBytes) {
      largest = name;
      largestBytes = bytes;
    }
  }
  return largest;
}

function withReportSize(
  event: Event,
  trimmed: FeedbackTrim,
  originalBytes: number,
  sentBytes: number,
  droppedContexts: readonly string[],
): Event {
  return {
    ...event,
    tags: { ...event.tags, [REPORT_TRIMMED_TAG]: trimmed },
    contexts: {
      ...event.contexts,
      reportSize: {
        originalBytes,
        sentBytes,
        ...(droppedContexts.length === 0
          ? {}
          : { droppedContexts: droppedContexts.join(",") }),
      },
    },
  };
}

/**
 * Bounds a `feedback` event to {@link FEEDBACK_EVENT_BUDGET_BYTES}. The input
 * event is not mutated; `hint.attachments` is replaced with an extended copy
 * when the report text is moved out, because the SDK reads attachments from
 * this same hint object when it builds the envelope.
 *
 * Any other event type is returned as given.
 */
export function boundFeedbackEvent(
  event: Event,
  hint: EventHint,
): BoundFeedbackEventResult {
  const originalBytes = serializedBytes(event);
  if (
    event.type !== "feedback" ||
    originalBytes <= FEEDBACK_EVENT_BUDGET_BYTES
  ) {
    return {
      event,
      trimmed: null,
      originalBytes,
      sentBytes: originalBytes,
      droppedContexts: [],
    };
  }

  let bounded: Event = { ...event };
  let sentBytes = originalBytes;
  let messageMoved = false;
  let breadcrumbsDropped = false;
  const droppedContexts: string[] = [];

  const message = feedbackMessageOf(bounded);
  if (
    message !== null &&
    Buffer.byteLength(message, "utf8") > FEEDBACK_MESSAGE_KEEP_BYTES
  ) {
    const messageBytes = Buffer.byteLength(message, "utf8");
    const attached =
      messageBytes > REPORT_TEXT_ATTACHMENT_MAX_BYTES
        ? headOfBytes(message, REPORT_TEXT_ATTACHMENT_MAX_BYTES)
        : message;
    const attachment: Attachment = {
      filename: REPORT_TEXT_ATTACHMENT_FILENAME,
      data: attached,
      contentType: "text/plain",
    };
    hint.attachments = [...(hint.attachments ?? []), attachment];
    const head = headOfText(message, FEEDBACK_MESSAGE_KEEP_BYTES);
    const marker =
      attached === message
        ? `[Report text continues in the attachment ${REPORT_TEXT_ATTACHMENT_FILENAME} (${messageBytes} bytes in total).]`
        : `[Report text continues in the attachment ${REPORT_TEXT_ATTACHMENT_FILENAME}, which holds the first ${Buffer.byteLength(attached, "utf8")} of ${messageBytes} bytes.]`;
    bounded = {
      ...bounded,
      contexts: {
        ...bounded.contexts,
        [FEEDBACK_CONTEXT]: {
          ...bounded.contexts?.[FEEDBACK_CONTEXT],
          message: `${head}\n\n${marker}`,
        },
      },
    };
    messageMoved = true;
    sentBytes = serializedBytes(bounded);
  }

  if (sentBytes > TRIM_TARGET_BYTES && bounded.breadcrumbs !== undefined) {
    const { breadcrumbs: _dropped, ...withoutBreadcrumbs } = bounded;
    bounded = withoutBreadcrumbs;
    breadcrumbsDropped = true;
    sentBytes = serializedBytes(bounded);
  }

  while (sentBytes > TRIM_TARGET_BYTES) {
    const name = largestDroppableContext(bounded.contexts);
    if (name === null || bounded.contexts === undefined) break;
    const { [name]: _dropped, ...rest } = bounded.contexts;
    bounded = { ...bounded, contexts: rest };
    droppedContexts.push(name);
    sentBytes = serializedBytes(bounded);
  }

  const trimmed = trimName(
    messageMoved,
    breadcrumbsDropped,
    droppedContexts.length > 0,
  );
  if (trimmed !== null) {
    // Two passes so `reportSize.sentBytes` names the size of the event as
    // returned, metadata included: the first measures the event with the
    // metadata on it, the second writes that number in (it can only differ
    // from the first in the width of the number itself).
    const withMeta = serializedBytes(
      withReportSize(
        bounded,
        trimmed,
        originalBytes,
        sentBytes,
        droppedContexts,
      ),
    );
    bounded = withReportSize(
      bounded,
      trimmed,
      originalBytes,
      withMeta,
      droppedContexts,
    );
    sentBytes = serializedBytes(bounded);
  }
  return { event: bounded, trimmed, originalBytes, sentBytes, droppedContexts };
}
