import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionsPicker } from "@/components/home/pickers/permissions-picker";
import {
  AUTO_MID_TURN_UNRESOLVED_LOCK,
  type AutoJudgeBilling,
} from "@/lib/auto-mode/auto-judge-billing";
import {
  AUTO_JUDGE_UNAVAILABLE_DESCRIPTION,
  type PermissionMode,
} from "@/components/home/data/landing-options";

afterEach(() => {
  cleanup();
});

function openMenu() {
  // Radix's DropdownMenuTrigger opens on pointerdown, not the click event.
  fireEvent.pointerDown(screen.getByRole("button"), { button: 0 });
}

interface RenderPickerOptions {
  readonly value: PermissionMode;
  readonly supportedPermissionModes: ReadonlyArray<PermissionMode> | null;
  readonly harnessLabel: string | null;
  readonly catalogSupportedModes: ReadonlyArray<PermissionMode> | null;
  readonly hostKnowsAutoMode: boolean;
  readonly turnActive: boolean;
  readonly judgeBilling: AutoJudgeBilling | null;
  readonly onOpenPermissionSettings: (() => void) | null;
  readonly onChange: (next: PermissionMode) => void;
}

const DEFAULT_RENDER_PICKER_OPTIONS: RenderPickerOptions = {
  value: "full_access",
  supportedPermissionModes: null,
  harnessLabel: "Claude Code",
  catalogSupportedModes: null,
  hostKnowsAutoMode: true,
  turnActive: false,
  judgeBilling: null,
  onOpenPermissionSettings: null,
  onChange: vi.fn(),
};

// Plain object-spread merge rather than `??` defaults: several cases here
// deliberately pass `null` (e.g. `harnessLabel: null`), and `??` treats a
// present `null` as "missing" and silently replaces it with the default -
// exactly the value these tests need to observe.
function renderPicker(overrides: Partial<RenderPickerOptions>) {
  const options: RenderPickerOptions = {
    ...DEFAULT_RENDER_PICKER_OPTIONS,
    ...overrides,
  };
  render(
    <PermissionsPicker
      value={options.value}
      disabled={false}
      onChange={options.onChange}
      supportedPermissionModes={options.supportedPermissionModes}
      harnessLabel={options.harnessLabel}
      catalogSupportedModes={options.catalogSupportedModes}
      hostKnowsAutoMode={options.hostKnowsAutoMode}
      turnActive={options.turnActive}
      judgeBilling={options.judgeBilling}
      closeFocus="trigger"
      onOpenPermissionSettings={options.onOpenPermissionSettings}
    />,
  );
}

describe("<PermissionsPicker /> - catalogSupportedModes copy", () => {
  it("blames a newer Traycer when the catalog lists modes but none includes auto", () => {
    renderPicker({
      supportedPermissionModes: [
        "supervised",
        "auto_accept_edits",
        "full_access",
      ],
      harnessLabel: "Claude Code",
      catalogSupportedModes: ["supervised", "auto_accept_edits", "full_access"],
      hostKnowsAutoMode: false,
    });
    openMenu();

    expect(
      screen.getByText("Needs a newer Traycer on this machine."),
    ).toBeTruthy();
  });

  it("blames the provider when the catalog carries auto elsewhere but not on this row", () => {
    renderPicker({
      supportedPermissionModes: [
        "supervised",
        "auto_accept_edits",
        "full_access",
      ],
      harnessLabel: "Claude Code",
      catalogSupportedModes: [
        "supervised",
        "auto_accept_edits",
        "auto",
        "full_access",
      ],
    });
    openMenu();

    expect(screen.getByText("Not supported by Claude Code.")).toBeTruthy();
  });

  it("blames the provider (today's fallback) when catalogSupportedModes is null", () => {
    renderPicker({
      supportedPermissionModes: [
        "supervised",
        "auto_accept_edits",
        "full_access",
      ],
      harnessLabel: "Claude Code",
      catalogSupportedModes: null,
    });
    openMenu();

    expect(screen.getByText("Not supported by Claude Code.")).toBeTruthy();
  });

  it("falls back to the generic 'this provider' when harnessLabel is null", () => {
    renderPicker({
      supportedPermissionModes: [
        "supervised",
        "auto_accept_edits",
        "full_access",
      ],
      harnessLabel: null,
      catalogSupportedModes: null,
    });
    openMenu();

    expect(screen.getByText("Not supported by this provider.")).toBeTruthy();
  });
});

describe("<PermissionsPicker /> - Auto option gated on hostKnowsAutoMode", () => {
  function autoMenuItem(): HTMLElement {
    const item = screen
      .getAllByRole("menuitemradio")
      .find(
        (option) =>
          option.querySelector(".font-medium")?.textContent === "Auto",
      );
    if (item === undefined) throw new Error("Auto menu item not found");
    return item;
  }

  it("disables Auto on an unconstrained row when the host cannot spell auto", () => {
    renderPicker({
      supportedPermissionModes: null,
      hostKnowsAutoMode: false,
    });
    openMenu();

    expect(autoMenuItem().hasAttribute("data-disabled")).toBe(true);
  });

  it("enables Auto on the same unconstrained row once the host proves it can spell auto", () => {
    renderPicker({
      supportedPermissionModes: null,
      hostKnowsAutoMode: true,
    });
    openMenu();

    expect(autoMenuItem().hasAttribute("data-disabled")).toBe(false);
  });
});

describe("<PermissionsPicker /> - empty supportedPermissionModes means unconstrained", () => {
  it("leaves every option enabled, with no 'Not supported by' copy, when supportedPermissionModes is []", () => {
    renderPicker({
      supportedPermissionModes: [],
      harnessLabel: "Claude Code",
      catalogSupportedModes: null,
    });
    openMenu();

    for (const option of screen.getAllByRole("menuitemradio")) {
      expect(option.getAttribute("aria-disabled")).not.toBe("true");
    }
    expect(screen.queryByText(/Not supported by/)).toBeNull();
    expect(screen.queryByText("Needs a newer Traycer on this machine.")).toBe(
      null,
    );
  });
});

describe("<PermissionsPicker /> - the four labels and one-line descriptions", () => {
  it("shows every mode's label and description, in the picker's presentation order (Experimental Auto last)", () => {
    renderPicker({});
    openMenu();

    const items = screen.getAllByRole("menuitemradio");
    expect(
      items.map((item) => item.querySelector(".font-medium")?.textContent),
    ).toEqual(["Supervised", "Auto-accept edits", "Full access", "Auto"]);

    expect(
      screen.getByText("Asks before every command and file change."),
    ).toBeTruthy();
    expect(
      screen.getByText("Edits go through. Commands still ask."),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "A judge approves routine commands and asks you about risky ones.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Runs everything. Nothing asks.")).toBeTruthy();
  });
});

describe("<PermissionsPicker /> - Auto's Experimental badge and label", () => {
  function menuItemFor(label: string): HTMLElement {
    const item = screen
      .getAllByRole("menuitemradio")
      .find(
        (option) => option.querySelector(".font-medium")?.textContent === label,
      );
    if (item === undefined) throw new Error(`${label} menu item not found`);
    return item;
  }

  it("shows the Experimental badge on the Auto row only", () => {
    renderPicker({});
    openMenu();

    expect(within(menuItemFor("Auto")).getByText("Experimental")).toBeTruthy();
    expect(
      within(menuItemFor("Supervised")).queryByText("Experimental"),
    ).toBeNull();
    expect(
      within(menuItemFor("Auto-accept edits")).queryByText("Experimental"),
    ).toBeNull();
    expect(
      within(menuItemFor("Full access")).queryByText("Experimental"),
    ).toBeNull();
  });

  it("renders no reviewer/model/billing meta line on the Auto row, whatever judgeBilling names", () => {
    renderPicker({
      judgeBilling: {
        kind: "traycer",
        modelLabel: "Sonnet 5",
        effortLabel: null,
      },
    });
    openMenu();

    expect(within(menuItemFor("Auto")).queryByText(/Reviewed by/)).toBeNull();
  });

  it("names the trigger 'Auto — Experimental' for assistive tech and the tooltip when Auto is selected", () => {
    renderPicker({ value: "auto" });

    const trigger = screen.getByRole("button");
    expect(trigger.getAttribute("aria-label")).toBe("Auto — Experimental");
    expect(within(trigger).getByText("Experimental")).toBeTruthy();
  });

  it("leaves the trigger's accessible name unchanged for a non-Auto mode", () => {
    renderPicker({ value: "full_access" });

    const trigger = screen.getByRole("button");
    expect(trigger.getAttribute("aria-label")).toBe("Full access");
    expect(within(trigger).queryByText("Experimental")).toBeNull();
  });
});

describe("<PermissionsPicker /> - mid-turn notice", () => {
  // Settled billing throughout: with a turn active, an unsettled (`null`)
  // billing locks the Auto row instead of showing the notice - see the
  // mid-turn lock block below.
  const SETTLED_BILLING: AutoJudgeBilling = {
    kind: "traycer",
    modelLabel: "Sonnet 5",
    effortLabel: null,
  };

  it("shows the notice when a turn is active and the current value is not auto", () => {
    renderPicker({
      turnActive: true,
      value: "full_access",
      judgeBilling: SETTLED_BILLING,
    });
    openMenu();

    expect(
      screen.getByTestId("permission-option-mid-turn-notice").textContent,
    ).toBe("Switches now. Anything already waiting still asks you.");
  });

  it("shows the notice when a turn is active and the current value is supervised", () => {
    renderPicker({
      turnActive: true,
      value: "supervised",
      judgeBilling: SETTLED_BILLING,
    });
    openMenu();

    expect(
      screen.getByTestId("permission-option-mid-turn-notice").textContent,
    ).toBe("Switches now. Anything already waiting still asks you.");
  });

  it("is absent when no turn is active", () => {
    renderPicker({ turnActive: false, value: "full_access" });
    openMenu();

    expect(
      screen.queryByTestId("permission-option-mid-turn-notice"),
    ).toBeNull();
  });

  it("is absent when a turn is active but the current value is already auto", () => {
    renderPicker({ turnActive: true, value: "auto" });
    openMenu();

    expect(
      screen.queryByTestId("permission-option-mid-turn-notice"),
    ).toBeNull();
  });
});

describe("<PermissionsPicker /> - mid-turn lock", () => {
  const PROVIDER_NATIVE_BILLING: AutoJudgeBilling = {
    kind: "provider-native",
    harnessId: "claude",
    harnessLabel: "Claude Code",
  };

  function autoMenuItem(): HTMLElement {
    const item = screen
      .getAllByRole("menuitemradio")
      .find(
        (option) =>
          option.querySelector(".font-medium")?.textContent === "Auto",
      );
    if (item === undefined) throw new Error("Auto menu item not found");
    return item;
  }

  it("disables the Auto item and shows the lock sentence, with no mid-turn notice, when billing is provider-native and a turn is active on a non-auto value", () => {
    renderPicker({
      judgeBilling: PROVIDER_NATIVE_BILLING,
      turnActive: true,
      value: "supervised",
    });
    openMenu();

    const item = autoMenuItem();
    expect(item.hasAttribute("data-disabled")).toBe(true);
    expect(item.textContent).toContain(
      "Claude Code's built-in classifier starts with your next turn. To switch now, pick Traycer's judge in Providers ▸ Claude Code ▸ Permissions.",
    );
    expect(
      screen.queryByTestId("permission-option-mid-turn-notice"),
    ).toBeNull();
  });

  it("does not call onChange when the locked Auto item is selected", () => {
    const onChange = vi.fn();
    renderPicker({
      judgeBilling: PROVIDER_NATIVE_BILLING,
      turnActive: true,
      value: "supervised",
      onChange,
    });
    openMenu();

    fireEvent.click(autoMenuItem());

    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not lock Auto when the current value is already auto", () => {
    renderPicker({
      judgeBilling: PROVIDER_NATIVE_BILLING,
      turnActive: true,
      value: "auto",
    });
    openMenu();

    expect(autoMenuItem().hasAttribute("data-disabled")).toBe(false);
  });

  it("does not lock Auto when no turn is active, and shows its ordinary description", () => {
    renderPicker({
      judgeBilling: PROVIDER_NATIVE_BILLING,
      turnActive: false,
      value: "supervised",
    });
    openMenu();

    expect(autoMenuItem().hasAttribute("data-disabled")).toBe(false);
    expect(autoMenuItem().textContent).toContain(
      "A judge approves routine commands and asks you about risky ones.",
    );
  });

  it("shows the no-judge description in place of the ordinary one when billing is blocked, with no lock", () => {
    renderPicker({
      judgeBilling: { kind: "blocked" },
      turnActive: false,
      value: "supervised",
    });
    openMenu();

    const item = autoMenuItem();
    expect(item.hasAttribute("data-disabled")).toBe(false);
    expect(item.textContent).toContain(AUTO_JUDGE_UNAVAILABLE_DESCRIPTION);
  });

  it("keeps the no-judge description alongside the mid-turn notice for blocked billing during a turn", () => {
    renderPicker({
      judgeBilling: { kind: "blocked" },
      turnActive: true,
      value: "supervised",
    });
    openMenu();

    const item = autoMenuItem();
    // Blocked billing never locks the row (only `null` or provider-native
    // billing does - see `autoModeMidTurnLock`), so both the substituted
    // description and the notice below it are shown.
    expect(item.hasAttribute("data-disabled")).toBe(false);
    expect(item.textContent).toContain(AUTO_JUDGE_UNAVAILABLE_DESCRIPTION);
    expect(
      screen.getByTestId("permission-option-mid-turn-notice").textContent,
    ).toBe("Switches now. Anything already waiting still asks you.");
  });

  it("lets an unsupported reason win over the blocked no-judge description", () => {
    renderPicker({
      judgeBilling: { kind: "blocked" },
      supportedPermissionModes: null,
      catalogSupportedModes: ["supervised", "auto_accept_edits", "full_access"],
      hostKnowsAutoMode: false,
    });
    openMenu();

    const item = autoMenuItem();
    expect(item.hasAttribute("data-disabled")).toBe(true);
    expect(item.textContent).not.toContain(AUTO_JUDGE_UNAVAILABLE_DESCRIPTION);
    expect(item.textContent).toContain(
      "Needs a newer Traycer on this machine.",
    );
  });

  it("does not lock Auto for traycer billing, and keeps the mid-turn notice", () => {
    renderPicker({
      judgeBilling: {
        kind: "traycer",
        modelLabel: "Sonnet 5",
        effortLabel: null,
      },
      turnActive: true,
      value: "supervised",
    });
    openMenu();

    expect(autoMenuItem().hasAttribute("data-disabled")).toBe(false);
    expect(
      screen.getByTestId("permission-option-mid-turn-notice").textContent,
    ).toBe("Switches now. Anything already waiting still asks you.");
  });

  it("disables the Auto item with the unresolved sentence, and no notice, while billing has not settled during a turn", () => {
    renderPicker({
      judgeBilling: null,
      turnActive: true,
      value: "supervised",
    });
    openMenu();

    const item = autoMenuItem();
    expect(item.hasAttribute("data-disabled")).toBe(true);
    expect(item.textContent).toContain(AUTO_MID_TURN_UNRESOLVED_LOCK);
    expect(
      screen.queryByTestId("permission-option-mid-turn-notice"),
    ).toBeNull();
  });

  it("does not lock Auto on unsettled billing when no turn is active", () => {
    renderPicker({
      judgeBilling: null,
      turnActive: false,
      value: "supervised",
    });
    openMenu();

    expect(autoMenuItem().hasAttribute("data-disabled")).toBe(false);
  });
});

describe("<PermissionsPicker /> - trailing 'Permission settings…' item", () => {
  it("renders the item after a separator when a callback is given, and calls it on select", () => {
    const onOpenPermissionSettings = vi.fn();
    renderPicker({ onOpenPermissionSettings });
    openMenu();

    const item = screen.getByRole("menuitem", { name: "Permission settings…" });
    expect(item).toBeTruthy();

    fireEvent.click(item);

    expect(onOpenPermissionSettings).toHaveBeenCalledTimes(1);
  });

  it("renders no trailing item when onOpenPermissionSettings is null (the Settings default-mode row)", () => {
    renderPicker({ onOpenPermissionSettings: null });
    openMenu();

    expect(
      screen.queryByRole("menuitem", { name: "Permission settings…" }),
    ).toBeNull();
  });
});
