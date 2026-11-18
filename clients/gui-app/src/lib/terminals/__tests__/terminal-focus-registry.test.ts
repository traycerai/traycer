import { afterEach, describe, expect, it, vi } from "vitest";
import {
  focusTerminalInstance,
  registerTerminalFocus,
  resetTerminalFocusRegistryForTests,
  terminalFocusOwnsInstance,
} from "../terminal-focus-registry";

describe("terminal-focus-registry", () => {
  afterEach(() => {
    resetTerminalFocusRegistryForTests();
  });

  it("fulfils a request for a mounted instance synchronously", () => {
    const target = document.createElement("textarea");
    document.body.append(target);
    const focus = vi.fn(() => target.focus());
    registerTerminalFocus(
      "a",
      focus,
      (activeElement) => activeElement === target,
      () => true,
    );
    focusTerminalInstance("a");
    expect(focus).toHaveBeenCalledTimes(1);
    target.remove();
  });

  it("fulfils only the latest parked instance", () => {
    const focusA = vi.fn();
    focusTerminalInstance("a");
    focusTerminalInstance("b");
    registerTerminalFocus(
      "a",
      focusA,
      () => false,
      () => true,
    );
    expect(focusA).not.toHaveBeenCalled();

    const focusB = vi.fn();
    registerTerminalFocus(
      "b",
      focusB,
      () => false,
      () => true,
    );
    expect(focusB).toHaveBeenCalledTimes(1);
  });

  it("recognizes actual DOM focus ownership without a pending intent", () => {
    const target = document.createElement("textarea");
    document.body.append(target);
    registerTerminalFocus(
      "a",
      () => target.focus(),
      (activeElement) => activeElement === target,
      () => true,
    );
    target.focus();

    expect(terminalFocusOwnsInstance("a")).toBe(true);
    target.remove();
  });

  it("recognizes a parked semantic focus intent", () => {
    focusTerminalInstance("a");

    expect(terminalFocusOwnsInstance("a")).toBe(true);
    expect(terminalFocusOwnsInstance("b")).toBe(false);
  });
});
