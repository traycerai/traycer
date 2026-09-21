/**
 * Delivery evidence beyond afterSendEvent's HTTP status: whether the feedback
 * item survived transport filtering, how long a known limit remains, and
 * whether the offline store retained the exact event. The rate-limit mirror
 * supplies retry hints only; the base transport's filter decides inclusion.
 * Electron-free so these rules can be exercised with core's real transport.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
// A runtime import of the transport's own rate-limit helpers, which
// `@sentry/electron/main` does not re-export; `@sentry/core` is a direct
// dependency of this workspace for that reason.
import {
  disabledUntil,
  isRateLimited,
  updateRateLimits,
  type BaseTransportOptions,
  type RateLimits,
  type Transport,
  type TransportMakeRequestResponse,
} from "@sentry/core";

interface FeedbackInclusion {
  readonly eventId: string;
  readonly included: boolean;
}

const feedbackInclusions = new WeakMap<
  TransportMakeRequestResponse,
  FeedbackInclusion
>();

/** The feedback item's actual filter verdict, attributed to this response. */
export function sentryFeedbackInclusion(
  response: TransportMakeRequestResponse,
  eventId: string,
): boolean | null {
  const inclusion = feedbackInclusions.get(response);
  return inclusion?.eventId === eventId ? inclusion.included : null;
}

/**
 * Decorates the base transport INSIDE the offline wrapper. Core filters items
 * synchronously in send, reporting each rejected category before it starts
 * the request. Observing that callback uses the transport's actual decision,
 * including limits earned by non-event envelopes and expiry during async
 * event preparation. A capture-time or after-response snapshot cannot do so.
 *
 * Keep the original response object: Electron's offline wrapper passes it to
 * afterSendEvent unchanged. Weak keys retain no completed-report history.
 */
export function observeSentryTransportFeedback(
  options: BaseTransportOptions,
  makeTransport: (options: BaseTransportOptions) => Transport,
): Transport {
  let onFeedbackDropped: (() => void) | null = null;
  const transport = makeTransport({
    ...options,
    recordDroppedEvent: (reason, category, count) => {
      if (reason === "ratelimit_backoff" && category === "feedback") {
        onFeedbackDropped?.();
      }
      options.recordDroppedEvent(reason, category, count);
    },
  });
  return {
    flush: (timeout) => transport.flush(timeout),
    send: (envelope) => {
      const eventId = envelope[0].event_id;
      const hasFeedback = envelope[1].some(
        ([header]) => header.type === "feedback",
      );
      if (typeof eventId !== "string" || !hasFeedback) {
        return transport.send(envelope);
      }
      let included = true;
      const previousObserver = onFeedbackDropped;
      onFeedbackDropped = () => {
        included = false;
      };
      try {
        return transport.send(envelope).then((response) => {
          feedbackInclusions.set(response, { eventId, included });
          return response;
        });
      } finally {
        // No asynchronous request can retain another report's filter context.
        onFeedbackDropped = previousObserver;
      }
    },
  };
}

/**
 * The data category a user-submitted report rides as.
 *
 * `Sentry.captureFeedback` sends an event of type `feedback`, and
 * `envelopeItemTypeToDataCategory` passes that type through unchanged (only
 * a handful of types are overridden, and `feedback` is not one), so this is
 * the category the transport itself tests before dropping the envelope. It
 * matters that it is not `error`: a limit naming only `error` does NOT stop
 * a report, and claiming otherwise would tell a user to wait for nothing.
 * A blanket limit (a bare 429, or a `retry-after` with no
 * `x-sentry-rate-limits`) lands on `all`, which `disabledUntil` falls back
 * to for every category, so the common case is covered without naming it.
 */
const REPORT_DATA_CATEGORY = "feedback";

/** What the rate-limit window says about sending a report right now. */
export interface SentryReportRateLimit {
  readonly limited: boolean;
  /**
   * Whole seconds until the limit lifts, rounded up; `null` when not
   * limited. Never 0 while `limited` - a limit that has already expired
   * reads as not limited.
   */
  readonly retryAfterSeconds: number | null;
}

/**
 * A client-wide rate-limit window, fed one transport response at a time.
 *
 * A factory rather than module state so the whole rule is testable against
 * an explicit clock; production uses the single
 * {@link sentryReportRateLimitWindow} below, because there is one Sentry
 * client per process and the window is a property of that client's DSN
 * quota, not of any one report.
 */
export interface SentryRateLimitWindow {
  observe(response: TransportMakeRequestResponse, nowMs: number): void;
  current(nowMs: number): SentryReportRateLimit;
}

export function createSentryRateLimitWindow(): SentryRateLimitWindow {
  let limits: RateLimits = {};
  return {
    observe: (response, nowMs) => {
      // Core's own updater, not a hand-rolled header parse: it is what the
      // transport uses to decide what to drop, so reading the headers any
      // other way would let this window and the transport's behaviour
      // disagree about the same response.
      limits = updateRateLimits(limits, response, nowMs);
    },
    current: (nowMs) => {
      if (!isRateLimited(limits, REPORT_DATA_CATEGORY, nowMs)) {
        return { limited: false, retryAfterSeconds: null };
      }
      const remainingMs = disabledUntil(limits, REPORT_DATA_CATEGORY) - nowMs;
      return {
        limited: true,
        retryAfterSeconds:
          remainingMs > 0 ? Math.ceil(remainingMs / 1000) : null,
      };
    },
  };
}

/** The process-wide window `crash-reporter` installs the observer into. */
export const sentryReportRateLimitWindow = createSentryRateLimitWindow();

/** `<userData>/sentry/queue` - see {@link sentryOfflineQueueFile}. */
export function sentryOfflineQueuePath(userDataPath: string): string {
  return join(userDataPath, "sentry", "queue");
}

/**
 * The offline store's index file inside `queuePath`.
 *
 * `createOfflineStore` builds a `Store(queuePath, 'queue-v2', [])`, which
 * writes `<queuePath>/queue-v2.json` holding `{ id, date }` entries, and
 * writes each envelope's bytes to `<queuePath>/<id>` first. Both halves are
 * read below, and the pair is what makes the answer attributable.
 */
function sentryOfflineQueueFile(queuePath: string): string {
  return join(queuePath, "queue-v2.json");
}

/**
 * Whether the offline store is currently holding an envelope for `eventId`.
 *
 * The queue's ids are `uuid4()`s minted inside the store's `insert`, never
 * the envelope's `event_id`, so the index alone cannot say WHOSE envelope a
 * given entry is - which is why this also reads each queued entry's body
 * and compares the `event_id` in its envelope header. That makes the answer
 * exact rather than inferred, and it is what lets a report answer "queued"
 * while a crash report from the same client is being queued alongside it: a
 * count or a set difference could not tell the two apart.
 *
 * Every failure reads as "not queued", which is the safe direction here:
 * the caller's fallback is `unconfirmed`, which neither promises delivery
 * nor invites a resend. Three real cases land there -
 *
 * - the store's index write was SWALLOWED (`Store.set` catches its own
 *   `writeFile` failure, for antivirus and network-drive reasons), so the
 *   in-memory queue holds an envelope the disk does not;
 * - the body write failed while the entry still landed in the index, which
 *   means the replay will never be able to read it back;
 * - the envelope was dropped at the store's `maxQueueSize` cap, where
 *   `insert` unlinks the body and returns the queue unchanged.
 *
 * - and in all three "we could not confirm" is the truth.
 */
export async function wasEventQueuedOffline(
  queuePath: string,
  eventId: string,
): Promise<boolean> {
  const queuedIds = await readQueuedEntryIds(sentryOfflineQueueFile(queuePath));
  for (const id of queuedIds) {
    if (await queuedBodyCarriesEventId(join(queuePath, id), eventId)) {
      return true;
    }
  }
  return false;
}

/** The `id`s in the store's index, or none when it cannot be read or understood. */
async function readQueuedEntryIds(
  queueFile: string,
): Promise<readonly string[]> {
  let raw: string;
  try {
    raw = await readFile(queueFile, "utf8");
  } catch {
    // Includes the ordinary case: the store creates this file on its first
    // successful write, so "no file" means "nothing queued".
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  // Re-typed as `unknown[]` rather than iterated as `any[]`: every field
  // below is checked, and `any` would let a future read skip the check.
  const entries: readonly unknown[] = parsed;
  const ids: string[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const id: unknown = Reflect.get(entry, "id");
    if (typeof id === "string" && id.length > 0) ids.push(id);
  }
  return ids;
}

/**
 * Whether the envelope stored at `bodyPath` was sent for `eventId`.
 *
 * Read as bytes and split at the first newline rather than parsed whole: a
 * report carries image attachments, so `serializeEnvelope` returns binary
 * and only the first line - the envelope header - is text. `event_id` is in
 * that header for every event envelope (`createEventEnvelopeHeaders`).
 */
async function queuedBodyCarriesEventId(
  bodyPath: string,
  eventId: string,
): Promise<boolean> {
  let headerLine: string;
  try {
    const body = await readFile(bodyPath);
    const newlineAt = body.indexOf(0x0a);
    headerLine = (
      newlineAt === -1 ? body : body.subarray(0, newlineAt)
    ).toString("utf8");
  } catch {
    return false;
  }
  let header: unknown;
  try {
    header = JSON.parse(headerLine);
  } catch {
    return false;
  }
  if (header === null || typeof header !== "object") return false;
  return Reflect.get(header, "event_id") === eventId;
}
