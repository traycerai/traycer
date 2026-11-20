/**
 * Exercises the CLI's real crash capture functions through a real Sentry
 * client and its egress scrubber; the transport records envelopes locally.
 */
import * as Sentry from "@sentry/node";
import { NodeClient, defaultStackParser } from "@sentry/node";
import { scrubSentryEventInPlace } from "@traycer-clients/shared/platform/sentry-scrub";
import { describe, expect, it } from "vitest";
import {
  captureHostCrashEvent,
  captureHostCrashSummary,
  type HostCrashEvent,
} from "../host/crash-telemetry";

const HOME_PATH = "/home/synthetic-user/.traycer/cli/install/host-main.cjs";
const CREDENTIAL_URL =
  "https://service.invalid/fetch?token=synthetic-credential";

function fieldOf(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? Reflect.get(value, key)
    : undefined;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function eventPayloads(envelopes: unknown[]): unknown[] {
  const items = envelopes.flatMap((envelope) => arrayOf(arrayOf(envelope)[1]));
  return items
    .map((item) => arrayOf(item)[1])
    .filter((payload) => fieldOf(payload, "message") !== undefined);
}

function crashEvent(message: string, fingerprint: string[]): HostCrashEvent {
  return {
    message,
    level: "error",
    fingerprint,
    hostId: null,
    tags: {},
    extra: {},
  };
}

describe("CLI host crash fingerprints through Sentry", () => {
  it("scrubs private fingerprint entries and preserves repeat grouping", async () => {
    const envelopes: unknown[] = [];
    const client = new NodeClient({
      dsn: "https://public@sentry.invalid/1",
      stackParser: defaultStackParser,
      integrations: [],
      transport: () => ({
        send: async (envelope) => {
          envelopes.push(envelope);
          return { statusCode: 200 };
        },
        flush: async () => true,
      }),
      beforeSend: (event) => {
        scrubSentryEventInPlace(event);
        return event;
      },
    });

    try {
      Sentry.withIsolationScope(() => {
        Sentry.setCurrentClient(client);
        client.init();

        const privateEvent = crashEvent("synthetic crash", [
          "host-crash",
          HOME_PATH,
          CREDENTIAL_URL,
          "{{ default }}",
        ]);
        captureHostCrashEvent(privateEvent);
        captureHostCrashSummary(privateEvent, 2, 1_800_000_000_000);
        captureHostCrashSummary(privateEvent, 3, 1_800_000_000_000);

        captureHostCrashEvent(
          crashEvent("ordinary crash A", ["host-crash", "EACCES"]),
        );
        captureHostCrashEvent(
          crashEvent("ordinary crash B", ["host-crash", "ENOENT"]),
        );
      });

      expect(await client.flush(2_000)).toBe(true);
    } finally {
      await client.close(2_000);
    }

    const payloads = eventPayloads(envelopes);
    expect(payloads).toHaveLength(5);

    const privateCapture = payloads.find(
      (payload) => fieldOf(payload, "message") === "synthetic crash",
    );
    const firstSummary = payloads.find(
      (payload) =>
        fieldOf(payload, "message") === "synthetic crash (repeated)" &&
        fieldOf(fieldOf(payload, "extra"), "suppressedCount") === 2,
    );
    const secondSummary = payloads.find(
      (payload) =>
        fieldOf(payload, "message") === "synthetic crash (repeated)" &&
        fieldOf(fieldOf(payload, "extra"), "suppressedCount") === 3,
    );
    const ordinaryCaptureA = payloads.find(
      (payload) => fieldOf(payload, "message") === "ordinary crash A",
    );
    const ordinaryCaptureB = payloads.find(
      (payload) => fieldOf(payload, "message") === "ordinary crash B",
    );

    const scrubbedPrivateFingerprint = [
      "host-crash",
      "/home/<redacted>/.traycer/cli/install/host-main.cjs",
      "https://service.invalid/fetch?token=<redacted>",
      "{{ default }}",
    ];
    expect(fieldOf(privateCapture, "fingerprint")).toEqual(
      scrubbedPrivateFingerprint,
    );
    expect(fieldOf(firstSummary, "fingerprint")).toEqual([
      ...scrubbedPrivateFingerprint,
      "repeated",
    ]);
    expect(fieldOf(secondSummary, "fingerprint")).toEqual(
      fieldOf(firstSummary, "fingerprint"),
    );
    expect(fieldOf(ordinaryCaptureA, "fingerprint")).toEqual([
      "host-crash",
      "EACCES",
    ]);
    expect(fieldOf(ordinaryCaptureB, "fingerprint")).toEqual([
      "host-crash",
      "ENOENT",
    ]);
    expect(fieldOf(ordinaryCaptureA, "fingerprint")).not.toEqual(
      fieldOf(ordinaryCaptureB, "fingerprint"),
    );

    const serialized = JSON.stringify(payloads);
    expect(serialized).not.toContain("synthetic-user");
    expect(serialized).not.toContain("synthetic-credential");
  });
});
