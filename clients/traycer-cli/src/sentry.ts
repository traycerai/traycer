import * as Sentry from "@sentry/node";
import { config } from "./config";

const dsn = process.env.TRAYCER_CLI_SENTRY_DSN;
if (dsn) {
  const isProd = config.environment === "production";
  const samplingRate = isProd ? 0.1 : 1.0;

  Sentry.init({
    dsn,
    environment: config.environment,
    serverName: "traycer-cli",
    sampleRate: 1.0,
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
