/**
 * Pins the NEW shared surface `@traycer/protocol/config/host-stop-intent`
 * adds for the host's SIGTERM-time reader: `hostStopIntentPath` (the
 * cross-repo on-disk filename contract) and `isStopIntentWithin` (the
 * window-parameterized freshness check both the supervisor and the host
 * bind to their own, deliberately different, bounds).
 *
 * `parseStopIntent`'s parse behaviour is already covered end to end through
 * the CLI's own `readStopIntent` in
 * `clients/traycer-cli/src/host/__tests__/stop-intent.test.ts` - not
 * duplicated here.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hostStopIntentPath,
  isStopIntentWithin,
  type StopIntent,
} from "../host-stop-intent";

describe("hostStopIntentPath", () => {
  it("joins the shared filename onto the given host home directory", () => {
    const dir = "/fake/host-home";
    const path = hostStopIntentPath(dir);

    // The literal tail is a cross-repo on-disk contract: the CLI writes this
    // exact filename before every kill and the host reads it back through
    // this same function at SIGTERM. A silent rename on either side would
    // desync the two without either failing to compile.
    expect(path.endsWith("stop-intent.json")).toBe(true);
    expect(path).toBe(join(dir, "stop-intent.json"));
  });

  it("resolves relative to whatever directory it is given, not a baked-in home", () => {
    expect(hostStopIntentPath("/one/slot")).toBe(
      join("/one/slot", "stop-intent.json"),
    );
    expect(hostStopIntentPath("/another/slot")).toBe(
      join("/another/slot", "stop-intent.json"),
    );
  });
});

describe("isStopIntentWithin", () => {
  const NOW_MS = Date.parse("2026-08-17T12:00:00.000Z");

  function recordAt(requestedAtMs: number): StopIntent {
    return {
      v: 1,
      requestedAt: new Date(requestedAtMs).toISOString(),
      requestedByPid: 4242,
      reason: "restart",
    };
  }

  it("is symmetric - the same offset is inside the window on both the past and future side", () => {
    const past = recordAt(NOW_MS - 10_000);
    const future = recordAt(NOW_MS + 10_000);

    expect(isStopIntentWithin(past, NOW_MS, 30_000)).toBe(true);
    expect(isStopIntentWithin(future, NOW_MS, 30_000)).toBe(true);
  });

  it("is window-parameterized - the SAME record reads inside a wide window and outside a narrow one", () => {
    // This is exactly the property the two production callers depend on:
    // the supervisor's STOP_INTENT_STALE_MS (300_000ms) has to outlive
    // stop -> kill -> settle, while the host's EXTERNAL_RESTART_INTENT_FRESH_MS
    // (30_000ms) only has to outlive the CLI writing the record and the
    // SIGTERM landing. One shared function, two independently-chosen bounds.
    const stamped = recordAt(NOW_MS - 60_000);

    expect(isStopIntentWithin(stamped, NOW_MS, 300_000)).toBe(true);
    expect(isStopIntentWithin(stamped, NOW_MS, 30_000)).toBe(false);
  });

  it("returns false for an unparseable requestedAt rather than throwing", () => {
    const malformed: StopIntent = {
      v: 1,
      requestedAt: "not-a-date",
      requestedByPid: 4242,
      reason: "restart",
    };

    expect(isStopIntentWithin(malformed, NOW_MS, 300_000)).toBe(false);
  });
});
