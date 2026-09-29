import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState, type KeyboardEvent } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  ProfileDropdown,
  type ProfileDropdownShortcutHint,
} from "@/components/providers/profile-dropdown";
import type { ProfileRowAdmission } from "@/components/providers/provider-profile-model";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";

const PROFILES: ReadonlyArray<ProviderProfile> = [
  {
    profileId: "ambient",
    enabled: true,
    kind: "ambient",
    authType: "oauth",
    label: "Terminal account",
    auth: {
      status: "authenticated",
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
  },
  {
    profileId: "work",
    enabled: true,
    kind: "managed",
    authType: "oauth",
    label: "Work",
    auth: {
      status: "authenticated",
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
  },
];

function noShortcutHint(_index: number): ProfileDropdownShortcutHint | null {
  return null;
}

function NestedPickerSurface() {
  const [pickerOpen, setPickerOpen] = useState(true);
  const [query, setQuery] = useState("opus");
  const [activeModel, setActiveModel] = useState("gpt-5.5");
  const [contentContainer, setContentContainer] =
    useState<HTMLDivElement | null>(null);

  const handlePickerKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "ArrowDown") setActiveModel("gpt-4.1");
    if (event.key === "Escape") setQuery("");
  };

  return (
    <Popover
      open={pickerOpen}
      onOpenChange={(next, details) => {
        if (!next && details.reason === "escape-key" && query.length > 0) {
          details.cancel();
          setQuery("");
          return;
        }
        setPickerOpen(next);
      }}
    >
      <PopoverTrigger render={<button type="button">Open picker</button>} />
      <PopoverContent
        role="dialog"
        aria-label="Select model"
        onKeyDown={handlePickerKeyDown}
      >
        <input
          aria-label="Search models"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span data-testid="active-model">{activeModel}</span>
        <div ref={setContentContainer}>
          {contentContainer === null ? null : (
            <ProfileDropdown
              providerLabel="Claude"
              profiles={PROFILES}
              activeProfileId={null}
              onSelectProfile={vi.fn()}
              onCreateProfile={vi.fn()}
              createProfileDisabled={false}
              createProfileDisabledReason={undefined}
              shortcutHintForIndex={noShortcutHint}
              profileEnablementPending={null}
              contentContainer={contentContainer}
              onCloseAutoFocus={null}
              usagePresentation={null}
              eligibilityControls={null}
              admissionByProfileId={null}
            />
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

describe("nested picker profile-dropdown keyboard ownership", () => {
  afterEach(() => cleanup());

  it("isolates open-menu keys while preserving closed-picker keyboard behavior", async () => {
    render(<NestedPickerSurface />);
    const input = screen.getByRole("textbox", { name: "Search models" });
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("Expected the model search to render as an input.");
    }
    // Base's FloatingFocusManager resolves `initialFocus` via a queued
    // microtask + RAF, not an immediate mount (unlike Radix). Opening the
    // nested Radix menu before that settles races a still-pending focus
    // move onto this popover's own content, which can steal focus back
    // after the menu-item focus below. A real user cannot act before first
    // paint either, so waiting for the popover's genuine initial focus
    // first is the correct fix, not a relaxed expectation.
    await waitFor(() => expect(document.activeElement).toBe(input));

    fireEvent.click(
      screen.getByRole("button", {
        name: "Claude profile: Terminal account, Terminal",
      }),
    );
    const menu = await screen.findByRole("menu");
    const terminalProfile = screen.getByRole("menuitem", {
      name: "Terminal account, Terminal",
    });
    const workProfile = screen.getByRole("menuitem", { name: "Work" });
    terminalProfile.focus();
    expect(document.activeElement).toBe(terminalProfile);

    // The item-level roving-focus handler must still run before the event
    // reaches ProfileDropdown's content boundary and stops bubbling outward.
    fireEvent.keyDown(terminalProfile, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(workProfile));
    expect(screen.getByTestId("active-model").textContent).toBe("gpt-5.5");

    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(input.value).toBe("opus");
    expect(screen.getByRole("dialog", { name: "Select model" })).not.toBeNull();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByTestId("active-model").textContent).toBe("gpt-4.1");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
    expect(screen.getByRole("dialog", { name: "Select model" })).not.toBeNull();
  });
});

const PROFILES_WITH_MIDDLE_DISABLED: ReadonlyArray<ProviderProfile> = [
  {
    profileId: "ambient",
    enabled: true,
    kind: "ambient",
    authType: "oauth",
    label: "Terminal account",
    auth: {
      status: "authenticated",
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
  },
  {
    profileId: "work",
    enabled: true,
    kind: "managed",
    authType: "oauth",
    label: "Work",
    auth: {
      status: "authenticated",
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
  },
  {
    profileId: "personal",
    enabled: true,
    kind: "managed",
    authType: "oauth",
    label: "Personal",
    auth: {
      status: "authenticated",
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
  },
];

const WORK_LOCKED_ADMISSION: ReadonlyMap<string | null, ProfileRowAdmission> =
  new Map([
    [
      "work",
      { disabled: true, reason: "Can't continue this session under Work." },
    ],
  ]);

function OpenProfileDropdownSurface() {
  const [contentContainer, setContentContainer] =
    useState<HTMLDivElement | null>(null);

  return (
    <Popover open onOpenChange={() => undefined}>
      <PopoverTrigger render={<button type="button">Open picker</button>} />
      <PopoverContent role="dialog" aria-label="Select profile">
        <div ref={setContentContainer}>
          {contentContainer === null ? null : (
            <ProfileDropdown
              providerLabel="Claude"
              profiles={PROFILES_WITH_MIDDLE_DISABLED}
              activeProfileId={null}
              onSelectProfile={vi.fn()}
              onCreateProfile={vi.fn()}
              createProfileDisabled={false}
              createProfileDisabledReason={undefined}
              shortcutHintForIndex={noShortcutHint}
              profileEnablementPending={null}
              contentContainer={contentContainer}
              onCloseAutoFocus={null}
              usagePresentation={null}
              eligibilityControls={null}
              admissionByProfileId={WORK_LOCKED_ADMISSION}
            />
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * T5 amend-02 minor: the reviewer's load-bearing gap named the ACTUAL Radix
 * `DropdownMenu` primitive - `terminal-agent-fork-dialog-real-picker.test.tsx`
 * mocks it as native `<button disabled>` elements, which don't reproduce
 * Radix's own roving-tabindex/focus-skip behavior for a disabled item. This
 * drives the real, unmocked primitive (mirrors the suite above).
 */
describe("real Base DropdownMenu: disabled-row roving focus and dismissal", () => {
  afterEach(() => cleanup());

  it("ArrowDown roving focus reaches a disabled row without activating it, and Escape still dismisses the menu", async () => {
    render(<OpenProfileDropdownSurface />);
    const trigger = screen.getByRole("button", {
      name: "Claude profile: Terminal account, Terminal",
    });
    // Same reasoning as the nested-picker test above: wait for the Popover's
    // own deferred initial focus (Base's FloatingFocusManager, queued via a
    // microtask + RAF) to land on its first focusable descendant before
    // opening the nested Radix menu on top of it.
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu");
    const terminalProfile = screen.getByRole("menuitem", {
      name: "Terminal account, Terminal",
    });
    const workProfile = screen.getByRole("menuitem", {
      name: /Work.*Can't continue this session under Work\./,
    });
    const personalProfile = screen.getByRole("menuitem", { name: "Personal" });
    expect(workProfile.getAttribute("aria-disabled")).toBe("true");
    // amend-02 a11y fix: the reason must also be static, always-visible text
    // inside the row - roving focus never lands on this item, so anything
    // gated on focus/hover (the aria-label, the tooltip) never reaches
    // keyboard/AT users.
    expect(
      within(workProfile).getByText("Can't continue this session under Work."),
    ).not.toBeNull();

    terminalProfile.focus();
    expect(document.activeElement).toBe(terminalProfile);

    // Base keeps an aria-disabled row in the roving order so its reason can be
    // heard, but it can never be activated: focus lands on Work, Enter on it
    // leaves the menu open, and the next ArrowDown reaches Personal.
    fireEvent.keyDown(terminalProfile, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(workProfile));
    fireEvent.keyDown(workProfile, { key: "Enter" });
    expect(screen.getByRole("menu")).toBe(menu);

    fireEvent.keyDown(workProfile, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(personalProfile));

    // Reverse direction: ArrowUp from Personal walks back through Work.
    fireEvent.keyDown(personalProfile, { key: "ArrowUp" });
    await waitFor(() => expect(document.activeElement).toBe(workProfile));

    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});
