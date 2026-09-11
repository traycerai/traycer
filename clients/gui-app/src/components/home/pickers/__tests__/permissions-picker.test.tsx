import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionsPicker } from "@/components/home/pickers/permissions-picker";
import type { AutoJudgeBilling } from "@/lib/auto-mode/auto-judge-billing";
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
  readonly turnActive: boolean;
  readonly judgeBilling: AutoJudgeBilling | null;
}

const DEFAULT_RENDER_PICKER_OPTIONS: RenderPickerOptions = {
  value: "full_access",
  supportedPermissionModes: null,
  harnessLabel: "Claude Code",
  catalogSupportedModes: null,
  turnActive: false,
  judgeBilling: null,
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
      onChange={vi.fn()}
      supportedPermissionModes={options.supportedPermissionModes}
      harnessLabel={options.harnessLabel}
      catalogSupportedModes={options.catalogSupportedModes}
      turnActive={options.turnActive}
      judgeBilling={options.judgeBilling}
      closeFocus="trigger"
    />,
  );
}

describe("<PermissionsPicker /> - C6 catalogSupportedModes copy", () => {
  it("blames a newer Traycer when the catalog lists modes but none includes auto", () => {
    renderPicker({
      supportedPermissionModes: [
        "supervised",
        "auto_accept_edits",
        "full_access",
      ],
      harnessLabel: "Claude Code",
      catalogSupportedModes: ["supervised", "auto_accept_edits", "full_access"],
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

describe("<PermissionsPicker /> - C1 description + meta line", () => {
  it("shows the exact auto description with the em dash", () => {
    renderPicker({});
    openMenu();

    expect(
      screen.getByText(
        "Auto-approve edits. A judge reviews each command and asks you whenever it can't clearly approve — risky, unsure, or unavailable.",
      ),
    ).toBeTruthy();
  });

  it("shows the Traycer-credits meta line for traycer billing", () => {
    renderPicker({ judgeBilling: { kind: "traycer" } });
    openMenu();

    expect(screen.getByTestId("permission-option-meta").textContent).toBe(
      "Uses your Traycer credits.",
    );
  });

  it("shows the provider-account meta line for provider billing", () => {
    renderPicker({
      judgeBilling: {
        kind: "provider",
        harnessId: "claude",
        harnessLabel: "Claude Code",
      },
    });
    openMenu();

    expect(screen.getByTestId("permission-option-meta").textContent).toBe(
      "Uses your Claude Code account.",
    );
  });

  it("renders no meta line at all when judgeBilling is null", () => {
    renderPicker({ judgeBilling: null });
    openMenu();

    expect(screen.queryByTestId("permission-option-meta")).toBeNull();
  });
});

describe("<PermissionsPicker /> - C2 mid-turn notice", () => {
  it("shows the notice when a turn is active and the current value is not auto", () => {
    renderPicker({ turnActive: true, value: "full_access" });
    openMenu();

    expect(
      screen.getByTestId("permission-option-mid-turn-notice").textContent,
    ).toBe(
      "The judge starts on your next message. This turn keeps running as it is.",
    );
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
