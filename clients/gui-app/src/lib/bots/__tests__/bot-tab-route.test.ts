/**
 * `botTabRouteOf`: the order in which the bot tab's inputs decide its view.
 * The rows a surface test already reaches through the real hooks (a setup, a
 * failed list over old data, a stale list) are driven in
 * `bot-tab-surface.test.tsx`; these pin the cold-read precedence directly.
 */
import { describe, expect, it } from "vitest";
import { botTabRouteOf } from "@/lib/bots/bot-tab-route";

type RouteInput = Parameters<typeof botTabRouteOf>[0];

/** A tab on an unlisted bot with settled setups and a fresh list. */
const SETTLED: RouteInput = {
  listsPending: false,
  seenListed: false,
  listsAnswered: true,
  listsFailed: false,
  setup: null,
  listStale: false,
  setupsSettled: true,
  setupsUnresolved: false,
};

describe("botTabRouteOf", () => {
  it.each<readonly [string, Partial<RouteInput>]>([
    // The route takes one `listsAnswered` and one `listsFailed` for both
    // lists; a cold failure leaves the lists unanswered, failed or not.
    ["a list's first read failed", { listsAnswered: false, listsFailed: true }],
    ["a list has no answer", { listsAnswered: false }],
  ])(
    "is unresolved when %s, though the setups are known and the list is fresh",
    (_name, override) => {
      expect(botTabRouteOf({ ...SETTLED, ...override })).toEqual({
        kind: "unresolved",
      });
    },
  );

  it("is the bot when the tab has seen it listed, whatever the lists answered", () => {
    expect(
      botTabRouteOf({ ...SETTLED, seenListed: true, listsAnswered: false }),
    ).toEqual({ kind: "bot" });
  });

  it("is connecting while a list is pending, before anything else decides", () => {
    expect(
      botTabRouteOf({
        ...SETTLED,
        listsPending: true,
        seenListed: true,
        listsAnswered: false,
      }),
    ).toEqual({ kind: "connecting" });
  });
});
