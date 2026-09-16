import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerOptionsSheet } from "@/components/home/mobile/composer-options-sheet";
import {
  AUTO_MID_TURN_NOTICE,
  type PermissionMode,
} from "@/components/home/data/landing-options";

// The sheet portals to <body> and re-asserts the app theme there; the provider
// itself is not under test.
vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({ resolvedTheme: "dark", themePreset: "neutral" }),
}));

afterEach(cleanup);

function renderSheet(overrides: {
  readonly supportedPermissionModes: ReadonlyArray<PermissionMode> | null;
  readonly onPermissionChange: (next: PermissionMode) => void;
  readonly settingsLocked: boolean;
  // Required, not optional: the repo's type rules ask for an explicit value
  // over a `?`-plus-default pair, and `defaults()` below is what supplies them
  // - so a case that cares about either one overrides it visibly.
  readonly permission: PermissionMode;
  readonly turnActive: boolean;
}) {
  return render(
    <ComposerOptionsSheet
      open
      onOpenChange={vi.fn()}
      permission={overrides.permission}
      onPermissionChange={overrides.onPermissionChange}
      supportedPermissionModes={overrides.supportedPermissionModes}
      harnessLabel="Cursor"
      // Today's-behaviour values: no catalog to union and no host whose judge
      // this fixture could name, so every row renders exactly what it
      // rendered before these props existed. The unsupported-copy branch is
      // covered against the desktop picker, which shares the two pure helpers
      // this sheet calls.
      catalogSupportedModes={null}
      turnActive={overrides.turnActive}
      judgeBilling={null}
      settingsLocked={overrides.settingsLocked}
    />,
  );
}

/** A harness that honors only full access (Cursor's real shape today). */
const FULL_ACCESS_ONLY: ReadonlyArray<PermissionMode> = ["full_access"];

function defaults(): {
  readonly supportedPermissionModes: ReadonlyArray<PermissionMode> | null;
  readonly onPermissionChange: (next: PermissionMode) => void;
  readonly settingsLocked: boolean;
  readonly permission: PermissionMode;
  readonly turnActive: boolean;
} {
  return {
    supportedPermissionModes: null,
    onPermissionChange: vi.fn(),
    settingsLocked: false,
    permission: "supervised",
    turnActive: false,
  };
}

describe("ComposerOptionsSheet", () => {
  it("marks the active permission as checked", () => {
    renderSheet(defaults());
    expect(
      screen
        .getByRole("radio", { name: /Supervised/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("reports the picked permission", async () => {
    const props = defaults();
    renderSheet(props);
    await userEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    expect(props.onPermissionChange).toHaveBeenCalledWith("full_access");
  });

  it("disables a mode the harness does not support and names the harness", async () => {
    const props = { ...defaults(), supportedPermissionModes: FULL_ACCESS_ONLY };
    renderSheet(props);
    const supervised = screen.getByRole("radio", { name: /Supervised/ });
    expect(supervised.hasAttribute("disabled")).toBe(true);
    // Scoped to the row: every unsupported mode carries this copy, so a
    // document-wide lookup matches more than one.
    expect(supervised.textContent).toContain("Not supported by Cursor.");
    await userEvent.click(supervised);
    expect(props.onPermissionChange).not.toHaveBeenCalled();
  });

  it("leaves every mode enabled when supportedPermissionModes is an empty array", async () => {
    const props = { ...defaults(), supportedPermissionModes: [] };
    renderSheet(props);
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio.hasAttribute("disabled")).toBe(false);
    }
    const supervised = screen.getByRole("radio", { name: /Supervised/ });
    expect(supervised.textContent).not.toContain("Not supported by");
    await userEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    expect(props.onPermissionChange).toHaveBeenCalledWith("full_access");
  });

  it("checks the effective permission when the sticky one is unsupported", () => {
    // Sticky is "supervised", which this harness doesn't honor - the check must
    // sit on the mode that will actually run, as the desktop picker does.
    renderSheet({ ...defaults(), supportedPermissionModes: FULL_ACCESS_ONLY });
    expect(
      screen
        .getByRole("radio", { name: /Full access/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("locks the radio rows when settings are locked", () => {
    renderSheet({ ...defaults(), settingsLocked: true });
    expect(
      screen
        .getByRole("radio", { name: /Full access/ })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("renders the Auto option and disables it with the unsupported copy on a host whose row lacks it", async () => {
    const props = {
      ...defaults(),
      supportedPermissionModes: [
        "supervised",
        "auto_accept_edits",
        "full_access",
      ] as ReadonlyArray<PermissionMode>,
    };
    renderSheet(props);
    // Auto is the only mode this row omits, so its "Not supported by" copy
    // is the unique text to scope through - an accessible-name query would
    // be ambiguous, since it concatenates label + description and "Auto" is
    // a substring of "Auto-accept edits" too.
    const auto = screen.getByTestId("composer-options-permission-auto");
    expect(auto.hasAttribute("disabled")).toBe(true);
    expect(auto.textContent).toContain("Not supported by Cursor.");
    await userEvent.click(auto);
    expect(props.onPermissionChange).not.toHaveBeenCalled();
  });

  it("shows the same mid-turn notice string as the desktop picker for a mid-turn supervised user", () => {
    renderSheet({ ...defaults(), turnActive: true, permission: "supervised" });
    expect(
      screen.getByTestId("composer-options-permission-mid-turn-notice")
        .textContent,
    ).toBe(AUTO_MID_TURN_NOTICE);
  });

  it("shows the mid-turn notice for a mid-turn full_access user too", () => {
    renderSheet({ ...defaults(), turnActive: true, permission: "full_access" });
    expect(
      screen.getByTestId("composer-options-permission-mid-turn-notice")
        .textContent,
    ).toBe(AUTO_MID_TURN_NOTICE);
  });

  it("does not show the mid-turn notice when the current permission is already auto", () => {
    renderSheet({
      ...defaults(),
      turnActive: true,
      permission: "auto",
      supportedPermissionModes: [
        "supervised",
        "auto_accept_edits",
        "auto",
        "full_access",
      ],
    });
    expect(
      screen.queryByTestId("composer-options-permission-mid-turn-notice"),
    ).toBeNull();
  });
});
