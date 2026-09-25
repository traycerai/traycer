import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerOptionsSheet } from "@/components/home/mobile/composer-options-sheet";
import {
  AUTO_MID_TURN_NOTICE,
  type PermissionMode,
} from "@/components/home/data/landing-options";
import {
  AUTO_MID_TURN_UNRESOLVED_LOCK,
  type AutoJudgeBilling,
} from "@/lib/auto-mode/auto-judge-billing";

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
  // A host whose catalog line can spell `auto` - the ordinary case, and the
  // one the auto-row assertions need. With `false` the option is correctly
  // disabled and those assertions would be about an unreachable row. Mirrors
  // the desktop picker's fixture. Stated (not defaulted) so a case that cares
  // overrides it visibly - see the FIX 2 describe block below.
  readonly hostKnowsAutoMode: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onOpenPermissionSettings: () => void;
  readonly judgeBilling: AutoJudgeBilling | null;
}) {
  return render(
    <ComposerOptionsSheet
      open
      onOpenChange={overrides.onOpenChange}
      permission={overrides.permission}
      onPermissionChange={overrides.onPermissionChange}
      supportedPermissionModes={overrides.supportedPermissionModes}
      harnessLabel="Cursor"
      // Today's-behaviour values: no catalog to union, so every row renders
      // exactly what it rendered before these props existed. The
      // unsupported-copy branch is covered against the desktop picker, which
      // shares the two pure helpers this sheet calls.
      catalogSupportedModes={null}
      hostKnowsAutoMode={overrides.hostKnowsAutoMode}
      turnActive={overrides.turnActive}
      judgeBilling={overrides.judgeBilling}
      settingsLocked={overrides.settingsLocked}
      onOpenPermissionSettings={overrides.onOpenPermissionSettings}
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
  readonly hostKnowsAutoMode: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onOpenPermissionSettings: () => void;
  readonly judgeBilling: AutoJudgeBilling | null;
} {
  return {
    supportedPermissionModes: null,
    onPermissionChange: vi.fn(),
    settingsLocked: false,
    permission: "supervised",
    turnActive: false,
    hostKnowsAutoMode: true,
    onOpenChange: vi.fn(),
    onOpenPermissionSettings: vi.fn(),
    judgeBilling: null,
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

  // Settled billing: an unsettled (`null`) billing during a turn locks the
  // Auto row instead - see the mid-turn lock block below.
  const SETTLED_BILLING: AutoJudgeBilling = {
    kind: "traycer",
    modelLabel: "Sonnet 5",
  };

  it("shows the same mid-turn notice string as the desktop picker for a mid-turn supervised user", () => {
    renderSheet({
      ...defaults(),
      turnActive: true,
      permission: "supervised",
      judgeBilling: SETTLED_BILLING,
    });
    expect(
      screen.getByTestId("composer-options-permission-mid-turn-notice")
        .textContent,
    ).toBe(AUTO_MID_TURN_NOTICE);
  });

  it("shows the mid-turn notice for a mid-turn full_access user too", () => {
    renderSheet({
      ...defaults(),
      turnActive: true,
      permission: "full_access",
      judgeBilling: SETTLED_BILLING,
    });
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

// FIX 2 (P1): the Auto row must be gated on the HOST's own line, not the
// row's constraint alone - the mobile sheet is the second of the two copies
// of this rule (the desktop picker is the first), and both were wrong the
// same way before this fix.
describe("ComposerOptionsSheet - FIX 2 (P1): Auto option gated on hostKnowsAutoMode", () => {
  it("disables Auto on an unconstrained row when the host cannot spell auto", () => {
    renderSheet({
      ...defaults(),
      supportedPermissionModes: null,
      hostKnowsAutoMode: false,
    });

    const auto = screen.getByTestId("composer-options-permission-auto");
    expect(auto.hasAttribute("disabled")).toBe(true);
  });

  it("enables Auto on the same unconstrained row once the host proves it can spell auto", async () => {
    const props = {
      ...defaults(),
      supportedPermissionModes: null,
      hostKnowsAutoMode: true,
    };
    renderSheet(props);

    const auto = screen.getByTestId("composer-options-permission-auto");
    expect(auto.hasAttribute("disabled")).toBe(false);
    await userEvent.click(auto);
    expect(props.onPermissionChange).toHaveBeenCalledWith("auto");
  });
});

describe("ComposerOptionsSheet - trailing 'Permission settings…' row", () => {
  it("closes the sheet, then calls the callback, in that order", async () => {
    const onOpenChange = vi.fn<(open: boolean) => void>();
    const onOpenPermissionSettings = vi.fn<() => void>();
    renderSheet({ ...defaults(), onOpenChange, onOpenPermissionSettings });

    await userEvent.click(
      screen.getByTestId("composer-options-permission-settings"),
    );

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpenPermissionSettings).toHaveBeenCalledTimes(1);
    const closeOrder = onOpenChange.mock.invocationCallOrder[0];
    const openOrder = onOpenPermissionSettings.mock.invocationCallOrder[0];
    expect(closeOrder).toBeLessThan(openOrder);
  });
});

describe("ComposerOptionsSheet - mid-turn lock", () => {
  const PROVIDER_NATIVE_BILLING: AutoJudgeBilling = {
    kind: "provider-native",
    harnessId: "claude",
    harnessLabel: "Claude Code",
  };

  it("disables the Auto row and shows the lock sentence, with no meta line or mid-turn notice, when billing is provider-native and a turn is active on a non-auto permission", () => {
    renderSheet({
      ...defaults(),
      judgeBilling: PROVIDER_NATIVE_BILLING,
      turnActive: true,
      permission: "supervised",
    });

    const auto = screen.getByTestId("composer-options-permission-auto");
    expect(auto.hasAttribute("disabled")).toBe(true);
    expect(auto.textContent).toContain(
      "Claude Code's built-in classifier starts with your next turn. To switch now, pick Traycer's judge in Providers ▸ Claude Code ▸ Permissions.",
    );
    expect(screen.queryByTestId("composer-options-permission-meta")).toBeNull();
    expect(
      screen.queryByTestId("composer-options-permission-mid-turn-notice"),
    ).toBeNull();
  });

  it("does not call onPermissionChange when the locked Auto row is selected", async () => {
    const props = {
      ...defaults(),
      judgeBilling: PROVIDER_NATIVE_BILLING,
      turnActive: true,
      permission: "supervised" as PermissionMode,
    };
    renderSheet(props);

    await userEvent.click(
      screen.getByTestId("composer-options-permission-auto"),
    );

    expect(props.onPermissionChange).not.toHaveBeenCalled();
  });

  it("disables the Auto row with the unresolved sentence, and no notice, while billing has not settled during a turn", () => {
    renderSheet({
      ...defaults(),
      judgeBilling: null,
      turnActive: true,
      permission: "supervised",
    });

    const auto = screen.getByTestId("composer-options-permission-auto");
    expect(auto.hasAttribute("disabled")).toBe(true);
    expect(auto.textContent).toContain(AUTO_MID_TURN_UNRESOLVED_LOCK);
    expect(
      screen.queryByTestId("composer-options-permission-mid-turn-notice"),
    ).toBeNull();
  });
});
