import { describe, expect, it } from "vitest";
import type { SimulatorStreamConfig } from "@traycer/protocol/host/simulator/stream-contracts";
import {
  buildKeyFrame,
  buildTouchFrame,
  deviceMediaStyle,
  displayAspect,
  fitDeviceFrame,
  hardwareButtonsForPlatform,
  nextOrientation,
  normalizedSurfacePoint,
  screenRotationDegrees,
  shouldForwardKey,
} from "../simulator-input-encoding";

function config(
  overrides: Partial<SimulatorStreamConfig>,
): SimulatorStreamConfig {
  return {
    platform: "ios",
    codec: "avcc",
    width: 1179,
    height: 2556,
    orientation: "portrait",
    inputAvailable: true,
    ...overrides,
  };
}

describe("normalizedSurfacePoint", () => {
  const rect = { left: 100, top: 50, width: 200, height: 400 };

  it("maps a pointer to 0..1 of the surface it landed on", () => {
    expect(
      normalizedSurfacePoint({ clientX: 150, clientY: 250, rect }),
    ).toEqual({ x: 0.25, y: 0.5 });
  });

  it("clamps a drag that left the surface to its nearest edge", () => {
    expect(normalizedSurfacePoint({ clientX: 50, clientY: 900, rect })).toEqual(
      { x: 0, y: 1 },
    );
  });

  it("answers null for a surface with no area", () => {
    expect(
      normalizedSurfacePoint({
        clientX: 10,
        clientY: 10,
        rect: { ...rect, width: 0 },
      }),
    ).toBeNull();
  });
});

describe("key and touch frames", () => {
  it("encodes the DOM key event with its modifiers", () => {
    expect(
      buildKeyFrame(
        {
          key: "A",
          code: "KeyA",
          altKey: false,
          ctrlKey: false,
          metaKey: false,
          shiftKey: true,
        },
        "down",
      ),
    ).toEqual({
      kind: "key",
      hasBinaryPayload: false,
      phase: "down",
      code: "KeyA",
      key: "A",
      modifiers: { alt: false, ctrl: false, meta: false, shift: true },
    });
  });

  it("keeps code and key within the wire's 64-character cap", () => {
    const frame = buildKeyFrame(
      {
        key: "x".repeat(80),
        code: "y".repeat(80),
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
      },
      "up",
    );
    if (frame.kind !== "key") throw new Error("expected a key frame");
    expect(frame.key).toHaveLength(64);
    expect(frame.code).toHaveLength(64);
  });

  it("clamps touch coordinates into 0..1", () => {
    expect(buildTouchFrame("move", { x: 1.2, y: -0.1 })).toEqual({
      kind: "touch",
      hasBinaryPayload: false,
      phase: "move",
      x: 1,
      y: 0,
    });
  });

  it("keeps the viewer's platform-modifier chords for the app", () => {
    const cmdW = {
      key: "w",
      code: "KeyW",
      altKey: false,
      ctrlKey: false,
      metaKey: true,
      shiftKey: false,
    };
    expect(shouldForwardKey(cmdW, true)).toBe(false);
    // On Windows and Linux Cmd is just another key; Ctrl is the app's.
    expect(shouldForwardKey(cmdW, false)).toBe(true);
    expect(
      shouldForwardKey({ ...cmdW, metaKey: false, ctrlKey: true }, false),
    ).toBe(false);
  });
});

describe("orientation and buttons", () => {
  it("cycles the four orientations the way the device turns", () => {
    expect(nextOrientation("portrait")).toBe("landscape_left");
    expect(nextOrientation("landscape_left")).toBe("portrait_upside_down");
    expect(nextOrientation("portrait_upside_down")).toBe("landscape_right");
    expect(nextOrientation("landscape_right")).toBe("portrait");
  });

  it("offers each platform the buttons its device has", () => {
    expect(hardwareButtonsForPlatform("ios")).toEqual([
      "home",
      "appSwitcher",
      "power",
    ]);
    expect(hardwareButtonsForPlatform("android")).toEqual([
      "back",
      "home",
      "recents",
      "power",
    ]);
  });
});

describe("screenRotationDegrees", () => {
  it("turns an iOS portrait framebuffer for a device held sideways", () => {
    expect(
      screenRotationDegrees(
        "ios",
        config({ orientation: "landscape_left" }),
        null,
      ),
    ).toBe(90);
    expect(
      screenRotationDegrees(
        "ios",
        config({ orientation: "landscape_right" }),
        null,
      ),
    ).toBe(-90);
    expect(
      screenRotationDegrees(
        "ios",
        config({ orientation: "portrait_upside_down" }),
        null,
      ),
    ).toBe(180);
  });

  it("leaves a framebuffer that is already wider than tall alone", () => {
    expect(
      screenRotationDegrees("ios", config({ orientation: "landscape_left" }), {
        width: 2556,
        height: 1179,
      }),
    ).toBe(0);
  });

  it("never rotates Android, whose frames are upright", () => {
    expect(
      screenRotationDegrees(
        "android",
        config({ platform: "android", orientation: "landscape_left" }),
        null,
      ),
    ).toBe(0);
  });
});

describe("displayAspect and fitDeviceFrame", () => {
  it("is portrait for a portrait device and swaps for landscape", () => {
    expect(displayAspect("ios", config({}), null)).toBeCloseTo(1179 / 2556);
    expect(
      displayAspect("ios", config({ orientation: "landscape_left" }), null),
    ).toBeCloseTo(2556 / 1179);
  });

  it("uses a phone-shaped placeholder before any size is known", () => {
    expect(displayAspect("ios", null, null)).toBeCloseTo(9 / 19.5);
    expect(displayAspect("android", null, null)).toBeCloseTo(9 / 20);
  });

  it("fits the tallest frame the host allows, then the widest", () => {
    // A wide host: the height is the limit.
    expect(fitDeviceFrame(0.5, 1000, 800)).toEqual({ width: 400, height: 800 });
    // A narrow host: the width is the limit, and the phone gets shorter.
    expect(fitDeviceFrame(0.5, 200, 800)).toEqual({ width: 200, height: 400 });
    expect(fitDeviceFrame(0.5, 0, 800)).toEqual({ width: 0, height: 0 });
  });

  it("swaps and offsets a sideways frame so the rotated box lands on it", () => {
    expect(deviceMediaStyle({ width: 800, height: 400 }, 90)).toEqual({
      width: 400,
      height: 800,
      left: 200,
      top: -200,
      transform: "rotate(90deg)",
    });
    expect(deviceMediaStyle({ width: 400, height: 800 }, 0)).toEqual({
      width: 400,
      height: 800,
    });
  });
});
