import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setMobileApp } from "@/lib/mobile-app";
import { shortcutHintsVisible } from "@/lib/keybindings/shortcut-hints";
import { ShortcutHint } from "@/components/ui/shortcut-hint";

// The single gate every hint surface reads (directly, or through
// `<ShortcutHint>` / a self-gating hint component): the installed mobile app
// has no modifier keys to advertise, everywhere else keeps its hints.
describe("shortcutHintsVisible", () => {
  afterEach(() => {
    setMobileApp(false);
  });

  it("is true outside the installed mobile app", () => {
    expect(shortcutHintsVisible()).toBe(true);
  });

  it("is false on the installed mobile app", () => {
    setMobileApp(true);
    expect(shortcutHintsVisible()).toBe(false);
  });
});

describe("<ShortcutHint />", () => {
  afterEach(() => {
    cleanup();
    setMobileApp(false);
  });

  it("renders its children where hints are visible", () => {
    render(
      <ShortcutHint>
        <span data-testid="hint">Esc</span>
      </ShortcutHint>,
    );
    expect(screen.getByTestId("hint")).toBeTruthy();
  });

  it("renders nothing on the installed mobile app", () => {
    setMobileApp(true);
    render(
      <ShortcutHint>
        <span data-testid="hint">Esc</span>
      </ShortcutHint>,
    );
    expect(screen.queryByTestId("hint")).toBeNull();
  });
});
