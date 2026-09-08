import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProvidersSetProfileOwnershipRequest } from "@traycer/protocol/host/provider-profile-config-schemas";
import { CategoryOwnershipToggle } from "@/components/settings/panels/category-ownership-toggle";

const mocks = vi.hoisted(() => ({
  supportsMethod: true,
  mutate:
    vi.fn<
      (
        variables: ProvidersSetProfileOwnershipRequest,
        options?: { onSuccess?: () => void },
      ) => void
    >(),
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => mocks.supportsMethod,
}));

vi.mock(
  "@/hooks/providers/use-providers-set-profile-ownership-mutation",
  () => ({
    useProvidersSetProfileOwnership: () => ({
      mutate: mocks.mutate,
      isPending: false,
    }),
  }),
);

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  mocks.supportsMethod = true;
  mocks.mutate.mockReset();
});

describe("CategoryOwnershipToggle", () => {
  it("Linked: 'Make its own copy' fires setProfileOwnership with ownership own, no confirmation", () => {
    render(
      <CategoryOwnershipToggle
        hostId="host-1"
        providerId="codex"
        profileId="profile-a"
        category="skills"
        ownership="linked"
        entryCount={0}
      />,
    );

    expect(
      screen.getByText(/Linked to the Default account's skills/),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Make its own copy" }));

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate.mock.calls[0]?.[0]).toEqual({
      providerId: "codex",
      profileId: "profile-a",
      category: "skills",
      ownership: "own",
    });
    // No confirm dialog anywhere in the DOM for the Linked -> Own direction.
    expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
  });

  it("Own: 'Link to Default account' opens a confirmation naming the entry count; the RPC fires only after confirming", () => {
    render(
      <CategoryOwnershipToggle
        hostId="host-1"
        providerId="codex"
        profileId="profile-a"
        category="plugins"
        ownership="own"
        entryCount={8}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Link to Default account" }),
    );

    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(
      screen.getByText(/This profile's 8 own plugins are deleted/),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Discard 8 plugins and link" }),
    ).not.toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Discard 8 plugins and link" }),
    );

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate.mock.calls[0]?.[0]).toEqual({
      providerId: "codex",
      profileId: "profile-a",
      category: "plugins",
      ownership: "linked",
    });
  });

  it("does not render for the Default account (profileId null)", () => {
    render(
      <CategoryOwnershipToggle
        hostId="host-1"
        providerId="codex"
        profileId={null}
        category="skills"
        ownership="own"
        entryCount={3}
      />,
    );

    expect(screen.queryByText(/skills/)).toBeNull();
  });

  it("does not render when the host manifest omits providers.setProfileOwnership", () => {
    mocks.supportsMethod = false;
    render(
      <CategoryOwnershipToggle
        hostId="host-1"
        providerId="codex"
        profileId="profile-a"
        category="skills"
        ownership="own"
        entryCount={3}
      />,
    );

    expect(screen.queryByText(/skills/)).toBeNull();
  });
});
