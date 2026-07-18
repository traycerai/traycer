import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  focusTerminalInstance,
  registerTerminalFocus,
  resetTerminalFocusRegistryForTests,
} from "../terminal-focus-registry";

describe("terminal-focus-registry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    resetTerminalFocusRegistryForTests();
    vi.useRealTimers();
  });

  it("fulfils a request for a mounted instance only after a macrotask, not synchronously", () => {
    const focus = vi.fn();
    registerTerminalFocus("a", focus);
    focusTerminalInstance("a");
    expect(focus).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("cancels a still-scheduled fulfilment when a newer, not-yet-mounted instance is requested", () => {
    const focusA = vi.fn();
    registerTerminalFocus("a", focusA);
    focusTerminalInstance("a");

    // "b" has not mounted yet - this park must not let "a"'s already-scheduled
    // timer fire later and steal focus back from the newer request.
    focusTerminalInstance("b");
    vi.runAllTimers();
    expect(focusA).not.toHaveBeenCalled();

    const focusB = vi.fn();
    registerTerminalFocus("b", focusB);
    vi.runAllTimers();
    expect(focusB).toHaveBeenCalledTimes(1);
  });
});
