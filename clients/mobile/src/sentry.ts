import type { BrowserOptions } from "@sentry/browser";
import {
  scrubSentryBreadcrumbInPlace,
  scrubSentryEventInPlace,
  scrubSentrySpanInPlace,
  scrubSentryTransactionInPlace,
} from "@traycer-clients/shared/platform/sentry-scrub";

export type SentryBakedConfig = Pick<
  TraycerMobileBakedConfig,
  "sentryDsn" | "environment"
>;

/**
 * `@sentry/browser` only: Capacitor's SDK pins a different browser build and would split the global carrier gui-app reads.
 * Scrub hooks are required; link-login puts a one-time code in fetch URLs, and `beforeBreadcrumb` runs at record time.
 */
export function sentryInitOptions(
  config: SentryBakedConfig,
): BrowserOptions | null {
  if (config.sentryDsn.length === 0) {
    return null;
  }
  return {
    dsn: config.sentryDsn,
    environment: config.environment,
    attachStacktrace: true,
    sendDefaultPii: false,
    beforeSend: (event) => {
      scrubSentryEventInPlace(event);
      return event;
    },
    beforeBreadcrumb: (breadcrumb) => {
      scrubSentryBreadcrumbInPlace(breadcrumb);
      return breadcrumb;
    },
    beforeSendTransaction: (event) => {
      scrubSentryTransactionInPlace(event);
      return event;
    },
    beforeSendSpan: (span) => {
      scrubSentrySpanInPlace(span);
      return span;
    },
  };
}
