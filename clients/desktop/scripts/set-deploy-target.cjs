#!/usr/bin/env bun
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";


const path = require("node:path");
const {
  runConfigTargetCli,
} = require("../../scripts/rewrite-config-target.cjs");

const sentryDsn = process.env.TRAYCER_DESKTOP_SENTRY_DSN ?? "";
const sentryRendererDsn = process.env.TRAYCER_DESKTOP_SENTRY_RENDERER_DSN ?? "";

runConfigTargetCli({
  sourcePath: path.resolve(__dirname, "..", "src", "config.ts"),
  stringFields: {
    // Per-environment app identity (drives the userData dir + single-instance
    // lock, the OAuth scheme, and the Windows AppUserModelId). Source holds the
    // dev values; a production build stamps the shipped identity.
    appName: {
      dev: "Traycer Dev",
      production: "Traycer",
    },
    protocolScheme: {
      dev: "traycer-dev",
      production: "traycer",
    },
    appId: {
      dev: "ai.traycer.desktop",
      production: "ai.traycer.desktop",
    },
    sentryDsn: {
      dev: "",
      production: sentryDsn,
    },
    sentryRendererDsn: {
      dev: "",
      production: sentryRendererDsn,
    },
  },
});
