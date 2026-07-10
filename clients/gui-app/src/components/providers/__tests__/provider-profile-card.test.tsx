import "../../../../__tests__/test-browser-apis";
import {
  PROVIDER_PROFILE_ACCENT_COLORS,
  type ProviderCliState,
  type ProviderProfile,
  type ProviderProfileAccentColor,
} from "@traycer/protocol/host/provider-schemas";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

type RenameProfileVariables = {
  readonly providerId: ProviderCliState["providerId"];
  readonly profileId: string;
  readonly label: string;
};

type RecolorProfileVariables = {
  readonly providerId: ProviderCliState["providerId"];
  readonly profileId: string;
  readonly accentColor: ProviderProfileAccentColor;
};

type MutationSuccessOptions = {
  readonly onSuccess: () => void;
};

type RecolorMutationOptions = {
  readonly onSuccess: () => void;
  readonly onError: () => void;
};

type RenameProfileMutate = (
  variables: RenameProfileVariables,
  options: MutationSuccessOptions,
) => void;

type RecolorProfileMutate = (
  variables: RecolorProfileVariables,
  options: RecolorMutationOptions,
) => void;

const mutationMocks = vi.hoisted(() => ({
  renameProfileMutate: vi.fn<RenameProfileMutate>(),
  recolorProfileMutate: vi.fn<RecolorProfileMutate>(),
}));

vi.mock("@/hooks/providers/use-rename-provider-profile-mutation", () => ({
  useRenameProviderProfile: () => ({
    mutate: mutationMocks.renameProfileMutate,
    isPending: false,
    error: null,
  }),
}));

vi.mock("@/hooks/providers/use-recolor-provider-profile-mutation", () => ({
  useRecolorProviderProfile: () => ({
    mutate: mutationMocks.recolorProfileMutate,
    isPending: false,
    error: null,
  }),
}));

import { ProviderProfileCard } from "@/components/providers/provider-profile-card";

const AMBIENT_COLOR = PROVIDER_PROFILE_ACCENT_COLORS[0];
const MANAGED_COLOR = PROVIDER_PROFILE_ACCENT_COLORS[2];

const AUTHENTICATED_AUTH: ProviderProfile["auth"] = {
  status: "authenticated",
  badgeText: null,
  label: null,
  detail: null,
};

function ambientProfile(
  accentColor: ProviderProfileAccentColor,
): ProviderProfile {
  return {
    profileId: "ambient",
    kind: "ambient",
    authType: "oauth",
    label: "Terminal account",
    auth: AUTHENTICATED_AUTH,
    identity: {
      accountUuid: "ambient-account",
      email: "terminal@example.com",
      tier: "Pro",
    },
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    duplicateOfProfileId: null,
    accentColor,
    ambientDriftNotice: null,
  };
}

function managedProfile(
  profileId: string,
  label: string,
  accentColor: ProviderProfileAccentColor,
): ProviderProfile {
  return {
    profileId,
    kind: "managed",
    authType: "oauth",
    label,
    auth: AUTHENTICATED_AUTH,
    identity: {
      accountUuid: `${profileId}-account`,
      email: `${label.toLowerCase()}@example.com`,
      tier: "Team",
    },
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    duplicateOfProfileId: null,
    accentColor,
    ambientDriftNotice: null,
  };
}

describe("<ProviderProfileCard />", () => {
  afterEach(() => {
    mutationMocks.renameProfileMutate.mockReset();
    mutationMocks.recolorProfileMutate.mockReset();
    cleanup();
  });

  it("warns when a managed profile uses the Terminal account color", () => {
    const ambient = ambientProfile(AMBIENT_COLOR);
    const work = managedProfile("work-profile", "Work", AMBIENT_COLOR);

    const { container } = render(
      <ProviderProfileCard
        providerId="codex"
        profile={work}
        profiles={[ambient, work]}
      />,
    );

    expect(
      screen.getByText(/Terminal account already uses this color/),
    ).toBeDefined();
    expect(container.firstElementChild?.className).toContain("w-full");

    const swatches = PROVIDER_PROFILE_ACCENT_COLORS.map((accentColor) =>
      screen.getByRole("button", { name: `Use color ${accentColor}` }),
    );
    expect(swatches).toHaveLength(12);
    expect(swatches.at(0)?.className).toContain("rounded-full");
    expect(swatches.at(0)?.className).toContain("size-6");
    expect(
      swatches.at(0)?.querySelector("svg")?.getAttribute("class"),
    ).toContain("size-3");
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Edit name for Work" }),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Save name for Work" }),
    ).toBeNull();
  });

  it("keeps the Terminal account read-only", () => {
    const ambient = ambientProfile(AMBIENT_COLOR);
    const work = managedProfile("work-profile", "Work", MANAGED_COLOR);

    render(
      <ProviderProfileCard
        providerId="codex"
        profile={ambient}
        profiles={[ambient, work]}
      />,
    );

    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(
      screen.getByText(/Rename, recolor, and remove are unavailable here/),
    ).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", { name: `Use color ${MANAGED_COLOR}` }),
    );

    expect(mutationMocks.renameProfileMutate).not.toHaveBeenCalled();
    expect(mutationMocks.recolorProfileMutate).not.toHaveBeenCalled();
  });

  it("preserves an unsaved typed name across a reactive accent-color change (recolor mid-rename)", () => {
    const ambient = ambientProfile(AMBIENT_COLOR);
    const work = managedProfile("work-profile", "Work", MANAGED_COLOR);
    const recolored = managedProfile(
      "work-profile",
      "Work",
      PROVIDER_PROFILE_ACCENT_COLORS[4],
    );

    const { rerender } = render(
      <ProviderProfileCard
        providerId="codex"
        profile={work}
        profiles={[ambient, work]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit name for Work" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Local draft" },
    });

    // Simulate the recolor mutation's refetch landing while still mid-rename
    // - same profileId, only accentColor changed on the wire.
    rerender(
      <ProviderProfileCard
        providerId="codex"
        profile={recolored}
        profiles={[ambient, recolored]}
      />,
    );

    expect(screen.getByDisplayValue("Local draft")).toBeDefined();
    expect(
      screen
        .getByRole("button", {
          name: `Use color ${PROVIDER_PROFILE_ACCENT_COLORS[4]}`,
        })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("resets the draft when the card switches to a different profile", () => {
    const ambient = ambientProfile(AMBIENT_COLOR);
    const work = managedProfile("work-profile", "Work", MANAGED_COLOR);
    const personal = managedProfile(
      "personal-profile",
      "Personal",
      PROVIDER_PROFILE_ACCENT_COLORS[4],
    );

    const { rerender } = render(
      <ProviderProfileCard
        providerId="codex"
        profile={work}
        profiles={[ambient, work, personal]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit name for Work" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Local draft" },
    });

    rerender(
      <ProviderProfileCard
        providerId="codex"
        profile={personal}
        profiles={[ambient, work, personal]}
      />,
    );

    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Edit name for Personal" }),
    ).toBeDefined();
    expect(
      screen
        .getByRole("button", {
          name: `Use color ${PROVIDER_PROFILE_ACCENT_COLORS[4]}`,
        })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("keeps the typed name when a different accent swatch is clicked mid-edit", () => {
    const ambient = ambientProfile(AMBIENT_COLOR);
    const work = managedProfile("work-profile", "Work", MANAGED_COLOR);

    render(
      <ProviderProfileCard
        providerId="codex"
        profile={work}
        profiles={[ambient, work]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit name for Work" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Local draft" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: `Use color ${PROVIDER_PROFILE_ACCENT_COLORS[4]}`,
      }),
    );

    expect(screen.getByDisplayValue("Local draft")).toBeDefined();
    expect(mutationMocks.recolorProfileMutate).toHaveBeenCalledTimes(1);
    expect(
      screen
        .getByRole("button", {
          name: `Use color ${PROVIDER_PROFILE_ACCENT_COLORS[4]}`,
        })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("edits the managed profile name only after the pencil action", () => {
    const ambient = ambientProfile(AMBIENT_COLOR);
    const work = managedProfile("work-profile", "Work", MANAGED_COLOR);

    render(
      <ProviderProfileCard
        providerId="codex"
        profile={work}
        profiles={[ambient, work]}
      />,
    );

    expect(screen.queryByLabelText("Name")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit name for Work" }));
    expect(screen.getByLabelText("Name").className).toContain("22rem");
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Personal" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name for Work" }));

    expect(mutationMocks.renameProfileMutate).toHaveBeenCalledTimes(1);
    const [variables, options] =
      mutationMocks.renameProfileMutate.mock.calls[0];
    expect(variables).toEqual({
      providerId: "codex",
      profileId: "work-profile",
      label: "Personal",
    });
    expect(typeof options.onSuccess).toBe("function");
  });

  it("cancels profile name editing without saving the draft", () => {
    const ambient = ambientProfile(AMBIENT_COLOR);
    const work = managedProfile("work-profile", "Work", MANAGED_COLOR);

    render(
      <ProviderProfileCard
        providerId="codex"
        profile={work}
        profiles={[ambient, work]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit name for Work" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Personal" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel editing name for Work" }),
    );

    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Edit name for Work" }),
    ).toBeDefined();
    expect(mutationMocks.renameProfileMutate).not.toHaveBeenCalled();
  });

  it("reverts the optimistic accent color when the recolor mutation fails", () => {
    const ambient = ambientProfile(AMBIENT_COLOR);
    const work = managedProfile("work-profile", "Work", MANAGED_COLOR);
    const attemptedColor = PROVIDER_PROFILE_ACCENT_COLORS[4];

    render(
      <ProviderProfileCard
        providerId="codex"
        profile={work}
        profiles={[ambient, work]}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: `Use color ${attemptedColor}` }),
    );

    expect(mutationMocks.recolorProfileMutate).toHaveBeenCalledTimes(1);
    const [, options] = mutationMocks.recolorProfileMutate.mock.calls[0];
    act(() => {
      options.onError();
    });

    expect(
      screen
        .getByRole("button", { name: `Use color ${attemptedColor}` })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      screen
        .getByRole("button", { name: `Use color ${MANAGED_COLOR}` })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
