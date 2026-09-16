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
  // The host-capability VETO on the "needs a newer Traycer" sentence. Stated
  // rather than omitted: an absent prop reads as `false`, which is the
  // pre-veto behaviour, so every case here would keep passing while the veto
  // itself went untested.
  readonly hostKnowsAutoMode: boolean;
  readonly turnActive: boolean;
  readonly judgeBilling: AutoJudgeBilling | null;
}

const DEFAULT_RENDER_PICKER_OPTIONS: RenderPickerOptions = {
  value: "full_access",
  supportedPermissionModes: null,
  harnessLabel: "Claude Code",
  catalogSupportedModes: null,
  // A host whose catalog line CAN spell `auto`. That is the ordinary case and
  // the one every test about the auto row wants: with `false` the option is
  // correctly disabled, so a description/meta/notice assertion would be
  // asserting about a row the user cannot reach. The `false` direction has its
  // own case below.
  hostKnowsAutoMode: true,
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
      hostKnowsAutoMode={options.hostKnowsAutoMode}
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
      // Explicit, because this is the one case the veto is ABOUT: the upgrade
      // sentence only appears for a host that cannot spell the mode.
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

// FIX 2 (P1): the Auto row must be gated on the HOST's own line, not the
// row's constraint alone - a pre-`auto` host serves unconstrained rows like
// any other, so the row predicate lit the option up on a machine whose
// `chat.subscribe` line cannot carry the enum.
describe("<PermissionsPicker /> - FIX 2 (P1): Auto option gated on hostKnowsAutoMode", () => {
  // Matched on the label span's EXACT text, not a `startsWith("Auto")`
  // prefix: "auto_accept_edits"'s own label ("Auto-accept edits") also starts
  // with "Auto" and sits earlier in `PERMISSION_OPTIONS` order, so a prefix
  // match would silently grab the wrong row.
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
      "This turn switches over now, and nothing is approved without review - whatever the judge isn't reviewing yet, Traycer asks you about.",
    );
  });

  it("shows the notice when a turn is active and the current value is supervised - the case the old copy was most wrong about", () => {
    renderPicker({ turnActive: true, value: "supervised" });
    openMenu();

    expect(
      screen.getByTestId("permission-option-mid-turn-notice").textContent,
    ).toBe(
      "This turn switches over now, and nothing is approved without review - whatever the judge isn't reviewing yet, Traycer asks you about.",
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

describe("<PermissionsPicker /> - C6 mid-turn notice copy tripwire", () => {
  // This sentence is pinned to `authorizingPermissionMode` in the HOST's
  // `traycer-host/src/domain/chat/chat-session-manager.ts` (not in this
  // submodule, read-only reference):
  //
  //   function authorizingPermissionMode(execution: ActiveExecution): PermissionMode {
  //     if (execution.permissionMode === "auto" && execution.autoJudge === null) {
  //       return "supervised";
  //     }
  //     return execution.permissionMode;
  //   }
  //
  // i.e. a turn that enters `auto` mid-run with no judge bound collapses to
  // `supervised` on the host, and `AUTO_MID_TURN_NOTICE` (`landing-options.ts`)
  // is the GUI's prose description of that fact, shown in this picker at the
  // moment of the choice.
  //
  // This assertion is a COPY TRIPWIRE ONLY: it pins the exact wording so an
  // accidental rewording here is caught. It is explicitly NOT proof that the
  // described collapsing behaviour is correctly implemented end-to-end - no
  // GUI-only test can actually execute `authorizingPermissionMode`, which
  // lives in a different repository (the internal host monorepo) that this
  // suite has no access to and never imports from.
  it("pins the mid-turn notice's exact wording (does not, and cannot, exercise authorizingPermissionMode)", () => {
    renderPicker({ turnActive: true, value: "full_access" });
    openMenu();

    expect(
      screen.getByTestId("permission-option-mid-turn-notice").textContent,
    ).toBe(
      "This turn switches over now, and nothing is approved without review - whatever the judge isn't reviewing yet, Traycer asks you about.",
    );
  });
});
