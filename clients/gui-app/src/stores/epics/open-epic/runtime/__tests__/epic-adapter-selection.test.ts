import { describe, expect, it } from "vitest";
import { EPIC_LANE_METHODS } from "@traycer-clients/shared/epic-lanes";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import {
  armCarriesRootWrites,
  epicAdapterFingerprint,
  readEpicAdapterVerdict,
  settleEpicAdapterArm,
  type EpicMethodSupportReader,
} from "../epic-adapter-selection";

/** A support reader over an explicit per-method map; anything absent is unknown. */
function supportOf(
  entries: Readonly<Record<string, StreamMethodSupport>>,
): EpicMethodSupportReader {
  return (method) => entries[method] ?? "unknown";
}

const ALL_SUPPORTED = supportOf({
  "epic.state.subscribe": "supported",
  "epic.status.subscribe": "supported",
  "artifact.subscribe": "supported",
});

const ALL_UNSUPPORTED = supportOf({
  "epic.state.subscribe": "unsupported",
  "epic.status.subscribe": "unsupported",
  "artifact.subscribe": "unsupported",
});

/** A remote mux transport: `getMethodSupport` is a hardcoded `"unknown"`. */
const MUX = supportOf({});

describe("epic adapter verdict", () => {
  it("selects lanes only when ALL THREE methods are known-supported", () => {
    expect(readEpicAdapterVerdict(ALL_SUPPORTED)).toBe("lanes");
  });

  it("refuses to select lanes on any SUBSET, one method at a time", () => {
    // The failure this whole predicate exists to prevent.
    for (const missing of EPIC_LANE_METHODS) {
      const entries: Record<string, StreamMethodSupport> = {};
      for (const method of EPIC_LANE_METHODS) {
        entries[method] = method === missing ? "unsupported" : "supported";
      }
      expect(readEpicAdapterVerdict(supportOf(entries))).toBe("legacy");
    }
  });

  it("answers UNDECIDED on unknown - not legacy", () => {
    // The distinction the whole Q4 policy rests on: "we have not been told" is not "we have been told
    // no".
    expect(readEpicAdapterVerdict(MUX)).toBe("undecided");
    expect(
      readEpicAdapterVerdict(
        supportOf({
          "epic.state.subscribe": "supported",
          "epic.status.subscribe": "supported",
          // The third has not resolved yet.
        }),
      ),
    ).toBe("undecided");
  });

  it("answers LEGACY on an explicit refusal even when the others are unknown", () => {
    // One method saying "no" is a host telling us it is an old host. That is a
    // decision, unlike silence.
    expect(
      readEpicAdapterVerdict(
        supportOf({ "epic.state.subscribe": "unsupported" }),
      ),
    ).toBe("legacy");
    expect(readEpicAdapterVerdict(ALL_UNSUPPORTED)).toBe("legacy");
  });
});

describe("settling an arm against what is installed", () => {
  it("holds the installed arm through unknown, so a reconnect cannot flap", () => {
    // `WsStreamClient.resetMethodSupport` CLEARS the whole support map on every reconnect and
    // re-probes, so a healthy reconnect on a lane host passes through a window where every lane method
    expect(settleEpicAdapterArm("lanes", "undecided")).toBe("lanes");
    expect(settleEpicAdapterArm("legacy", "undecided")).toBe("legacy");
  });

  it("installs nothing while undecided with nothing installed", () => {
    // The cold-open case: no arm may be installed, and in particular
    // `epic.subscribe@1` is never opened speculatively as a probe.
    expect(settleEpicAdapterArm(null, "undecided")).toBeNull();
  });

  it("lets a decided verdict move an installed arm in either direction", () => {
    expect(settleEpicAdapterArm("legacy", "lanes")).toBe("lanes");
    expect(settleEpicAdapterArm("lanes", "legacy")).toBe("legacy");
    expect(settleEpicAdapterArm(null, "lanes")).toBe("lanes");
    expect(settleEpicAdapterArm(null, "legacy")).toBe("legacy");
  });
});

describe("fingerprint", () => {
  it("is EQUAL across the unknown -> unsupported walk every legacy host makes", () => {
    // Both manifests select legacy, so both must fingerprint the same. If this ever diverges, every
    // legacy host replaces its replica once per session for a transition that changed nothing.
    const first = readEpicAdapterVerdict(MUX);
    const second = readEpicAdapterVerdict(ALL_UNSUPPORTED);
    const firstArm = settleEpicAdapterArm(null, first);
    const secondArm = settleEpicAdapterArm("legacy", second);
    expect(firstArm).toBeNull();
    expect(secondArm).toBe("legacy");
    // Once an arm IS installed, the walk cannot change the fingerprint.
    expect(epicAdapterFingerprint("legacy")).toBe(
      epicAdapterFingerprint(settleEpicAdapterArm("legacy", first) ?? "lanes"),
    );
  });

  it("DIFFERS between the two arms, so a genuine upgrade is a replacement", () => {
    expect(epicAdapterFingerprint("lanes")).not.toBe(
      epicAdapterFingerprint("legacy"),
    );
  });

  it("names what it is a fingerprint OF", () => {
    // A bare `"legacy"` escaping into a log or a replay capture says nothing
    // about which selection it belongs to.
    expect(epicAdapterFingerprint("lanes")).toBe("epic-adapters:lanes");
    expect(epicAdapterFingerprint("legacy")).toBe("epic-adapters:legacy");
  });
});

describe("armCarriesRootWrites", () => {
  it("is true for `@1` alone, and false for the unknown arm", () => {
    // `@1` is the only arm whose root document is a write path.
    expect(armCarriesRootWrites("legacy")).toBe(true);
    expect(armCarriesRootWrites("lanes")).toBe(false);
    // The conservative direction, and the one that matters most: callers use this to decide whether
    // they may retire the ONLY copy of somebody's unsynced edits, so "no arm selected yet" must not
    expect(armCarriesRootWrites(null)).toBe(false);
  });
});
