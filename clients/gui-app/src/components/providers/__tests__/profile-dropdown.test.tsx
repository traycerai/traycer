import "../../../../__tests__/test-browser-apis";
import type { KeyboardEvent, ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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
    DropdownMenuContent: (props: {
      readonly children: ReactNode;
      readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
    }): ReactNode => (
      <div
        role="menu"
        tabIndex={-1}
        data-testid="profile-dropdown-content"
        onKeyDown={props.onKeyDown}
      >
        {props.children}
      </div>
    ),
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

import { tooltipTextNear } from "@/components/ui/__tests__/tooltip-probe";
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
    rateLimitLimitedScopes: null,
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
  readonly admissionByProfileId: ReadonlyMap<
    string | null,
    { readonly disabled: boolean; readonly reason: string | null }
  > | null;
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
      usagePresentation={null}
      admissionByProfileId={input.admissionByProfileId}
    />,
  );
}

function baseDropdownInput(
  overrides: Partial<RenderDropdownInput> & {
    readonly onSelectProfile?: (profileId: string | null) => void;
    readonly onCreateProfile?: () => void;
  },
): RenderDropdownInput {
  return {
    profiles: overrides.profiles ?? [AMBIENT, WORK],
    activeProfileId:
      overrides.activeProfileId === undefined
        ? "work-profile"
        : overrides.activeProfileId,
    onSelectProfile: overrides.onSelectProfile ?? vi.fn(),
    onCreateProfile: overrides.onCreateProfile ?? vi.fn(),
    createProfileDisabled: overrides.createProfileDisabled ?? false,
    createProfileDisabledReason: overrides.createProfileDisabledReason,
    shortcutHintForIndex:
      overrides.shortcutHintForIndex ?? stubShortcutHintForIndex,
    onCloseAutoFocus: overrides.onCloseAutoFocus ?? null,
    admissionByProfileId:
      overrides.admissionByProfileId === undefined
        ? null
        : overrides.admissionByProfileId,
  };
}

describe("<ProfileDropdown />", () => {
  afterEach(() => cleanup());

  it("shows the active profile's dot and name on the closed trigger", () => {
    renderDropdown(baseDropdownInput({}));

    const trigger = screen.getByRole("button", {
      name: "Codex profile: Work",
    });
    expect(trigger.textContent).toContain("Work");
    expect(
      within(trigger).queryByText("Terminal", {
        selector: '[data-slot="badge"]',
      }),
    ).toBeNull();
  });

  it("shows the Terminal badge on the closed trigger for the ambient profile", () => {
    renderDropdown(baseDropdownInput({ activeProfileId: null }));

    const trigger = screen.getByRole("button", {
      name: "Codex profile: Terminal account, Terminal",
    });
    expect(
      within(trigger).getByText("Terminal", {
        selector: '[data-slot="badge"]',
      }),
    ).toBeDefined();
  });

  it("renders non-modal so nested picker clicks can dismiss only the profile menu", () => {
    renderDropdown(baseDropdownInput({}));

    expect(screen.getByTestId("profile-dropdown-root").dataset.modal).toBe(
      "false",
    );
  });

  it("stops only menu-owned keys from bubbling beyond the dropdown", () => {
    const onDocumentKeyDown = vi.fn();
    document.addEventListener("keydown", onDocumentKeyDown);
    renderDropdown(baseDropdownInput({}));
    const content = screen.getByTestId("profile-dropdown-content");

    ["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Escape"].forEach((key) =>
      fireEvent.keyDown(content, { key }),
    );
    expect(onDocumentKeyDown).not.toHaveBeenCalled();

    fireEvent.keyDown(content, { key: "1", metaKey: true, shiftKey: true });
    expect(onDocumentKeyDown).toHaveBeenCalledTimes(1);
    document.removeEventListener("keydown", onDocumentKeyDown);
  });

  it("lists every profile as a row, dimming a signed-out row with a status suffix", () => {
    renderDropdown(
      baseDropdownInput({
        profiles: [AMBIENT, WORK, PERSONAL_SIGNED_OUT],
      }),
    );

    expect(
      screen.getByRole("menuitem", { name: "Terminal account, Terminal" }),
    ).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "Work" })).toBeDefined();
    const signedOutRow = screen.getByRole("menuitem", {
      name: "Personal, Signed out",
    });
    expect(signedOutRow.className).toContain("opacity-60");
  });

  it("commits the clicked row's commit id, using null for the ambient row", () => {
    const onSelectProfile = vi.fn();
    renderDropdown(baseDropdownInput({ onSelectProfile }));

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Terminal account, Terminal" }),
    );
    expect(onSelectProfile).toHaveBeenLastCalledWith(null);

    fireEvent.click(screen.getByRole("menuitem", { name: "Work" }));
    expect(onSelectProfile).toHaveBeenLastCalledWith("work-profile");
  });

  it("shows the create-new-profile row last and invokes onCreateProfile", () => {
    const onCreateProfile = vi.fn();
    renderDropdown(baseDropdownInput({ onCreateProfile }));

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Create new profile" }),
    );
    expect(onCreateProfile).toHaveBeenCalledTimes(1);
  });

  it("can disable the create-new-profile row with a caller-provided reason", () => {
    const onCreateProfile = vi.fn();
    renderDropdown(
      baseDropdownInput({
        profiles: [AMBIENT],
        activeProfileId: null,
        onCreateProfile,
        createProfileDisabled: true,
        createProfileDisabledReason: "Local sign-in required.",
        shortcutHintForIndex: noShortcutHint,
      }),
    );

    const row = screen.getByRole("menuitem", { name: "Create new profile" });
    if (!(row instanceof HTMLButtonElement)) {
      throw new Error("Expected create row mock to render as a button.");
    }
    expect(row.disabled).toBe(true);
    expect(tooltipTextNear(row)).toBe("Local sign-in required.");
    fireEvent.click(row);
    expect(onCreateProfile).not.toHaveBeenCalled();
  });

  // Digit-mapping/capping specifics (the shared platform helper, the single-
  // digit limit, the index-9-shows-"0" quirk) are the PICKER's policy now,
  // not this component's - see `harness-model-picker-shortcut-hint.test.ts`.
  // This file only verifies the contract: render whatever the caller's
  // `shortcutHintForIndex` returns, per row, and nothing when it returns
  // `null` - `ProfileDropdown` itself owns no keybinding-formatting logic.
  it("renders each injected shortcut hint in the native Kbd component", () => {
    renderDropdown(baseDropdownInput({}));

    const firstHint = screen.getByTestId("model-profile-digit-1");
    const secondHint = screen.getByTestId("model-profile-digit-2");
    expect(firstHint.textContent).toBe("Hint 1");
    expect(secondHint.textContent).toBe("Hint 2");
    expect(firstHint.querySelector('[data-slot="kbd"]')).not.toBeNull();
    expect(secondHint.querySelector('[data-slot="kbd"]')).not.toBeNull();
  });

  it("hides shortcut hints when the caller (Settings) disables them", () => {
    renderDropdown(baseDropdownInput({ shortcutHintForIndex: noShortcutHint }));

    expect(screen.queryByTestId("model-profile-digit-1")).toBeNull();
  });

  it("omits the hint but keeps the row selectable when the injected function returns null for that index", () => {
    const onSelectProfile = vi.fn();
    const hintOnlyForFirstRow = (
      index: number,
    ): ProfileDropdownShortcutHint | null =>
      index === 0 ? { digit: "1", label: "Hint 1" } : null;
    renderDropdown(
      baseDropdownInput({
        activeProfileId: null,
        onSelectProfile,
        shortcutHintForIndex: hintOnlyForFirstRow,
      }),
    );

    expect(screen.getByTestId("model-profile-digit-1")).toBeDefined();
    expect(screen.queryByTestId("model-profile-digit-2")).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Work" }));
    expect(onSelectProfile).toHaveBeenLastCalledWith("work-profile");
  });

  it("marks the active row with aria-current and leaves inactive rows unmarked", () => {
    renderDropdown(baseDropdownInput({}));

    expect(
      screen
        .getByRole("menuitem", { name: "Work" })
        .getAttribute("aria-current"),
    ).toBe("true");
    expect(
      screen
        .getByRole("menuitem", { name: "Terminal account, Terminal" })
        .getAttribute("aria-current"),
    ).toBeNull();
  });

  it("disables an unadmitted profile row and blocks selection", () => {
    const onSelectProfile = vi.fn();
    const admissionByProfileId = new Map<
      string | null,
      { readonly disabled: boolean; readonly reason: string | null }
    >([
      [
        "work-profile",
        {
          disabled: true,
          reason: "This profile can't continue this session.",
        },
      ],
    ]);
    renderDropdown(
      baseDropdownInput({
        activeProfileId: null,
        onSelectProfile,
        admissionByProfileId,
      }),
    );

    // The accessible label folds in the admission reason (amend-01 Fix 5) so
    // a keyboard/AT user can perceive it without hovering the tooltip.
    const blocked = screen.getByRole("menuitem", {
      name: "Work, This profile can't continue this session.",
    });
    if (!(blocked instanceof HTMLButtonElement)) {
      throw new Error("Expected Work row mock to render as a button.");
    }
    expect(blocked.disabled).toBe(true);
    expect(blocked.className).toContain("opacity-60");
    expect(tooltipTextNear(blocked)).toBe(
      "This profile can't continue this session.",
    );
    fireEvent.click(blocked);
    expect(onSelectProfile).not.toHaveBeenCalled();

    // Ambient is not in the admission map - still selectable.
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Terminal account, Terminal" }),
    );
    expect(onSelectProfile).toHaveBeenLastCalledWith(null);
  });

  it("disables the ambient row when admission keys null", () => {
    const onSelectProfile = vi.fn();
    const admissionByProfileId = new Map<
      string | null,
      { readonly disabled: boolean; readonly reason: string | null }
    >([
      [
        null,
        {
          disabled: true,
          reason: "Ambient can't continue this session.",
        },
      ],
    ]);
    renderDropdown(
      baseDropdownInput({
        onSelectProfile,
        admissionByProfileId,
      }),
    );

    // The accessible label folds in the admission reason (amend-01 Fix 5) so
    // a keyboard/AT user can perceive it without hovering the tooltip.
    const ambient = screen.getByRole("menuitem", {
      name: "Terminal account, Terminal, Ambient can't continue this session.",
    });
    if (!(ambient instanceof HTMLButtonElement)) {
      throw new Error("Expected ambient row mock to render as a button.");
    }
    expect(ambient.disabled).toBe(true);
    expect(tooltipTextNear(ambient)).toBe(
      "Ambient can't continue this session.",
    );
    fireEvent.click(ambient);
    expect(onSelectProfile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("menuitem", { name: "Work" }));
    expect(onSelectProfile).toHaveBeenLastCalledWith("work-profile");
  });

  it("dims a disabled admission row even when reason is null (no tooltip)", () => {
    const admissionByProfileId = new Map<
      string | null,
      { readonly disabled: boolean; readonly reason: string | null }
    >([["work-profile", { disabled: true, reason: null }]]);
    renderDropdown(
      baseDropdownInput({
        activeProfileId: null,
        admissionByProfileId,
      }),
    );

    const blocked = screen.getByRole("menuitem", { name: "Work" });
    if (!(blocked instanceof HTMLButtonElement)) {
      throw new Error("Expected Work row mock to render as a button.");
    }
    expect(blocked.disabled).toBe(true);
    expect(blocked.className).toContain("opacity-60");
    // No reason means no TooltipWrapper - native title also absent.
    expect(tooltipTextNear(blocked)).toBeNull();
  });
});
