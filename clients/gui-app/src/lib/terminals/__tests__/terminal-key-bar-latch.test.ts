import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyTerminalKeyBarLatchToTypedInput,
  consumeTerminalKeyBarModifiers,
  getTerminalKeyBarModifiers,
  resetTerminalKeyBarLatchForTests,
  subscribeTerminalKeyBarModifiers,
  toggleTerminalKeyBarModifier,
} from "@/lib/terminals/terminal-key-bar-latch";

beforeEach(() => {
  resetTerminalKeyBarLatchForTests();
});

describe("terminal key bar latch", () => {
  it("toggles on and off and notifies subscribers", () => {
    const listener = vi.fn();
    subscribeTerminalKeyBarModifiers(listener);
    toggleTerminalKeyBarModifier("ctrl");
    expect(getTerminalKeyBarModifiers().ctrl).toBe(true);
    toggleTerminalKeyBarModifier("ctrl");
    expect(getTerminalKeyBarModifiers().ctrl).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("consume returns the latch once and clears it", () => {
    toggleTerminalKeyBarModifier("ctrl");
    toggleTerminalKeyBarModifier("shift");
    expect(consumeTerminalKeyBarModifiers()).toEqual({
      ctrl: true,
      alt: false,
      shift: true,
    });
    expect(consumeTerminalKeyBarModifiers()).toEqual({
      ctrl: false,
      alt: false,
      shift: false,
    });
  });

  it("passes typed input through untouched when nothing is latched", () => {
    expect(applyTerminalKeyBarLatchToTypedInput("hello")).toBe("hello");
    expect(applyTerminalKeyBarLatchToTypedInput("\x1b[A")).toBe("\x1b[A");
  });

  it("transforms the next single typed character and clears the latch", () => {
    toggleTerminalKeyBarModifier("ctrl");
    expect(applyTerminalKeyBarLatchToTypedInput("c")).toBe("\x03");
    expect(getTerminalKeyBarModifiers().ctrl).toBe(false);
    expect(applyTerminalKeyBarLatchToTypedInput("c")).toBe("c");
  });

  it("keeps the latch armed across multi-character chunks", () => {
    toggleTerminalKeyBarModifier("ctrl");
    // Engine-synthesized reports (focus-in) and pastes are not keystrokes.
    expect(applyTerminalKeyBarLatchToTypedInput("\x1b[I")).toBe("\x1b[I");
    expect(applyTerminalKeyBarLatchToTypedInput("pasted text")).toBe(
      "pasted text",
    );
    expect(getTerminalKeyBarModifiers().ctrl).toBe(true);
    expect(applyTerminalKeyBarLatchToTypedInput("c")).toBe("\x03");
    expect(getTerminalKeyBarModifiers().ctrl).toBe(false);
  });

  it("passes through characters with no control mapping", () => {
    toggleTerminalKeyBarModifier("ctrl");
    expect(applyTerminalKeyBarLatchToTypedInput("1")).toBe("1");
    expect(getTerminalKeyBarModifiers().ctrl).toBe(false);
  });
});
