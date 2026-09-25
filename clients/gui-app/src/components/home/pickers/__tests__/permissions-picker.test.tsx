import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionsPicker } from "@/components/home/pickers/permissions-picker";
import {
  AUTO_MID_TURN_UNRESOLVED_LOCK,
  type AutoJudgeBilling,
} from "@/lib/auto-mode/auto-judge-billing";
import type { PermissionMode } from "@/components/home/data/landing-options";

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
  it("shows every mode's label and description in menu order", () => {
    renderPicker({});
    openMenu();

    const items = screen.getAllByRole("menuitemradio");
    expect(
      items.map((item) => item.querySelector(".font-medium")?.textContent),
    ).toEqual(["Supervised", "Auto-accept edits", "Auto", "Full access"]);

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

describe("<PermissionsPicker /> - Auto meta line per billing kind", () => {
  it("shows the traycer meta line naming the model", () => {
    renderPicker({
      judgeBilling: {
        kind: "traycer",
        modelLabel: "Sonnet 5",
        effortLabel: null,
      },
    });
    openMenu();

    expect(screen.getByTestId("permission-option-meta").textContent).toBe(
      "Reviewed by Sonnet 5 on Traycer · uses credits",
    );
  });

  it("shows the provider-account meta line naming the model and the provider", () => {
    renderPicker({
      judgeBilling: {
        kind: "provider",
        harnessId: "claude",
        harnessLabel: "Claude Code",
        modelLabel: "Sonnet",
        effortLabel: null,
      },
    });
    openMenu();

    expect(screen.getByTestId("permission-option-meta").textContent).toBe(
      "Reviewed by Sonnet on Claude Code · your account",
    );
  });

  it("shows the Copilot premium-request meta line", () => {
    renderPicker({
      judgeBilling: {
        kind: "provider",
        harnessId: "copilot",
        harnessLabel: "Copilot",
        modelLabel: "GPT-5",
        effortLabel: null,
      },
    });
    openMenu();

    expect(screen.getByTestId("permission-option-meta").textContent).toBe(
      "Reviewed by GPT-5 on Copilot · uses premium requests (60–350 per hour)",
    );
  });

  it("shows the provider-native no-extra-cost meta line", () => {
    renderPicker({
      judgeBilling: {
        kind: "provider-native",
        harnessId: "claude",
        harnessLabel: "Claude Code",
      },
    });
    openMenu();

    expect(screen.getByTestId("permission-option-meta").textContent).toBe(
      "Reviewed by Claude Code's built-in classifier · no extra cost",
    );
  });

  it("shows the blocked meta line when no judge can run", () => {
    renderPicker({ judgeBilling: { kind: "blocked" } });
    openMenu();

    expect(screen.getByTestId("permission-option-meta").textContent).toBe(
      "No judge available on this machine · asks you instead",
    );
  });

  // A fallback-derived billing is, by the time it reaches the picker, just
  // another `judge` target resolved to its harness's own account - proving
  // the picker renders it identically to an explicit selection.
  it("shows a fallback-derived provider billing the same as an explicit provider selection", () => {
    renderPicker({
      judgeBilling: {
        kind: "provider",
        harnessId: "codex",
        harnessLabel: "Codex",
        modelLabel: "codex-judge-default",
        effortLabel: null,
      },
    });
    openMenu();

    expect(screen.getByTestId("permission-option-meta").textContent).toBe(
      "Reviewed by codex-judge-default on Codex · your account",
    );
  });

  it("renders no meta line at all when judgeBilling is null", () => {
    renderPicker({ judgeBilling: null });
    openMenu();

    expect(screen.queryByTestId("permission-option-meta")).toBeNull();
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

  it("disables the Auto item and shows the lock sentence, with no meta line or mid-turn notice, when billing is provider-native and a turn is active on a non-auto value", () => {
    renderPicker({
      judgeBilling: PROVIDER_NATIVE_BILLING,
      turnActive: true,
      value: "supervised",
    });
    openMenu();

    const item = autoMenuItem();
    expect(item.hasAttribute("data-disabled")).toBe(true);
    expect(item.textContent).toContain(
      "Claude Code's built-in classifier starts with your next turn. To switch now, pick Traycer's judge in Permission settings.",
    );
    expect(screen.queryByTestId("permission-option-meta")).toBeNull();
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

  it("does not lock Auto when no turn is active, and still shows the provider-native meta line", () => {
    renderPicker({
      judgeBilling: PROVIDER_NATIVE_BILLING,
      turnActive: false,
      value: "supervised",
    });
    openMenu();

    expect(autoMenuItem().hasAttribute("data-disabled")).toBe(false);
    expect(screen.getByTestId("permission-option-meta").textContent).toBe(
      "Reviewed by Claude Code's built-in classifier · no extra cost",
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
