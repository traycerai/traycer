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
import { profileCommitId } from "../provider-profile-model";

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
      readonly id: string | undefined;
      readonly onSelect: (() => void) | undefined;
      readonly onClick: (() => void) | undefined;
      readonly onKeyDown:
        ((event: KeyboardEvent<HTMLButtonElement>) => void) | undefined;
      readonly "aria-label": string | undefined;
      readonly "aria-disabled": boolean | undefined;
      readonly "aria-current": "true" | undefined;
      readonly className: string | undefined;
      readonly disabled: boolean | undefined;
      readonly tabIndex: number | undefined;
      readonly title: string | undefined;
    }): ReactNode => (
      <button
        type="button"
        role="menuitem"
        id={props.id}
        aria-label={props["aria-label"]}
        aria-disabled={props["aria-disabled"]}
        aria-current={props["aria-current"]}
        className={props.className}
        disabled={props.disabled}
        tabIndex={props.tabIndex}
        title={props.title}
        onClick={props.onClick ?? props.onSelect}
        onKeyDown={props.onKeyDown}
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
  label: string,
  authStatus: ProviderProfile["auth"]["status"],
  enabled: boolean,
): ProviderProfile {
  return {
    profileId,
    enabled,
    kind: profileId === "ambient" ? "ambient" : "managed",
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

const AMBIENT = profile("ambient", "Terminal account", "authenticated", true);
const WORK = profile("work-profile", "Work", "authenticated", true);
const PERSONAL_SIGNED_OUT = profile(
  "personal-profile",
  "Personal",
  "unauthenticated",
  true,
);
const PERSONAL_DISABLED = profile(
  "personal-profile",
  "Personal",
  "authenticated",
  false,
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
  readonly profileEnablementAvailable: boolean;
  readonly profileEnablementPending: (profileId: string | null) => boolean;
  readonly profileEnablementDisabledReason: (
    profileId: string | null,
  ) => string | null;
  readonly onSetProfileEnabled: (
    profileId: string | null,
    enabled: boolean,
  ) => void;
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
      profileEnablementPending={input.profileEnablementPending}
      contentContainer={null}
      onCloseAutoFocus={input.onCloseAutoFocus}
      usagePresentation={null}
      eligibilityControls={
        input.profileEnablementAvailable
          ? {
              pending: input.profileEnablementPending,
              disabledReason: (profile) =>
                input.profileEnablementDisabledReason(profileCommitId(profile)),
              onSetEnabled: input.onSetProfileEnabled,
            }
          : null
      }
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
    profileEnablementAvailable: overrides.profileEnablementAvailable ?? true,
    profileEnablementPending:
      overrides.profileEnablementPending ?? (() => false),
    profileEnablementDisabledReason:
      overrides.profileEnablementDisabledReason ?? (() => null),
    onSetProfileEnabled: overrides.onSetProfileEnabled ?? vi.fn(),
    admissionByProfileId:
      overrides.admissionByProfileId === undefined
        ? null
        : overrides.admissionByProfileId,
  };
}

describe("<ProfileDropdown />", () => {
  afterEach(() => cleanup());

  it("moves focus between a profile row and its enablement switch", () => {
    renderDropdown(baseDropdownInput({ activeProfileId: "ambient" }));

    const workRow = screen.getByRole("menuitem", { name: "Work" });
    const workSwitch = screen.getByRole("switch", {
      name: "Allow agents to use Work",
    });

    workRow.focus();
    fireEvent.keyDown(workRow, { key: "ArrowRight" });
    expect(document.activeElement).toBe(workSwitch);

    fireEvent.keyDown(workSwitch, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(workRow);
  });

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

  it("shows the active profile switch before the chevron without nesting it in the menu trigger", () => {
    const onSetProfileEnabled = vi.fn();
    renderDropdown(baseDropdownInput({ onSetProfileEnabled }));

    const trigger = screen.getByRole("button", {
      name: "Codex profile: Work",
    });
    const triggerFrame = trigger.parentElement;
    if (triggerFrame === null) throw new Error("Expected a trigger frame.");
    const triggerSwitch = within(triggerFrame).getByRole("switch", {
      name: "Allow agents to use Work",
    });
    const triggerSwitchWrapper = triggerSwitch.parentElement;
    if (triggerSwitchWrapper === null) {
      throw new Error("Expected a trigger switch wrapper.");
    }
    const triggerPointerDown = vi.fn();
    trigger.addEventListener("pointerdown", triggerPointerDown);

    expect(trigger.contains(triggerSwitch)).toBe(false);
    expect(
      trigger.querySelector('[data-slot="profile-dropdown-chevron"]'),
    ).not.toBeNull();
    expect(triggerSwitchWrapper.className).toContain("absolute");
    expect(triggerSwitchWrapper.className).toContain("end-10");
    expect(triggerSwitch.dataset.state).toBe("checked");
    expect(triggerSwitch.className).toContain(
      "data-[state=checked]:bg-primary",
    );

    fireEvent.pointerDown(triggerSwitch);
    fireEvent.click(triggerSwitch);

    expect(triggerPointerDown).not.toHaveBeenCalled();
    expect(onSetProfileEnabled).toHaveBeenCalledWith("work-profile", false);
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
    screen.getByRole("menuitem", {
      name: "Personal, Signed out",
    });
    expect(
      screen.getByRole("group", { name: "Personal profile controls" })
        .className,
    ).toContain("opacity-60");
  });

  it("does not render profile switches for a Terminal-only provider", () => {
    renderDropdown(
      baseDropdownInput({
        profiles: [AMBIENT],
        activeProfileId: null,
        profileEnablementAvailable: false,
      }),
    );

    expect(screen.queryAllByRole("switch")).toHaveLength(0);
  });

  it("preserves profile order when a profile is disabled and visibly labels it", () => {
    renderDropdown(
      baseDropdownInput({
        profiles: [PERSONAL_DISABLED, WORK, AMBIENT],
        activeProfileId: "work-profile",
      }),
    );

    const profileRows = screen.getAllByRole("menuitem").slice(0, 3);
    expect(profileRows[0]?.textContent).toContain("Personal");
    expect(profileRows[1]?.textContent).toContain("Work");
    expect(profileRows[2]?.textContent).toContain("Terminal account");
    const profileName = within(profileRows[0]).getByText("Personal");
    const disabledLabel = within(profileRows[0]).getByText("Disabled");
    expect(disabledLabel.parentElement).toBe(profileName.parentElement);
    expect(profileName.className).toContain("flex-1");
    expect(profileName.className).toContain("truncate");
  });

  it("keeps selection and enablement as sibling actions", () => {
    const onSelectProfile = vi.fn();
    const onSetProfileEnabled = vi.fn();
    renderDropdown(
      baseDropdownInput({
        onSelectProfile,
        onSetProfileEnabled,
        activeProfileId: null,
      }),
    );

    const workGroup = screen.getByRole("group", {
      name: "Work profile controls",
    });
    const workRow = within(workGroup).getByRole("menuitem", {
      name: "Work",
    });
    const workSwitch = within(workGroup).getByRole("switch", {
      name: "Allow agents to use Work",
    });
    expect(workRow.parentElement).toBe(workGroup);
    expect(workSwitch.parentElement?.parentElement).toBe(workGroup);
    expect(workSwitch.dataset.state).toBe("checked");
    expect(workSwitch.className).toContain("h-[1.15rem]");
    expect(workSwitch.className).toContain("w-8");
    expect(workSwitch.className).toContain("data-[state=checked]:bg-primary");
    fireEvent.click(workSwitch);

    expect(onSetProfileEnabled).toHaveBeenCalledWith("work-profile", false);
    expect(onSelectProfile).not.toHaveBeenCalled();

    fireEvent.click(workRow);
    expect(onSelectProfile).toHaveBeenLastCalledWith("work-profile");
  });

  it("explains enabled and disabled profile availability on the switches", () => {
    renderDropdown(baseDropdownInput({ profiles: [WORK, PERSONAL_DISABLED] }));

    const workSwitch = within(
      screen.getByRole("group", { name: "Work profile controls" }),
    ).getByRole("switch", { name: "Allow agents to use Work" });
    const personalSwitch = within(
      screen.getByRole("group", { name: "Personal profile controls" }),
    ).getByRole("switch", { name: "Allow agents to use Personal" });

    expect(tooltipTextNear(workSwitch)).toBe(
      "Enabled: agents can use this profile.",
    );
    expect(tooltipTextNear(personalSwitch)).toBe(
      "Disabled: agents can’t use this profile.",
    );
  });

  it("keeps a disabled profile selectable for maintenance and its switch operable", () => {
    const onSelectProfile = vi.fn();
    const onSetProfileEnabled = vi.fn();
    renderDropdown(
      baseDropdownInput({
        profiles: [AMBIENT, WORK, PERSONAL_DISABLED],
        activeProfileId: "personal-profile",
        onSelectProfile,
        onSetProfileEnabled,
      }),
    );

    const disabledGroup = screen.getByRole("group", {
      name: "Personal profile controls",
    });
    const disabledRow = within(disabledGroup).getByRole("menuitem", {
      name: /Personal.*Disabled/,
    });
    const disabledSwitch = within(disabledGroup).getByRole("switch", {
      name: "Allow agents to use Personal",
    });
    expect(disabledRow.parentElement).toBe(disabledGroup);
    expect(disabledSwitch.parentElement?.parentElement).toBe(disabledGroup);
    expect(disabledRow.getAttribute("aria-disabled")).toBeNull();
    expect(disabledRow.hasAttribute("disabled")).toBe(false);
    disabledRow.focus();
    expect(document.activeElement).toBe(disabledRow);

    fireEvent.click(disabledRow);
    expect(onSelectProfile).toHaveBeenCalledWith("personal-profile");

    fireEvent.click(disabledSwitch);
    expect(onSetProfileEnabled).toHaveBeenCalledWith("personal-profile", true);
  });

  it("assigns contiguous shortcuts only to enabled profiles", () => {
    const onSelectProfile = vi.fn();
    renderDropdown(
      baseDropdownInput({
        profiles: [AMBIENT, PERSONAL_DISABLED, WORK],
        activeProfileId: null,
        onSelectProfile,
      }),
    );

    expect(screen.getByTestId("model-profile-digit-1")).toBeDefined();
    expect(screen.getByTestId("model-profile-digit-2")).toBeDefined();
    expect(screen.queryByTestId("model-profile-digit-3")).toBeNull();
    expect(
      within(
        screen.getByRole("menuitem", { name: /Personal.*Disabled/ }),
      ).queryByTestId("model-profile-digit-2"),
    ).toBeNull();
  });

  it("keeps only the pending profile guarded until its host mutation settles", () => {
    const onSetProfileEnabled = vi.fn();
    const onSelectProfile = vi.fn();
    renderDropdown(
      baseDropdownInput({
        profileEnablementPending: (profileId) => profileId === "work-profile",
        onSetProfileEnabled,
        onSelectProfile,
      }),
    );

    const workGroup = screen.getByRole("group", {
      name: "Work profile controls",
    });
    const workRow = within(workGroup).getByRole("menuitem", {
      name: /Work.*Updating/,
    });
    const workSwitch = within(workGroup).getByRole("switch", {
      name: "Allow agents to use Work",
    });
    expect(workRow.getAttribute("aria-disabled")).toBe("true");
    expect(workRow.hasAttribute("disabled")).toBe(false);
    fireEvent.click(workRow);
    expect(onSelectProfile).not.toHaveBeenCalled();

    const terminalRow = within(
      screen.getByRole("group", { name: "Terminal account profile controls" }),
    ).getByRole("menuitem", {
      name: "Terminal account, Terminal",
    });
    fireEvent.click(terminalRow);
    expect(onSelectProfile).toHaveBeenCalledWith(null);

    expect(workSwitch.getAttribute("aria-disabled")).toBeNull();
    if (!(workSwitch instanceof HTMLButtonElement)) {
      throw new Error("Expected the profile switch to render as a button.");
    }
    expect(workSwitch.disabled).toBe(true);
    fireEvent.click(workSwitch);
    expect(onSetProfileEnabled).not.toHaveBeenCalled();
  });

  it("does not let a pending profile claim an enabled shortcut", () => {
    renderDropdown(
      baseDropdownInput({
        profileEnablementPending: (profileId) => profileId === "work-profile",
      }),
    );

    expect(
      within(
        screen.getByRole("group", { name: "Work profile controls" }),
      ).queryByTestId("model-profile-digit-2"),
    ).toBeNull();
    expect(
      within(
        screen.getByRole("group", {
          name: "Terminal account profile controls",
        }),
      ).getByTestId("model-profile-digit-1"),
    ).toBeDefined();
  });

  it("keeps picker shortcut indexes aligned when controls are hidden", () => {
    renderDropdown(
      baseDropdownInput({
        profiles: [AMBIENT, WORK, PERSONAL_SIGNED_OUT],
        profileEnablementAvailable: false,
        profileEnablementPending: (profileId) => profileId === "work-profile",
      }),
    );

    expect(
      within(
        screen.getByRole("group", { name: "Work profile controls" }),
      ).queryByTestId("model-profile-digit-2"),
    ).toBeNull();
    expect(
      within(
        screen.getByRole("group", { name: "Personal profile controls" }),
      ).getByTestId("model-profile-digit-2"),
    ).toBeDefined();
  });

  it("blocks a pending profile switch until its host mutation settles", () => {
    const onSetProfileEnabled = vi.fn();
    renderDropdown(
      baseDropdownInput({
        profileEnablementPending: (profileId) => profileId === "work-profile",
        onSetProfileEnabled,
      }),
    );

    const workSwitch = within(
      screen.getByRole("group", { name: "Work profile controls" }),
    ).getByRole("switch", { name: "Allow agents to use Work" });
    expect(workSwitch.getAttribute("aria-disabled")).toBeNull();
    if (!(workSwitch instanceof HTMLButtonElement)) {
      throw new Error("Expected the profile switch to render as a button.");
    }
    expect(workSwitch.disabled).toBe(true);
    fireEvent.click(workSwitch);
    expect(onSetProfileEnabled).not.toHaveBeenCalled();
  });

  it("keeps the final-enabled switch focusable but manually guarded", () => {
    const onSetProfileEnabled = vi.fn();
    const disabledReason = "Enable another profile before disabling this one.";
    renderDropdown(
      baseDropdownInput({
        profileEnablementDisabledReason: (profileId) =>
          profileId === "work-profile" ? disabledReason : null,
        onSetProfileEnabled,
      }),
    );

    const workSwitch = within(
      screen.getByRole("group", { name: "Work profile controls" }),
    ).getByRole("switch", { name: "Allow agents to use Work" });
    expect(workSwitch.getAttribute("aria-disabled")).toBe("true");
    if (!(workSwitch instanceof HTMLButtonElement)) {
      throw new Error("Expected the profile switch to render as a button.");
    }
    expect(workSwitch.disabled).toBe(false);
    expect(tooltipTextNear(workSwitch)).toBe(disabledReason);
    workSwitch.focus();
    expect(document.activeElement).toBe(workSwitch);

    fireEvent.click(workSwitch);
    expect(onSetProfileEnabled).not.toHaveBeenCalled();
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
    expect(
      screen.getByRole("group", { name: "Work profile controls" }).className,
    ).toContain("opacity-60");
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
    expect(
      screen.getByRole("group", { name: "Work profile controls" }).className,
    ).toContain("opacity-60");
    // No reason means no TooltipWrapper - native title also absent.
    expect(tooltipTextNear(blocked)).toBeNull();
  });
});
