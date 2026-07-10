import "../../../../__tests__/test-browser-apis";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { ProfileDropdownShortcutHint } from "../profile-dropdown";

// Render the Radix dropdown menu inline + always-open so tests can assert /
// click its rows without fighting pointer-open semantics in jsdom (mirrors
// the established mock in worktrees-settings-panel.test / folder-controls.test).
vi.mock("@/components/ui/dropdown-menu", () => {
  const passthrough = (props: { readonly children: ReactNode }): ReactNode =>
    props.children;
  return {
    DropdownMenu: (props: {
      readonly children: ReactNode;
      readonly modal: boolean | undefined;
    }): ReactNode => (
      <div data-testid="profile-dropdown-root" data-modal={String(props.modal)}>
        {props.children}
      </div>
    ),
    DropdownMenuTrigger: passthrough,
    DropdownMenuContent: passthrough,
    DropdownMenuItem: (props: {
      readonly children: ReactNode;
      readonly onSelect: (() => void) | undefined;
      readonly "aria-label": string | undefined;
      readonly "aria-current": "true" | undefined;
      readonly className: string | undefined;
      readonly disabled: boolean | undefined;
      readonly title: string | undefined;
    }): ReactNode => (
      <button
        type="button"
        role="menuitem"
        aria-label={props["aria-label"]}
        aria-current={props["aria-current"]}
        className={props.className}
        disabled={props.disabled}
        title={props.title}
        onClick={props.onSelect}
      >
        {props.children}
      </button>
    ),
    DropdownMenuSeparator: (): ReactNode => <div role="separator" />,
    DropdownMenuShortcut: (props: {
      readonly children: ReactNode;
      readonly "data-testid": string | undefined;
    }): ReactNode => (
      <span data-testid={props["data-testid"]}>{props.children}</span>
    ),
  };
});

import { ProfileDropdown } from "../profile-dropdown";

function profile(
  profileId: string,
  kind: ProviderProfile["kind"],
  label: string,
  authStatus: ProviderProfile["auth"]["status"],
): ProviderProfile {
  return {
    profileId,
    kind,
    authType: "oauth",
    label,
    auth: {
      status: authStatus,
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

const AMBIENT = profile(
  "ambient",
  "ambient",
  "Terminal account",
  "authenticated",
);
const WORK = profile("work-profile", "managed", "Work", "authenticated");
const PERSONAL_SIGNED_OUT = profile(
  "personal-profile",
  "managed",
  "Personal",
  "unauthenticated",
);

// A caller-injected hint stub, decoupled from the picker's real digit-mapping
// (see `harness-model-picker-shortcut-hint.test.ts` for that) - this file
// tests only the CONTRACT: `ProfileDropdown` calls the injected function per
// row and renders whatever it returns, owning no keybinding policy itself.
function stubShortcutHintForIndex(
  index: number,
): ProfileDropdownShortcutHint | null {
  return index < 9
    ? { digit: String(index + 1), label: `Hint ${index + 1}` }
    : null;
}

function noShortcutHint(): ProfileDropdownShortcutHint | null {
  return null;
}

interface RenderDropdownInput {
  readonly profiles: ReadonlyArray<ProviderProfile>;
  readonly activeProfileId: string | null;
  readonly onSelectProfile: (profileId: string | null) => void;
  readonly onCreateProfile: () => void;
  readonly createProfileDisabled: boolean;
  readonly createProfileDisabledReason: string | undefined;
  readonly shortcutHintForIndex: (
    index: number,
  ) => ProfileDropdownShortcutHint | null;
  readonly onCloseAutoFocus: (() => void) | null;
}

function renderDropdown(input: RenderDropdownInput) {
  return render(
    <ProfileDropdown
      providerLabel="Codex"
      profiles={input.profiles}
      activeProfileId={input.activeProfileId}
      onSelectProfile={input.onSelectProfile}
      onCreateProfile={input.onCreateProfile}
      createProfileDisabled={input.createProfileDisabled}
      createProfileDisabledReason={input.createProfileDisabledReason}
      shortcutHintForIndex={input.shortcutHintForIndex}
      contentContainer={null}
      onCloseAutoFocus={input.onCloseAutoFocus}
    />,
  );
}

describe("<ProfileDropdown />", () => {
  afterEach(() => cleanup());

  it("shows the active profile's dot and name on the closed trigger", () => {
    renderDropdown({
      profiles: [AMBIENT, WORK],
      activeProfileId: "work-profile",
      onSelectProfile: vi.fn(),
      onCreateProfile: vi.fn(),
      createProfileDisabled: false,
      createProfileDisabledReason: undefined,
      shortcutHintForIndex: stubShortcutHintForIndex,
      onCloseAutoFocus: null,
    });

    const trigger = screen.getByRole("button", {
      name: "Codex profile: Work",
    });
    expect(trigger.textContent).toContain("Work");
  });

  it("renders non-modal so nested picker clicks can dismiss only the profile menu", () => {
    renderDropdown({
      profiles: [AMBIENT, WORK],
      activeProfileId: "work-profile",
      onSelectProfile: vi.fn(),
      onCreateProfile: vi.fn(),
      createProfileDisabled: false,
      createProfileDisabledReason: undefined,
      shortcutHintForIndex: stubShortcutHintForIndex,
      onCloseAutoFocus: null,
    });

    expect(screen.getByTestId("profile-dropdown-root").dataset.modal).toBe(
      "false",
    );
  });

  it("lists every profile as a row, dimming a signed-out row with a status suffix", () => {
    renderDropdown({
      profiles: [AMBIENT, WORK, PERSONAL_SIGNED_OUT],
      activeProfileId: "work-profile",
      onSelectProfile: vi.fn(),
      onCreateProfile: vi.fn(),
      createProfileDisabled: false,
      createProfileDisabledReason: undefined,
      shortcutHintForIndex: stubShortcutHintForIndex,
      onCloseAutoFocus: null,
    });

    expect(
      screen.getByRole("menuitem", { name: "Terminal account" }),
    ).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "Work" })).toBeDefined();
    const signedOutRow = screen.getByRole("menuitem", {
      name: "Personal, Signed out",
    });
    expect(signedOutRow.className).toContain("opacity-60");
  });

  it("commits the clicked row's commit id, using null for the ambient row", () => {
    const onSelectProfile = vi.fn();
    renderDropdown({
      profiles: [AMBIENT, WORK],
      activeProfileId: "work-profile",
      onSelectProfile,
      onCreateProfile: vi.fn(),
      createProfileDisabled: false,
      createProfileDisabledReason: undefined,
      shortcutHintForIndex: stubShortcutHintForIndex,
      onCloseAutoFocus: null,
    });

    fireEvent.click(screen.getByRole("menuitem", { name: "Terminal account" }));
    expect(onSelectProfile).toHaveBeenLastCalledWith(null);

    fireEvent.click(screen.getByRole("menuitem", { name: "Work" }));
    expect(onSelectProfile).toHaveBeenLastCalledWith("work-profile");
  });

  it("shows the create-new-profile row last and invokes onCreateProfile", () => {
    const onCreateProfile = vi.fn();
    renderDropdown({
      profiles: [AMBIENT, WORK],
      activeProfileId: "work-profile",
      onSelectProfile: vi.fn(),
      onCreateProfile,
      createProfileDisabled: false,
      createProfileDisabledReason: undefined,
      shortcutHintForIndex: stubShortcutHintForIndex,
      onCloseAutoFocus: null,
    });

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Create new profile" }),
    );
    expect(onCreateProfile).toHaveBeenCalledTimes(1);
  });

  it("can disable the create-new-profile row with a caller-provided reason", () => {
    const onCreateProfile = vi.fn();
    renderDropdown({
      profiles: [AMBIENT],
      activeProfileId: null,
      onSelectProfile: vi.fn(),
      onCreateProfile,
      createProfileDisabled: true,
      createProfileDisabledReason: "Local sign-in required.",
      shortcutHintForIndex: noShortcutHint,
      onCloseAutoFocus: null,
    });

    const row = screen.getByRole("menuitem", { name: "Create new profile" });
    if (!(row instanceof HTMLButtonElement)) {
      throw new Error("Expected create row mock to render as a button.");
    }
    expect(row.disabled).toBe(true);
    expect(row.getAttribute("title")).toBe("Local sign-in required.");
    fireEvent.click(row);
    expect(onCreateProfile).not.toHaveBeenCalled();
  });

  // Digit-mapping/capping specifics (the shared platform helper, the single-
  // digit limit, the index-9-shows-"0" quirk) are the PICKER's policy now,
  // not this component's - see `harness-model-picker-shortcut-hint.test.ts`.
  // This file only verifies the contract: render whatever the caller's
  // `shortcutHintForIndex` returns, per row, and nothing when it returns
  // `null` - `ProfileDropdown` itself owns no keybinding-formatting logic.
  it("renders the injected shortcut hint's digit and label verbatim, per row", () => {
    renderDropdown({
      profiles: [AMBIENT, WORK],
      activeProfileId: "work-profile",
      onSelectProfile: vi.fn(),
      onCreateProfile: vi.fn(),
      createProfileDisabled: false,
      createProfileDisabledReason: undefined,
      shortcutHintForIndex: stubShortcutHintForIndex,
      onCloseAutoFocus: null,
    });

    expect(screen.getByTestId("model-profile-digit-1").textContent).toBe(
      "Hint 1",
    );
    expect(screen.getByTestId("model-profile-digit-2").textContent).toBe(
      "Hint 2",
    );
  });

  it("hides shortcut hints when the caller (Settings) disables them", () => {
    renderDropdown({
      profiles: [AMBIENT, WORK],
      activeProfileId: "work-profile",
      onSelectProfile: vi.fn(),
      onCreateProfile: vi.fn(),
      createProfileDisabled: false,
      createProfileDisabledReason: undefined,
      shortcutHintForIndex: noShortcutHint,
      onCloseAutoFocus: null,
    });

    expect(screen.queryByTestId("model-profile-digit-1")).toBeNull();
  });

  it("omits the hint but keeps the row selectable when the injected function returns null for that index", () => {
    const onSelectProfile = vi.fn();
    const hintOnlyForFirstRow = (
      index: number,
    ): ProfileDropdownShortcutHint | null =>
      index === 0 ? { digit: "1", label: "Hint 1" } : null;
    renderDropdown({
      profiles: [AMBIENT, WORK],
      activeProfileId: null,
      onSelectProfile,
      onCreateProfile: vi.fn(),
      createProfileDisabled: false,
      createProfileDisabledReason: undefined,
      shortcutHintForIndex: hintOnlyForFirstRow,
      onCloseAutoFocus: null,
    });

    expect(screen.getByTestId("model-profile-digit-1")).toBeDefined();
    expect(screen.queryByTestId("model-profile-digit-2")).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Work" }));
    expect(onSelectProfile).toHaveBeenLastCalledWith("work-profile");
  });

  it("marks the active row with aria-current and leaves inactive rows unmarked", () => {
    renderDropdown({
      profiles: [AMBIENT, WORK],
      activeProfileId: "work-profile",
      onSelectProfile: vi.fn(),
      onCreateProfile: vi.fn(),
      createProfileDisabled: false,
      createProfileDisabledReason: undefined,
      shortcutHintForIndex: stubShortcutHintForIndex,
      onCloseAutoFocus: null,
    });

    expect(
      screen
        .getByRole("menuitem", { name: "Work" })
        .getAttribute("aria-current"),
    ).toBe("true");
    expect(
      screen
        .getByRole("menuitem", { name: "Terminal account" })
        .getAttribute("aria-current"),
    ).toBeNull();
  });
});
