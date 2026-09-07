/**
 * One policy, one detection leaf, so a credential class caught on one surface is caught on all of them.
 * What lives here is the client Sentry policy: which fields to walk and what to drop outright.
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

export interface ClientSentryEvent {
  platform?: string | undefined;
  message?: string | undefined;
  logentry?: { message?: string | undefined; params?: unknown } | undefined;
  exception?:
    | { values?: { value?: string | undefined }[] | undefined }
    | undefined;
  tags?: { [key: string]: unknown } | undefined;
  extra?: { [key: string]: unknown } | undefined;
  contexts?: { [key: string]: unknown } | undefined;
  breadcrumbs?: ClientSentryBreadcrumb[] | undefined;
  request?: ClientSentryRequest | undefined;
}

/**
 * The browser SDK attaches request data to an event.
 * Cookies and headers are removed rather than scrubbed: neither carries anything a maintainer reads, and both carry session credentials whole.
 */
interface ClientSentryRequest {
  url?: string | undefined;
  query_string?: unknown;
  cookies?: unknown;
  headers?: unknown;
  data?: unknown;
}

export interface ClientSentryBreadcrumb extends UrlBearingBreadcrumb {
  message?: string | undefined;
}

export function scrubSentryEventInPlace(event: ClientSentryEvent): void {
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
  // Tags are indexed and searchable in the Sentry UI, which is exactly why a caller reaches for one - and `setTag("url", …)` / a tag built from an error string carries the same credentials `extra` does.
  // The desktop's minidump-drop policy reads `tags` before this runs (see its `crash-reporter-guest-scope.ts`), so redacting them here cannot reopen that channel.
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
    scrubSentryBreadcrumbInPlace(breadcrumb);
  }
  if (event.request !== undefined) {
    scrubRequestInPlace(event.request);
  }
}

function scrubRequestInPlace(request: ClientSentryRequest): void {
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

export function scrubSentryBreadcrumbInPlace(
  breadcrumb: ClientSentryBreadcrumb,
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

interface UrlBearingBreadcrumb {
  data?: { [key: string]: unknown } | undefined;
}

/**
 * Breadcrumb `data` keys that carry a URL across the SDKs we run: `url` (fetch / xhr / the electron integration's renderer properties) and `from`/`to` (navigation).
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

export interface ClientSentryTransaction extends ClientSentryEvent {
  transaction?: string | undefined;
  spans?: ClientSentrySpan[] | undefined;
}

export interface ClientSentrySpan {
  description?: string | undefined;
  data?: { [key: string]: unknown } | undefined;
}

const URL_BEARING_SPAN_ATTRIBUTES = ["url.full", "http.url", "http.target"];

const QUERY_SPAN_ATTRIBUTE = "url.query";

/**
 * `beforeSendTransaction`.
 * Registered even where no tracing integration is installed yet, so that adding one cannot reopen `url.full`.
 */
export function scrubSentryTransactionInPlace(
  event: ClientSentryTransaction,
): void {
  scrubSentryEventInPlace(event);
  if (event.transaction !== undefined) {
    event.transaction = redactSensitiveText(event.transaction);
  }
  const trace = event.contexts?.["trace"];
  if (isPlainRecord(trace)) {
    reduceSpanAttributesInPlace(trace["data"]);
  }
  for (const span of event.spans ?? []) {
    scrubSentrySpanInPlace(span);
  }
}

export function scrubSentrySpanInPlace(span: ClientSentrySpan): void {
  if (span.description !== undefined) {
    span.description = redactSensitiveText(span.description);
  }
  reduceSpanAttributesInPlace(span.data);
}

function reduceSpanAttributesInPlace(data: unknown): void {
  if (!isPlainRecord(data)) return;
  // The whole record first, then the URL attributes.
  // `deepScrubSentryRecord` answers a new record rather than mutating, so its result is written back key by key: the caller holds this object by reference and the reduction below operates on the same one.
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
