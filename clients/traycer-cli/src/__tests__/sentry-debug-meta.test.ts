/**
 * Through the real Sentry SDK and the shared `beforeSend`: the debug_meta
 * image the SDK builds from the original frame path must not keep the OS
 * home-folder name.
 */
import { scrubSentryEventInPlace } from "@traycer-clients/shared/platform/sentry-scrub";
import { NodeClient, defaultStackParser } from "@sentry/node";
import { afterEach, describe, expect, it } from "vitest";

/** Reads `value[key]` without ever casting an `unknown`. */
function fieldOf(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? Reflect.get(value, key)
    : undefined;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const STACK =
  "Error\n    at synthetic (/Users/synthetic-user/.traycer/cli/main.js:1:1)";
const DEBUG_ID = "11111111-1111-4111-8111-111111111111";
const REDACTED = "/Users/<redacted>/.traycer/cli/main.js";

/**
 * A real client running the CLI's `beforeSend`, whose envelopes land in
 * `sent` instead of a transport: nothing leaves the process.
 */
function captureClient(sent: unknown[]): NodeClient {
  return new NodeClient({
    dsn: "https://public@sentry.invalid/1",
    stackParser: defaultStackParser,
    integrations: [],
    transport: () => ({
      send: async (envelope) => {
        sent.push(envelope);
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
    beforeSend: (event) => {
      scrubSentryEventInPlace(event);
      return event;
    },
  });
}

describe("home-folder names in a real Sentry debug_meta", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "_sentryDebugIds");
  });

  it("redacts a Windows home name that begins with a space, in the value and the frame", async () => {
    const sent: unknown[] = [];
    const client = captureClient(sent);
    try {
      const path = "C:\\Users\\ Synthetic\\.traycer\\cli\\main.js";
      const error = new Error(`Cannot find module ${path}`);
      error.stack = `Error\n    at synthetic (${path}:1:1)`;
      client.captureException(error);
      await client.flush(2000);

      expect(sent.length).toBeGreaterThan(0);
      expect(JSON.stringify(sent)).not.toContain(" Synthetic");
    } finally {
      await client.close();
    }
  });

  it("redacts the sourcemap image code_file and keeps its debug_id", async () => {
    const sent: unknown[] = [];
    Reflect.set(globalThis, "_sentryDebugIds", { [STACK]: DEBUG_ID });
    const client = captureClient(sent);
    try {
      const error = new Error("synthetic");
      error.stack = STACK;
      client.captureException(error);
      await client.flush(2000);

      const items = sent.flatMap((envelope) => arrayOf(arrayOf(envelope)[1]));
      const payload = items
        .map((item) => arrayOf(item)[1])
        .find((p) => fieldOf(p, "exception") !== undefined);
      const values = arrayOf(fieldOf(fieldOf(payload, "exception"), "values"));
      const frames = arrayOf(
        fieldOf(fieldOf(values[0], "stacktrace"), "frames"),
      );
      const images = arrayOf(fieldOf(fieldOf(payload, "debug_meta"), "images"));
      expect(fieldOf(frames[frames.length - 1], "filename")).toBe(REDACTED);
      expect(fieldOf(images[0], "type")).toBe("sourcemap");
      expect(fieldOf(images[0], "code_file")).toBe(REDACTED);
      expect(fieldOf(images[0], "debug_id")).toBe(DEBUG_ID);
      expect(JSON.stringify(sent)).not.toContain("synthetic-user");
    } finally {
      await client.close();
    }
  });
});
