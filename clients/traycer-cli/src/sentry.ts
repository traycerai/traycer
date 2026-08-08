import * as Sentry from "@sentry/node";
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
    integrations: [
      Sentry.onUncaughtExceptionIntegration({
        exitEvenIfOtherHandlersAreRegistered: false,
      }),
      Sentry.onUnhandledRejectionIntegration({ mode: "strict" }),
    ],
  });
}
