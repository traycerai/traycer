import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientSentryEvent } from "@traycer-clients/shared/platform/sentry-scrub";

interface CapturedInitOptions {
  beforeSend?: (event: ClientSentryEvent) => ClientSentryEvent | null;
}

const captured: CapturedInitOptions[] = [];

vi.mock("@sentry/node", () => ({
  init: (options: CapturedInitOptions) => {
    captured.push(options);
  },
  onUncaughtExceptionIntegration: () => ({ name: "stub-uncaught" }),
  onUnhandledRejectionIntegration: () => ({ name: "stub-rejection" }),
}));

afterEach(() => {
  captured.length = 0;
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("CLI Sentry init", () => {
  it("scrubs home-folder names from the events it uploads", async () => {
    vi.stubEnv("TRAYCER_CLI_SENTRY_DSN", "https://public@sentry.invalid/1");
    await import("../sentry");

    const beforeSend = captured[0]?.beforeSend;
    expect(beforeSend).toBeTypeOf("function");

    const event: ClientSentryEvent = {
      breadcrumbs: [
        {
          message:
            "Worker thread errored with 'Cannot find module '/home/synthetic-user/.traycer/x.cjs''",
        },
      ],
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                {
                  filename: "/Users/synthetic-user/.traycer/cli/main.js",
                  abs_path: "/Users/synthetic-user/.traycer/cli/main.js",
                },
              ],
            },
          },
        ],
      },
    };
    const result = beforeSend?.(event);
    expect(result?.breadcrumbs?.[0]?.message).toBe(
      "Worker thread errored with 'Cannot find module '/home/<redacted>/.traycer/x.cjs''",
    );
    expect(result?.exception?.values?.[0]?.stacktrace?.frames).toEqual([
      {
        filename: "/Users/<redacted>/.traycer/cli/main.js",
        abs_path: "/Users/<redacted>/.traycer/cli/main.js",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("synthetic-user");
  });
});
