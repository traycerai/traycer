import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActiveModelPicker,
  registerActiveModelPicker,
  resetActiveModelPickerForTests,
  toggleActiveModelPicker,
  type ActiveModelPickerController,
} from "@/lib/commands/active-model-picker-registry";

function controller(
  toggle: () => void,
  summary: string | null,
): ActiveModelPickerController {
  return { toggle, getSelectionSummary: () => summary };
}

describe("active-model-picker-registry", () => {
  beforeEach(() => resetActiveModelPickerForTests());
  afterEach(() => resetActiveModelPickerForTests());

  it("no-ops when no picker is registered", () => {
    expect(toggleActiveModelPicker()).toBe(false);
    expect(getActiveModelPicker()).toBeNull();
  });

  it("toggles the registered picker and reports the summary", () => {
    const toggle = vi.fn();
    registerActiveModelPicker(controller(toggle, "Claude Opus 4.8"));
    expect(toggleActiveModelPicker()).toBe(true);
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(getActiveModelPicker()?.getSelectionSummary()).toBe(
      "Claude Opus 4.8",
    );
  });

  it("targets the top of the stack and hands back on dispose", () => {
    const base = vi.fn();
    const overlay = vi.fn();
    registerActiveModelPicker(controller(base, "base"));
    const disposeOverlay = registerActiveModelPicker(
      controller(overlay, "overlay"),
    );

    // Overlay (top) wins while present.
    toggleActiveModelPicker();
    expect(overlay).toHaveBeenCalledTimes(1);
    expect(base).not.toHaveBeenCalled();
    expect(getActiveModelPicker()?.getSelectionSummary()).toBe("overlay");

    // Popping the overlay hands the target back to the base composer - not a
    // dead slot.
    disposeOverlay();
    expect(getActiveModelPicker()?.getSelectionSummary()).toBe("base");
    toggleActiveModelPicker();
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("dispose is idempotent and order-independent", () => {
    const a = vi.fn();
    const b = vi.fn();
    const disposeA = registerActiveModelPicker(controller(a, "a"));
    registerActiveModelPicker(controller(b, "b"));

    // Dispose the lower entry first; the top (b) stays active.
    disposeA();
    disposeA();
    expect(getActiveModelPicker()?.getSelectionSummary()).toBe("b");
    toggleActiveModelPicker();
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
  });
});
