import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MobileTerminalKeyBar } from "@/components/epic-canvas/mobile/mobile-terminal-key-bar";
import {
  getTerminalKeyBarModifiers,
  resetTerminalKeyBarLatchForTests,
} from "@/lib/terminals/terminal-key-bar-latch";
import {
  registerTerminalKeyInput,
  resetTerminalKeyInputRegistryForTests,
} from "@/lib/terminals/terminal-key-input-registry";
import type { TerminalCursorKeyMode } from "@/lib/terminals/terminal-key-sequences";

const INSTANCE_ID = "tile-instance-1";

function setupTarget(cursorKeyMode: TerminalCursorKeyMode) {
  const input = vi.fn();
  registerTerminalKeyInput(INSTANCE_ID, {
    input,
    getCursorKeyMode: () => cursorKeyMode,
  });
  return input;
}

beforeEach(() => {
  resetTerminalKeyBarLatchForTests();
  resetTerminalKeyInputRegistryForTests();
});

afterEach(() => {
  cleanup();
});

describe("MobileTerminalKeyBar", () => {
  it("sends the key's sequence on pointer down", () => {
    const input = setupTarget("normal");
    render(
      <MobileTerminalKeyBar instanceId={INSTANCE_ID} keyboardOpen={false} />,
    );
    fireEvent.pointerDown(screen.getByTestId("terminal-key-esc"));
    expect(input).toHaveBeenCalledExactlyOnceWith("\x1b");
  });

  it("encodes arrows for the target's cursor-key mode", () => {
    const input = setupTarget("application");
    render(
      <MobileTerminalKeyBar instanceId={INSTANCE_ID} keyboardOpen={false} />,
    );
    fireEvent.pointerDown(screen.getByTestId("terminal-key-arrow-up"));
    expect(input).toHaveBeenCalledExactlyOnceWith("\x1bOA");
  });

  it("applies a latched Ctrl to the next bar key, one-shot", () => {
    const input = setupTarget("application");
    render(
      <MobileTerminalKeyBar instanceId={INSTANCE_ID} keyboardOpen={false} />,
    );
    const ctrl = screen.getByTestId("terminal-key-ctrl");
    fireEvent.pointerDown(ctrl);
    expect(ctrl.getAttribute("aria-pressed")).toBe("true");
    fireEvent.pointerDown(screen.getByTestId("terminal-key-arrow-up"));
    expect(input).toHaveBeenCalledExactlyOnceWith("\x1b[1;5A");
    expect(ctrl.getAttribute("aria-pressed")).toBe("false");
    fireEvent.pointerDown(screen.getByTestId("terminal-key-arrow-up"));
    expect(input).toHaveBeenLastCalledWith("\x1bOA");
  });

  it("sends Shift+Tab as back-tab", () => {
    const input = setupTarget("normal");
    render(
      <MobileTerminalKeyBar instanceId={INSTANCE_ID} keyboardOpen={false} />,
    );
    fireEvent.pointerDown(screen.getByTestId("terminal-key-shift"));
    fireEvent.pointerDown(screen.getByTestId("terminal-key-tab"));
    expect(input).toHaveBeenCalledExactlyOnceWith("\x1b[Z");
  });

  it("latches modifiers on keyboard activation too (click with detail 0)", () => {
    setupTarget("normal");
    render(
      <MobileTerminalKeyBar instanceId={INSTANCE_ID} keyboardOpen={false} />,
    );
    const ctrl = screen.getByTestId("terminal-key-ctrl");
    fireEvent.click(ctrl, { detail: 0 });
    expect(ctrl.getAttribute("aria-pressed")).toBe("true");
    // The click that follows a pointer tap must not toggle a second time.
    fireEvent.pointerDown(ctrl);
    fireEvent.click(ctrl, { detail: 1 });
    expect(ctrl.getAttribute("aria-pressed")).toBe("false");
  });

  it("clears a still-armed latch when the bar unmounts", () => {
    setupTarget("normal");
    const view = render(
      <MobileTerminalKeyBar instanceId={INSTANCE_ID} keyboardOpen={false} />,
    );
    fireEvent.pointerDown(screen.getByTestId("terminal-key-ctrl"));
    view.unmount();
    expect(getTerminalKeyBarModifiers()).toEqual({
      ctrl: false,
      alt: false,
      shift: false,
    });
  });

  it("does not double-send for the click that follows a pointer tap", () => {
    const input = setupTarget("normal");
    render(
      <MobileTerminalKeyBar instanceId={INSTANCE_ID} keyboardOpen={false} />,
    );
    const esc = screen.getByTestId("terminal-key-esc");
    fireEvent.pointerDown(esc);
    fireEvent.pointerUp(esc);
    fireEvent.click(esc, { detail: 1 });
    expect(input).toHaveBeenCalledTimes(1);
  });

  it("still sends on keyboard activation (click with detail 0)", () => {
    const input = setupTarget("normal");
    render(
      <MobileTerminalKeyBar instanceId={INSTANCE_ID} keyboardOpen={false} />,
    );
    fireEvent.click(screen.getByTestId("terminal-key-enter"), { detail: 0 });
    expect(input).toHaveBeenCalledExactlyOnceWith("\r");
  });

  it("no-ops when no engine is registered for the instance", () => {
    resetTerminalKeyInputRegistryForTests();
    render(
      <MobileTerminalKeyBar instanceId={INSTANCE_ID} keyboardOpen={false} />,
    );
    expect(() =>
      fireEvent.pointerDown(screen.getByTestId("terminal-key-esc")),
    ).not.toThrow();
  });

  it("cancels touchstart so iOS keeps the terminal focused (keyboard stays up)", () => {
    setupTarget("normal");
    render(
      <MobileTerminalKeyBar instanceId={INSTANCE_ID} keyboardOpen={false} />,
    );
    const touch = new Event("touchstart", { bubbles: true, cancelable: true });
    screen.getByTestId("terminal-key-esc").dispatchEvent(touch);
    expect(touch.defaultPrevented).toBe(true);
  });

  it("auto-repeats a held arrow key", () => {
    vi.useFakeTimers();
    try {
      const input = setupTarget("normal");
      render(
        <MobileTerminalKeyBar instanceId={INSTANCE_ID} keyboardOpen={false} />,
      );
      const down = screen.getByTestId("terminal-key-arrow-down");
      fireEvent.pointerDown(down);
      expect(input).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(350 + 60 * 3);
      expect(input.mock.calls.length).toBeGreaterThanOrEqual(3);
      fireEvent.pointerUp(down);
      const sentBeforeRelease = input.mock.calls.length;
      vi.advanceTimersByTime(600);
      expect(input).toHaveBeenCalledTimes(sentBeforeRelease);
    } finally {
      vi.useRealTimers();
    }
  });
});
