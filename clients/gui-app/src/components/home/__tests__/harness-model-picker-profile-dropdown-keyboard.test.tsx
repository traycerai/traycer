import "../../../../__tests__/test-browser-apis";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";

const PROFILES: ReadonlyArray<ProviderProfile> = [
  {
    profileId: "ambient",
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
    <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
      <PopoverTrigger asChild>
        <button type="button">Open picker</button>
      </PopoverTrigger>
      <PopoverContent
        role="dialog"
        aria-label="Select model"
        onKeyDown={handlePickerKeyDown}
        onEscapeKeyDown={(event) => {
          if (query.length === 0) return;
          event.preventDefault();
          setQuery("");
        }}
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
              contentContainer={contentContainer}
              onCloseAutoFocus={null}
              usagePresentation={null}
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

    fireEvent.pointerDown(
      screen.getByRole("button", {
        name: "Claude profile: Terminal account, Terminal",
      }),
      { button: 0, ctrlKey: false },
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
