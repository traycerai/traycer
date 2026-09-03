import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LandingNewTabChooser,
  type LandingNewTabKind,
} from "../landing-new-tab-chooser";
import {
  LANDING_BROWSER_TAB_CAP,
  landingBrowserCapMessage,
} from "../use-landing-browser-open-tab";

function renderChooser(args: {
  readonly terminalReason: string | null;
  readonly browserReason: string | null;
  readonly takeFocus: boolean;
  readonly onPick: (kind: LandingNewTabKind) => void;
  readonly onDismiss: () => void;
}): void {
  render(
    <LandingNewTabChooser
      terminal={{ disabledReason: args.terminalReason }}
      browser={{ disabledReason: args.browserReason }}
      takeFocus={args.takeFocus}
      onPick={args.onPick}
      onDismiss={args.onDismiss}
    />,
  );
}

function openChooser(): {
  readonly onPick: (kind: LandingNewTabKind) => void;
  readonly onDismiss: () => void;
} {
  const onPick = vi.fn();
  const onDismiss = vi.fn();
  renderChooser({
    terminalReason: null,
    browserReason: null,
    takeFocus: true,
    onPick,
    onDismiss,
  });
  return { onPick, onDismiss };
}

function terminalCard(): HTMLElement {
  return screen.getByTestId("landing-new-tab-card-terminal");
}

function browserCard(): HTMLElement {
  return screen.getByTestId("landing-new-tab-card-browser");
}

describe("<LandingNewTabChooser />", () => {
  afterEach(() => {
    cleanup();
  });

  // Verbatim against the core flows' Copy table: this is the first thing the
  // panel says about there being two kinds of tab, so a paraphrase here is a
  // product change, not a wording tweak.
  it("renders both cards and the hint line in the core-flows copy", () => {
    openChooser();

    expect(screen.getByRole("group", { name: "New tab" })).toBeTruthy();
    expect(terminalCard().textContent).toContain("Terminal");
    expect(terminalCard().textContent).toContain(
      "Shell in the selected folder",
    );
    expect(browserCard().textContent).toContain("Browser");
    expect(browserCard().textContent).toContain(
      "Signed-in browser on this device",
    );
    expect(
      screen.getByText("Enter opens Terminal · ⇧⌘J terminal · ⇧⌘B browser"),
    ).toBeTruthy();
  });

  // The chooser owns the keyboard when it opens, and Enter is the BROWSER's
  // activation of a focused native button - which is only true while the card
  // stays a `<button>`, so that is what this pins.
  it("parks focus on Terminal so Enter picks it", () => {
    openChooser();

    expect(document.activeElement).toBe(terminalCard());
    expect(terminalCard().tagName).toBe("BUTTON");
  });

  it("parks focus on Browser when Terminal cannot be picked", () => {
    renderChooser({
      terminalReason: "No folder is attached",
      browserReason: null,
      takeFocus: true,
      onPick: vi.fn(),
      onDismiss: vi.fn(),
    });

    expect(document.activeElement).toBe(browserCard());
  });

  // Both cards dead: focus still parks on Terminal rather than nowhere, so the
  // reader lands on a card that says why instead of on the document body.
  it("parks focus on Terminal when neither card can be picked", () => {
    renderChooser({
      terminalReason: "No folder is attached",
      browserReason: landingBrowserCapMessage(),
      takeFocus: true,
      onPick: vi.fn(),
      onDismiss: vi.fn(),
    });

    expect(document.activeElement).toBe(terminalCard());
  });

  // The panel passes `false` while the directory picker is layered over the
  // chooser: taking focus there would pull the keyboard into an `aria-hidden`
  // control the user cannot see.
  it("takes no focus while something is layered over it", () => {
    renderChooser({
      terminalReason: null,
      browserReason: null,
      takeFocus: false,
      onPick: vi.fn(),
      onDismiss: vi.fn(),
    });

    expect(document.activeElement).toBe(document.body);
  });

  it("picks the kind that was clicked", () => {
    const { onPick } = openChooser();

    fireEvent.click(terminalCard());
    expect(onPick).toHaveBeenCalledWith("terminal");

    fireEvent.click(browserCard());
    expect(onPick).toHaveBeenCalledWith("browser");
    expect(onPick).toHaveBeenCalledTimes(2);
  });

  it("moves focus between the two cards with the arrow keys", () => {
    openChooser();

    fireEvent.keyDown(terminalCard(), { key: "ArrowRight" });
    expect(document.activeElement).toBe(browserCard());

    fireEvent.keyDown(browserCard(), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(terminalCard());

    fireEvent.keyDown(terminalCard(), { key: "ArrowDown" });
    expect(document.activeElement).toBe(browserCard());

    fireEvent.keyDown(browserCard(), { key: "ArrowUp" });
    expect(document.activeElement).toBe(terminalCard());
  });

  it("dismisses on Escape from either card", () => {
    const { onDismiss } = openChooser();

    fireEvent.keyDown(terminalCard(), { key: "Escape" });
    fireEvent.keyDown(browserCard(), { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  // `aria-disabled`, not a native `disabled`: the reason is the point of
  // leaving the card on screen, and a natively disabled button cannot be
  // reached to read it.
  it("keeps a refused card reachable, shows its reason, and refuses the pick", () => {
    const onPick = vi.fn();
    renderChooser({
      terminalReason: "No folder is attached",
      browserReason: null,
      takeFocus: true,
      onPick,
      onDismiss: vi.fn(),
    });

    expect(terminalCard().getAttribute("aria-disabled")).toBe("true");
    expect(terminalCard().hasAttribute("disabled")).toBe(false);
    expect(
      screen.getByTestId("landing-new-tab-card-terminal-reason").textContent,
    ).toBe("No folder is attached");

    fireEvent.keyDown(browserCard(), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(terminalCard());

    fireEvent.click(terminalCard());
    expect(onPick).not.toHaveBeenCalled();
  });

  it("carries the cap message as the Browser card's reason", () => {
    renderChooser({
      terminalReason: null,
      browserReason: landingBrowserCapMessage(),
      takeFocus: true,
      onPick: vi.fn(),
      onDismiss: vi.fn(),
    });

    // Read from the helper the chord's toast also uses, so the two cannot
    // drift; the literal is asserted there against `LANDING_BROWSER_TAB_CAP`.
    expect(
      screen.getByTestId("landing-new-tab-card-browser-reason").textContent,
    ).toBe(landingBrowserCapMessage());
    expect(landingBrowserCapMessage()).toBe(
      `This device has ${LANDING_BROWSER_TAB_CAP} browser tabs open`,
    );
  });

  it("shows no reason line on a card that can be picked", () => {
    openChooser();

    expect(screen.queryByTestId("landing-new-tab-card-terminal-reason")).toBe(
      null,
    );
    expect(screen.queryByTestId("landing-new-tab-card-browser-reason")).toBe(
      null,
    );
  });
});
