import { describe, expect, it } from "vitest";
import {
  browserScreencastClientFrameSchema,
  browserScreencastServerFrameSchema,
  browserScreencastV1,
} from "@traycer/protocol/host/browser/contracts";

const ARM = {
  hasBinaryPayload: false as const,
  armEpoch: 3,
  seq: 1,
};

function parsesClient(frame: unknown): boolean {
  return (
    browserScreencastClientFrameSchema.safeParse(frame).success &&
    browserScreencastV1.clientFrameSchema.safeParse(frame).success
  );
}

function parsesServer(frame: unknown): boolean {
  return (
    browserScreencastServerFrameSchema.safeParse(frame).success &&
    browserScreencastV1.serverFrameSchema.safeParse(frame).success
  );
}

describe("browser.screencast@1.0 natural-control frames", () => {
  it("accepts navigate / goBack / goForward / reload with armEpoch+seq", () => {
    expect(
      parsesClient({
        kind: "navigate",
        ...ARM,
        url: "https://example.com/",
      }),
    ).toBe(true);
    expect(parsesClient({ kind: "goBack", ...ARM })).toBe(true);
    expect(parsesClient({ kind: "goForward", ...ARM })).toBe(true);
    expect(parsesClient({ kind: "reload", ...ARM })).toBe(true);
  });

  it("rejects navigate urls longer than 2048 characters", () => {
    expect(
      parsesClient({
        kind: "navigate",
        ...ARM,
        url: "a".repeat(2048),
      }),
    ).toBe(true);
    expect(
      parsesClient({
        kind: "navigate",
        ...ARM,
        url: "a".repeat(2049),
      }),
    ).toBe(false);
  });

  it("parses navState and unsupportedInteraction snapshots", () => {
    expect(
      parsesServer({
        kind: "navState",
        hasBinaryPayload: false,
        url: "https://example.com/app",
        canGoBack: true,
        canGoForward: false,
        loading: false,
      }),
    ).toBe(true);
    expect(
      parsesServer({
        kind: "unsupportedInteraction",
        hasBinaryPayload: false,
        feature: "fileUpload",
      }),
    ).toBe(true);
    expect(
      parsesServer({
        kind: "unsupportedInteraction",
        hasBinaryPayload: false,
        feature: "download",
      }),
    ).toBe(true);
  });

  it("requires complete keyboard and pointer event state", () => {
    const keyboard = {
      kind: "keyboard" as const,
      hasBinaryPayload: false as const,
      armEpoch: 3,
      seq: 1,
      type: "rawKeyDown" as const,
      code: "KeyA",
      key: "a",
      modifiers: 0,
      autoRepeat: false,
    };
    const pointer = {
      kind: "pointer" as const,
      hasBinaryPayload: false as const,
      armEpoch: 3,
      seq: 0,
      type: "move" as const,
      castSequence: 7,
      normalizedX: 0.25,
      normalizedY: 0.75,
      button: "none" as const,
      buttons: 0,
      modifiers: 0,
      clickCount: 0,
      deltaX: 0,
      deltaY: 0,
    };

    expect(parsesClient(keyboard)).toBe(true);
    const { autoRepeat: _omittedAutoRepeat, ...keyboardWithoutAutoRepeat } =
      keyboard;
    expect(_omittedAutoRepeat).toBe(false);
    expect(parsesClient(keyboardWithoutAutoRepeat)).toBe(false);
    expect(parsesClient({ ...keyboard, modifiers: 16 })).toBe(false);

    expect(parsesClient(pointer)).toBe(true);
    expect(parsesClient({ ...pointer, clickCount: 8 })).toBe(true);
    expect(parsesClient({ ...pointer, clickCount: 9 })).toBe(false);
    const { clickCount: _omittedClickCount, ...pointerWithoutClickCount } =
      pointer;
    expect(_omittedClickCount).toBe(0);
    expect(parsesClient(pointerWithoutClickCount)).toBe(false);
    expect(parsesClient({ ...pointer, buttons: 32 })).toBe(false);
    expect(parsesClient({ ...pointer, modifiers: 16 })).toBe(false);
  });
});
