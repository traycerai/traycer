import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProfileAvatarBadge } from "@/components/providers/profile-avatar-badge";

describe("<ProfileAvatarBadge />", () => {
  afterEach(() => {
    cleanup();
  });

  it("uses a dark foreground over the profile accent color", () => {
    render(
      <ProfileAvatarBadge
        profileId="work-profile"
        label="Work"
        email="work@example.test"
        accentColor="#38bdf8"
        size="default"
        className={undefined}
      />,
    );

    expect(screen.getByText("WO").classList.contains("text-neutral-950")).toBe(
      true,
    );
  });
});
