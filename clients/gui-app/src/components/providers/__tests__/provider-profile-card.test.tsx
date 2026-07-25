import "../../../../__tests__/test-browser-apis";
import {
  PROVIDER_PROFILE_ACCENT_COLORS,
  type ProviderProfile,
  type ProviderProfileAccentColor,
} from "@traycer/protocol/host/provider-schemas";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderProfileCard } from "@/components/providers/provider-profile-card";

const AMBIENT_COLOR = PROVIDER_PROFILE_ACCENT_COLORS[0];
const MANAGED_COLOR = PROVIDER_PROFILE_ACCENT_COLORS[2];

function profile(
  profileId: string,
  kind: ProviderProfile["kind"],
  label: string,
  accentColor: ProviderProfileAccentColor,
): ProviderProfile {
  return {
    profileId,
    kind,
    authType: "oauth",
    label,
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
    accentColor,
    ambientDriftNotice: null,
  };
}

const AMBIENT = profile(
  "ambient",
  "ambient",
  "Terminal account",
  AMBIENT_COLOR,
);
const WORK = profile("work-profile", "managed", "Work", MANAGED_COLOR);

describe("<ProviderProfileCard />", () => {
  afterEach(() => cleanup());

  it("renders one always-editable name field without a second pencil action", () => {
    const onLabelChange = vi.fn();
    render(
      <ProviderProfileCard
        profile={AMBIENT}
        profiles={[AMBIENT, WORK]}
        label="Terminal account"
        onLabelChange={onLabelChange}
        selectedColor={AMBIENT_COLOR}
        onSelectColor={vi.fn()}
        disabled={false}
      />,
    );

    fireEvent.change(screen.getByLabelText("Profile name"), {
      target: { value: "Default" },
    });

    expect(onLabelChange).toHaveBeenCalledWith("Default");
    expect(screen.queryByRole("button", { name: /Edit name/ })).toBeNull();
  });

  it("selects an accent color through the controlled form", () => {
    const onSelectColor = vi.fn();
    render(
      <ProviderProfileCard
        profile={AMBIENT}
        profiles={[AMBIENT, WORK]}
        label="Terminal account"
        onLabelChange={vi.fn()}
        selectedColor={AMBIENT_COLOR}
        onSelectColor={onSelectColor}
        disabled={false}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: `Use color ${MANAGED_COLOR}` }),
    );
    expect(onSelectColor).toHaveBeenCalledWith(MANAGED_COLOR);
  });

  it("warns when another profile already uses the selected color", () => {
    render(
      <ProviderProfileCard
        profile={WORK}
        profiles={[AMBIENT, WORK]}
        label="Work"
        onLabelChange={vi.fn()}
        selectedColor={AMBIENT_COLOR}
        onSelectColor={vi.fn()}
        disabled={false}
      />,
    );

    expect(
      screen.getByText(/Terminal account already uses this color/),
    ).toBeDefined();
  });

  it("disables form controls while changes are saving", () => {
    render(
      <ProviderProfileCard
        profile={AMBIENT}
        profiles={[AMBIENT, WORK]}
        label="Terminal account"
        onLabelChange={vi.fn()}
        selectedColor={AMBIENT_COLOR}
        onSelectColor={vi.fn()}
        disabled
      />,
    );

    const nameInput = screen.getByLabelText("Profile name");
    const colorButton = screen.getByRole("button", {
      name: `Use color ${MANAGED_COLOR}`,
    });
    if (
      !(nameInput instanceof HTMLInputElement) ||
      !(colorButton instanceof HTMLButtonElement)
    ) {
      throw new Error("Expected disabled profile form controls.");
    }
    expect(nameInput.disabled).toBe(true);
    expect(colorButton.disabled).toBe(true);
  });
});
