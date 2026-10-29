import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import {
  simulatorSessionsV10,
  simulatorSessionsV11,
  simulatorStreamV10,
} from "@traycer/protocol/host/simulator/stream-contracts";
import { releasedStreamMethodNames } from "./__fixtures__/released-stream-method-names";

/**
 * The two simulator streams: new names outside the frozen `browser.*`
 * namespace, not yet in the released baseline (which the subset rule
 * allows). `simulator.sessions` is at `@1.1`, `simulator.stream` at `@1.0`.
 */
describe("simulator stream contracts", () => {
  it("registers sessions at @1.1 and stream at @1.0 outside the browser namespace", () => {
    expect(hostStreamRpcRegistry["simulator.sessions"][1].latestMinor).toBe(1);
    expect(
      hostStreamRpcRegistry["simulator.sessions"][1].versions[0].contract,
    ).toBe(simulatorSessionsV10);
    expect(
      hostStreamRpcRegistry["simulator.sessions"][1].versions[1].contract,
    ).toBe(simulatorSessionsV11);
    expect(hostStreamRpcRegistry["simulator.stream"][1].latestMinor).toBe(0);
    expect(
      hostStreamRpcRegistry["simulator.stream"][1].versions[0].contract,
    ).toBe(simulatorStreamV10);
    expect(releasedStreamMethodNames).not.toContain("simulator.sessions");
    expect(releasedStreamMethodNames).not.toContain("simulator.stream");
  });

  it("marks only the video frame binary", () => {
    const schema = simulatorStreamV10.serverFrameSchema;
    expect(
      schema.safeParse({ kind: "video", hasBinaryPayload: true, unit: "delta" })
        .success,
    ).toBe(true);
    expect(
      schema.safeParse({
        kind: "video",
        hasBinaryPayload: false,
        unit: "delta",
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        kind: "inputState",
        hasBinaryPayload: true,
        connected: true,
        detail: null,
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        kind: "streamConfig",
        hasBinaryPayload: false,
        config: {
          platform: "android",
          codec: "semu",
          width: null,
          height: null,
          orientation: "portrait",
          inputAvailable: true,
          frameIntervalMs: null,
        },
      }).success,
    ).toBe(true);
  });

  it("bounds a touch to the unit square and keeps the client frames strict", () => {
    const schema = simulatorStreamV10.clientFrameSchema;
    expect(
      schema.safeParse({
        kind: "touch",
        hasBinaryPayload: false,
        phase: "begin",
        x: 0.25,
        y: 1,
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        kind: "touch",
        hasBinaryPayload: false,
        phase: "begin",
        x: 1.5,
        y: 0,
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        kind: "touch",
        hasBinaryPayload: false,
        phase: "begin",
        x: 0,
        y: 0,
        pointerId: 1,
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        kind: "button",
        hasBinaryPayload: false,
        button: "siri",
      }).success,
    ).toBe(false);
  });

  it("carries a sessions patch with only the fields that moved", () => {
    const schema = simulatorSessionsV10.serverFrameSchema;
    const parsed = schema.parse({
      kind: "stateChanged",
      hasBinaryPayload: false,
      revision: 4,
      patch: { booting: ["ABCDEF-0000"] },
    });
    expect(parsed).toEqual({
      kind: "stateChanged",
      hasBinaryPayload: false,
      revision: 4,
      patch: { booting: ["ABCDEF-0000"] },
    });
    expect(
      schema.safeParse({
        kind: "stateChanged",
        hasBinaryPayload: false,
        revision: 4,
        patch: { hostId: "host-1" },
      }).success,
    ).toBe(true);
    // An unknown patch key is dropped by the non-strict patch object, but
    // the frame itself stays strict: no extra top-level keys.
    expect(
      schema.safeParse({
        kind: "stateChanged",
        hasBinaryPayload: false,
        revision: 4,
        patch: {},
        extra: true,
      }).success,
    ).toBe(false);
  });

  it("keeps patch.opening on the @1.1 frame and strips it from @1.0", () => {
    const frame = {
      kind: "stateChanged",
      hasBinaryPayload: false,
      revision: 5,
      patch: { opening: [{ requestId: "r1" }] },
    };
    expect(simulatorSessionsV11.serverFrameSchema.parse(frame)).toEqual(frame);
    expect(simulatorSessionsV10.serverFrameSchema.parse(frame)).toEqual({
      ...frame,
      patch: {},
    });
  });
});
