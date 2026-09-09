import type { BrowserOptions } from "@sentry/browser";
import {
  scrubSentryBreadcrumbInPlace,
  scrubSentryEventInPlace,
  scrubSentrySpanInPlace,
  scrubSentryTransactionInPlace,
} from "@traycer-clients/shared/platform/sentry-scrub";

/**
 * The slice of the baked config that decides crash reporting. Narrowed so the
 * helper (and its tests) never depend on the rest of the shape.
 */
export type SentryBakedConfig = Pick<
  TraycerMobileBakedConfig,
  "sentryDsn" | "environment"
>;

/**
 * Crash-reporting options for the mobile shell, or `null` when reporting is
 * OFF - every build with no DSN baked, which is every local build by default.
 * The caller passes the result straight to `@sentry/browser`'s `init`.
 *
 * `@sentry/browser`, on purpose, and NOT `@sentry/capacitor`. gui-app reports
 * its error-boundary catches through `@sentry/browser` too
 * (`src/lib/report-issue-error-capture.ts`), gated on `isInitialized()`, and
 * Sentry keys its global carrier by the SDK's FULL version string
 * (`__SENTRY__[SDK_VERSION]`). So the shell's `init` populates the carrier
 * gui-app reads only if both resolve to the SAME `@sentry/browser` build -
 * which the shared catalog pin guarantees. `@sentry/capacitor` hard-pins a
 * different `@sentry/browser` (4.3.0 → 10.69.0 against the catalog's 10.70.0),
 * and bun applies overrides globally - one that unified it would also drag
 * `@sentry/node` (the CLI's SDK) off its own pin. Until a Capacitor SDK
 * release pins the catalog's version, this shell reports the WebView layer
 * only; native (Swift / Kotlin) crashes stay with Apple's and Google's
 * consoles.
 *
 * The four hooks are the same egress filter the desktop renderer installs,
 * from the same shared module and the same detection leaf
 * (`@traycer/protocol/utils/text/redaction`). They are not optional here: the
 * browser SDK records the full URL of every fetch in a breadcrumb, and the
 * link-login flow carries its one-time sign-in code in a query string
 * (`clients/shared/auth/link-login.ts`), so an unfiltered event would upload
 * a credential. `beforeBreadcrumb` runs at RECORD time, not send time,
 * because the scope outlives the event. The transaction/span hooks are inert
 * until a tracing integration exists and are registered anyway, so adding one
 * cannot reopen `url.full` - `beforeSend` never sees a transaction.
 *
 * Errors only: the `traycer-mobile` project was created with Tracing and Logs
 * unchecked, and there is no `browserTracingIntegration` here, so a
 * `tracesSampleRate` would be inert config. Errors sample at the SDK default
 * (100%), matching the desktop renderer. `release` is left unset on purpose:
 * `@sentry/browser` reads the `SENTRY_RELEASE` global the upload plugin
 * injects at build time, so events and their sourcemaps agree by construction.
 *
 * No `setUser` and `sendDefaultPii: false`: the account is not attached to
 * events. Sentry is a third party, and the repo's log-hygiene rule keeps
 * account identifiers out of anything that leaves the process above DEBUG.
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
