import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerOptionsSheet } from "@/components/home/mobile/composer-options-sheet";
import type { PermissionMode } from "@/components/home/data/landing-options";

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
}) {
  return render(
    <ComposerOptionsSheet
      open
      onOpenChange={vi.fn()}
      permission="supervised"
      onPermissionChange={overrides.onPermissionChange}
      supportedPermissionModes={overrides.supportedPermissionModes}
      harnessLabel="Cursor"
      settingsLocked={overrides.settingsLocked}
    />,
  );
}

/** A harness that honors only full access (Cursor's real shape today). */
const FULL_ACCESS_ONLY: ReadonlyArray<PermissionMode> = ["full_access"];

function defaults() {
  return {
    supportedPermissionModes: null,
    onPermissionChange: vi.fn(),
    settingsLocked: false,
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
});
