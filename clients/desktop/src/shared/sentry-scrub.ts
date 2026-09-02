/**
 * Sentry event shaping shared by the two inits this app runs -
 * `electron-main/app/crash-reporter.ts` (main process) and
 * `renderer-shell/main.tsx` (app-shell renderer).
 *
 * `@sentry/electron`'s `electronBreadcrumbsIntegration` writes the full
 * renderer URL into every `webContents.*` breadcrumb it records, and the
 * browser SDK does the same for fetch/xhr/navigation; console breadcrumbs
 * carry the joined `console.*` arguments, and an unhandled error uploads its
 * message verbatim in `exception.values[].value`. None of that passes a
 * redactor on its own, and breadcrumbs are persisted to `scope_v3.json` and
 * re-attached to a later, unrelated crash.
 *
 * Detection comes from `@traycer/protocol/utils/text/redaction` and nothing
 * else, and the deep walk with its depth/array/key bounds from
 * `@traycer/protocol/utils/text/sentry-scrub`. What lives here is the
 * desktop's Sentry policy: which fields to walk and what to drop outright.
 *
 * Deliberately does NOT reach into `electron-main/app/support-scrubber.ts`.
 * That module is the support-bundle policy (path pseudonymization, no length
 * cap, line-wise application); telemetry egress must not inherit whatever it
 * decides next, and the renderer cannot import from `electron-main/` at all.
 */

import {
  redactQueryString,
  redactSensitiveText,
  reduceRequestTargetToPath,
  reduceUrlToOriginAndPath,
} from "@traycer/protocol/utils/text/redaction";
import {
  deepScrubSentryRecord,
  deepScrubSentryValue,
  isPlainRecord,
} from "@traycer/protocol/utils/text/sentry-scrub";

/** The slice of a Sentry event these hooks read and rewrite. */
export interface DesktopSentryEvent {
  platform?: string | undefined;
  message?: string | undefined;
  logentry?: { message?: string | undefined; params?: unknown } | undefined;
  exception?:
    | { values?: { value?: string | undefined }[] | undefined }
    | undefined;
  tags?: { [key: string]: unknown } | undefined;
  extra?: { [key: string]: unknown } | undefined;
  contexts?: { [key: string]: unknown } | undefined;
  breadcrumbs?: DesktopSentryBreadcrumb[] | undefined;
  request?: DesktopSentryRequest | undefined;
}

/**
 * The renderer SDK attaches request data to an event. Cookies and headers are
 * removed rather than scrubbed: neither carries anything a maintainer reads,
 * and both carry session credentials whole.
 */
interface DesktopSentryRequest {
  url?: string | undefined;
  query_string?: unknown;
  cookies?: unknown;
  headers?: unknown;
  data?: unknown;
}

export interface DesktopSentryBreadcrumb extends UrlBearingBreadcrumb {
  message?: string | undefined;
}

export function scrubDesktopSentryEventInPlace(
  event: DesktopSentryEvent,
): void {
  if (event.message !== undefined) {
    event.message = redactSensitiveText(event.message);
  }
  if (event.logentry?.message !== undefined) {
    event.logentry.message = redactSensitiveText(event.logentry.message);
  }
  if (event.logentry?.params !== undefined) {
    event.logentry.params = deepScrubSentryValue(
      event.logentry.params,
      redactSensitiveText,
    );
  }
  // The dominant funnel: `captureException(error)` renders the thrown error's
  // message here, and `linkedErrorsIntegration` appends one entry per `cause`.
  for (const exception of event.exception?.values ?? []) {
    if (exception.value !== undefined) {
      exception.value = redactSensitiveText(exception.value);
    }
  }
  // Tags are indexed and searchable in the Sentry UI, which is exactly why a
  // caller reaches for one - and `setTag("url", …)` / a tag built from an
  // error string carries the same credentials `extra` does. The minidump-drop
  // policy reads `tags` BEFORE this runs (see `crash-reporter-guest-scope.ts`),
  // so redacting them here cannot reopen that channel.
  if (event.tags !== undefined) {
    event.tags = deepScrubSentryRecord(event.tags, redactSensitiveText);
  }
  if (event.extra !== undefined) {
    event.extra = deepScrubSentryRecord(event.extra, redactSensitiveText);
  }
  if (event.contexts !== undefined) {
    event.contexts = deepScrubSentryRecord(event.contexts, redactSensitiveText);
  }
  for (const breadcrumb of event.breadcrumbs ?? []) {
    scrubDesktopBreadcrumbInPlace(breadcrumb);
  }
  if (event.request !== undefined) {
    scrubDesktopRequestInPlace(event.request);
  }
}

function scrubDesktopRequestInPlace(request: DesktopSentryRequest): void {
  delete request.cookies;
  delete request.headers;
  if (request.url !== undefined) {
    request.url = reduceUrlToOriginAndPath(request.url);
  }
  if (request.query_string !== undefined) {
    request.query_string =
      typeof request.query_string === "string"
        ? redactQueryString(request.query_string)
        : deepScrubSentryValue(request.query_string, redactSensitiveText);
  }
  if (request.data !== undefined) {
    request.data = deepScrubSentryValue(request.data, redactSensitiveText);
  }
}

export function scrubDesktopBreadcrumbInPlace(
  breadcrumb: DesktopSentryBreadcrumb,
): void {
  reduceBreadcrumbUrlsInPlace(breadcrumb);
  if (breadcrumb.message !== undefined) {
    breadcrumb.message = redactSensitiveText(breadcrumb.message);
  }
  if (breadcrumb.data !== undefined) {
    breadcrumb.data = deepScrubSentryRecord(
      breadcrumb.data,
      redactSensitiveText,
    );
  }
}

/** The slice of a Sentry breadcrumb whose URL fields are reduced. */
interface UrlBearingBreadcrumb {
  data?: { [key: string]: unknown } | undefined;
}

/**
 * Breadcrumb `data` keys that carry a URL across the SDKs we run: `url`
 * (fetch / xhr / the electron integration's renderer properties) and
 * `from`/`to` (navigation).
 */
const URL_BEARING_KEYS = new Set(["url", "from", "to"]);

function reduceBreadcrumbUrlsInPlace(breadcrumb: UrlBearingBreadcrumb): void {
  const data = breadcrumb.data;
  if (data === undefined) return;
  for (const key of URL_BEARING_KEYS) {
    const value = data[key];
    if (typeof value === "string") {
      data[key] = reduceUrlToOriginAndPath(value);
    }
  }
}

/** A transaction event: the root span's attributes hang off `contexts.trace`. */
export interface DesktopSentryTransaction extends DesktopSentryEvent {
  transaction?: string | undefined;
  spans?: DesktopSentrySpan[] | undefined;
}

export interface DesktopSentrySpan {
  description?: string | undefined;
  data?: { [key: string]: unknown } | undefined;
}

/** Span attributes holding a URL or a request target. */
const URL_BEARING_SPAN_ATTRIBUTES = ["url.full", "http.url", "http.target"];

/** The attribute that is nothing but the query string. */
const QUERY_SPAN_ATTRIBUTE = "url.query";

/**
 * `beforeSendTransaction`. Tracing is on, and the http / undici
 * instrumentations stamp the full request URL - query string and all - onto
 * every span with no `sendDefaultPii` gate, so the tracing envelope needs its
 * own hooks: `beforeSend` never sees a transaction.
 */
export function scrubDesktopSentryTransactionInPlace(
  event: DesktopSentryTransaction,
): void {
  scrubDesktopSentryEventInPlace(event);
  if (event.transaction !== undefined) {
    event.transaction = redactSensitiveText(event.transaction);
  }
  const trace = event.contexts?.["trace"];
  if (isPlainRecord(trace)) {
    reduceSpanAttributesInPlace(trace["data"]);
  }
  for (const span of event.spans ?? []) {
    scrubDesktopSentrySpanInPlace(span);
  }
}

/** `beforeSendSpan`: child spans travel outside the transaction event. */
export function scrubDesktopSentrySpanInPlace(span: DesktopSentrySpan): void {
  if (span.description !== undefined) {
    span.description = redactSensitiveText(span.description);
  }
  reduceSpanAttributesInPlace(span.data);
}

function reduceSpanAttributesInPlace(data: unknown): void {
  if (!isPlainRecord(data)) return;
  // The whole record first, then the URL attributes. Span data is an OPEN map
  // - any instrumentation, and any of our own code, may put an
  // `authorization`, a `cookie` or a token-bearing custom key in it - so
  // handling only the URL attributes below would send every other one through
  // `beforeSendSpan` untouched. `deepScrubSentryRecord` answers a new record
  // rather than mutating, so its result is written back key by key: the
  // caller holds this object by reference and the reduction below operates on
  // the same one.
  const scrubbed = deepScrubSentryRecord(data, redactSensitiveText);
  for (const key of Object.keys(data)) delete data[key];
  Object.assign(data, scrubbed);
  delete data[QUERY_SPAN_ATTRIBUTE];
  for (const key of URL_BEARING_SPAN_ATTRIBUTES) {
    const value = data[key];
    if (typeof value === "string") {
      data[key] = reduceRequestTargetToPath(value);
    }
  }
}
