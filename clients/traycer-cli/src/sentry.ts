import * as Sentry from "@sentry/node";
import {
  scrubSentryEventInPlace,
  scrubSentrySpanInPlace,
  scrubSentryTransactionInPlace,
} from "@traycer-clients/shared/platform/sentry-scrub";
import { config } from "./config";
import { trackingHttpModule } from "./sentry-transport";

const dsn = process.env.TRAYCER_CLI_SENTRY_DSN;
if (dsn) {
  const isProd = config.environment === "production";
  const samplingRate = isProd ? 0.1 : 1.0;

  Sentry.init({
    dsn,
    environment: config.environment,
    serverName: "traycer-cli",
    sampleRate: 1.0,
    // The CLI must be able to END. Sentry's transport keeps no handle we can
    // reach and installs no request timeout, so a stalled DSN endpoint holds
    // the event loop open past `Sentry.close()`. This hands it a module that
    // tracks its requests; see sentry-transport.ts and runner/exit.ts.
    transportOptions: { httpModule: trackingHttpModule },
    tracesSampleRate: samplingRate,
    profilesSampleRate: samplingRate,
    attachStacktrace: true,
    // The client scrubber every other Traycer client runs. The CLI's frames
    // and the SDK's child-process breadcrumbs name absolute paths under the
    // person's home folder, and an error message carries whatever it quotes.
    beforeSend: (event) => {
      scrubSentryEventInPlace(event);
      return event;
    },
    // `beforeSend` never sees a transaction, and child spans travel outside
    // the transaction event.
    beforeSendTransaction: (event) => {
      scrubSentryTransactionInPlace(event);
      return event;
    },
    beforeSendSpan: (span) => {
      scrubSentrySpanInPlace(span);
      return span;
    },
    integrations: [
      Sentry.onUncaughtExceptionIntegration({
        exitEvenIfOtherHandlersAreRegistered: false,
      }),
      Sentry.onUnhandledRejectionIntegration({ mode: "strict" }),
    ],
  });
}
