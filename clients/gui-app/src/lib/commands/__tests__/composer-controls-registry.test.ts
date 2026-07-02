import "../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import {
  getFocusedComposerControls,
  registerFocusedComposerControls,
  resetFocusedComposerControlsForTests,
  subscribeFocusedComposerControls,
} from "@/lib/commands/composer-controls-registry";

function noopControls() {
  return {
    setSelection: () => undefined,
    setReasoning: () => undefined,
    setServiceTier: () => undefined,
    setPermission: () => undefined,
    switchHarness: () => undefined,
    selectModel: () => undefined,
  };
}

describe("focused composer controls registry", () => {
  afterEach(() => {
    resetFocusedComposerControlsForTests();
  });

  it("starts empty", () => {
    expect(getFocusedComposerControls()).toBeNull();
  });

  it("registers an entry and exposes it via getter", () => {
    const controls = noopControls();
    const dispose = registerFocusedComposerControls("landing", controls);
    const entry = getFocusedComposerControls();
    expect(entry?.kind).toBe("landing");
    expect(entry?.controls).toBe(controls);
    dispose();
    expect(getFocusedComposerControls()).toBeNull();
  });

  it("the latest registration wins; disposing the winner clears the slot", () => {
    const first = noopControls();
    const second = noopControls();
    registerFocusedComposerControls("landing", first);
    const disposeSecond = registerFocusedComposerControls("chat-tile", second);
    expect(getFocusedComposerControls()?.controls).toBe(second);
    disposeSecond();
    expect(getFocusedComposerControls()).toBeNull();
  });

  it("disposing a non-winner is a no-op (slot keeps the winner)", () => {
    const first = noopControls();
    const second = noopControls();
    const disposeFirst = registerFocusedComposerControls("landing", first);
    registerFocusedComposerControls("chat-tile", second);
    disposeFirst();
    expect(getFocusedComposerControls()?.controls).toBe(second);
  });

  it("notifies subscribers on register and on dispose", () => {
    let calls = 0;
    const dispose = subscribeFocusedComposerControls(() => {
      calls += 1;
    });
    const disposeRegister = registerFocusedComposerControls(
      "landing",
      noopControls(),
    );
    expect(calls).toBe(1);
    disposeRegister();
    expect(calls).toBe(2);
    dispose();
  });
});
