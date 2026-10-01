import { fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserScreencastClientFrame } from "@traycer/protocol/host/browser/contracts";
import { createPlatformMock } from "@/__tests__/create-platform-mock";
import {
  armViaGesture,
  mountController,
} from "@/lib/browser-view/sessions/__tests__/screencast-controller-harness";

const platformMock = vi.hoisted(() => ({ mac: false }));
vi.mock("@/lib/keybindings/platform", () => createPlatformMock(platformMock));

type KeyboardFrame = Extract<
  BrowserScreencastClientFrame,
  { readonly kind: "keyboard" }
>;

function keyboardFrames(
  sent: readonly BrowserScreencastClientFrame[],
): KeyboardFrame[] {
  return sent.filter(
    (frame): frame is KeyboardFrame => frame.kind === "keyboard",
  );
}

/**
 * `readHostIsMac()` can resolve or change identity while a history-shortcut
 * key is physically held down. `forwardedKeyDowns` must pin the down's
 * platform for the whole press, or the down and its keyUp encode different
 * keys.
 */
describe("screencastHistoryKey stays pinned to the down's platform across a held press", () => {
  beforeEach(() => {
    platformMock.mac = false;
  });

  it("freezes a null->resolved host platform for the repeat and the keyUp of the same press", () => {
    let hostIsMac: boolean | null = null;
    const mounted = mountController({ readHostIsMac: () => hostIsMac });
    armViaGesture(mounted, 1);

    fireEvent.keyDown(mounted.imeInput, {
      code: "KeyY",
      key: "y",
      ctrlKey: true,
    });
    // Platform resolves while KeyY is still held.
    hostIsMac = true;
    fireEvent.keyDown(mounted.imeInput, {
      code: "KeyY",
      key: "y",
      ctrlKey: true,
      repeat: true,
    });
    fireEvent.keyUp(mounted.imeInput, {
      code: "KeyY",
      key: "y",
      ctrlKey: true,
    });

    // Started `null`, so every frame stays untranslated passthrough - never
    // the mac-translated "Z" a fresh `true` read would produce.
    expect(keyboardFrames(mounted.sent)).toMatchObject([
      {
        type: "rawKeyDown",
        code: "KeyY",
        key: "y",
        modifiers: 2,
        autoRepeat: false,
      },
      {
        type: "rawKeyDown",
        code: "KeyY",
        key: "y",
        modifiers: 2,
        autoRepeat: true,
      },
      {
        type: "keyUp",
        code: "KeyY",
        key: "y",
        modifiers: 2,
        autoRepeat: false,
      },
    ]);
  });

  it("picks up the resolved platform on the next press, once the held key has been released", () => {
    let hostIsMac: boolean | null = null;
    const mounted = mountController({ readHostIsMac: () => hostIsMac });
    armViaGesture(mounted, 1);

    fireEvent.keyDown(mounted.imeInput, {
      code: "KeyY",
      key: "y",
      ctrlKey: true,
    });
    hostIsMac = true;
    fireEvent.keyUp(mounted.imeInput, {
      code: "KeyY",
      key: "y",
      ctrlKey: true,
    });
    mounted.sent.length = 0;

    // A fresh press, map entry cleared: reads `readHostIsMac()` live and
    // translates - non-mac Ctrl+Y redo becomes mac's Cmd+Shift+Z.
    fireEvent.keyDown(mounted.imeInput, {
      code: "KeyY",
      key: "y",
      ctrlKey: true,
    });

    expect(keyboardFrames(mounted.sent)).toMatchObject([
      { type: "rawKeyDown", code: "KeyY", key: "Z", modifiers: 12 },
    ]);
  });

  it("freezes a known platform against a later, different known platform mid-press", () => {
    let hostIsMac: boolean | null = false;
    const mounted = mountController({ readHostIsMac: () => hostIsMac });
    armViaGesture(mounted, 1);

    fireEvent.keyDown(mounted.imeInput, {
      code: "KeyZ",
      key: "z",
      ctrlKey: true,
    });
    // Known platform swaps to a different known platform mid-press.
    hostIsMac = true;
    fireEvent.keyDown(mounted.imeInput, {
      code: "KeyZ",
      key: "z",
      ctrlKey: true,
      repeat: true,
    });
    fireEvent.keyUp(mounted.imeInput, {
      code: "KeyZ",
      key: "z",
      ctrlKey: true,
    });

    // Every frame keeps the down's `false` (non-mac Ctrl+Z), never `true`.
    expect(keyboardFrames(mounted.sent)).toMatchObject([
      {
        type: "rawKeyDown",
        code: "KeyZ",
        key: "z",
        modifiers: 2,
        autoRepeat: false,
      },
      {
        type: "rawKeyDown",
        code: "KeyZ",
        key: "z",
        modifiers: 2,
        autoRepeat: true,
      },
      {
        type: "keyUp",
        code: "KeyZ",
        key: "z",
        modifiers: 2,
        autoRepeat: false,
      },
    ]);
  });

  it("still reflects a modifier released before the key itself, unfrozen", () => {
    // No platform change here - isolates the other half of the fix: only
    // `hostIsMac` is pinned to the down, not the live `event.shiftKey`.
    const hostIsMac: boolean | null = true;
    const mounted = mountController({ readHostIsMac: () => hostIsMac });
    armViaGesture(mounted, 1);

    // Non-mac viewer holds Ctrl+Shift+Z (redo); the mac host translates it to
    // Cmd+Shift+Z.
    fireEvent.keyDown(mounted.imeInput, {
      code: "KeyZ",
      key: "z",
      ctrlKey: true,
      shiftKey: true,
    });
    // Shift releases first, then KeyZ releases with shiftKey already false.
    fireEvent.keyUp(mounted.imeInput, {
      code: "KeyZ",
      key: "z",
      ctrlKey: true,
      shiftKey: false,
    });

    expect(keyboardFrames(mounted.sent)).toMatchObject([
      // Down: shift still held -> redo spelling, Cmd+Shift.
      { type: "rawKeyDown", code: "KeyZ", key: "Z", modifiers: 12 },
      // Up: shift already released -> undo spelling, Cmd only. The platform
      // (Cmd, bit 4) is still the down's frozen `true`; only the character
      // and the shift bit tracked the live release.
      { type: "keyUp", code: "KeyZ", key: "z", modifiers: 4 },
    ]);
  });
});
