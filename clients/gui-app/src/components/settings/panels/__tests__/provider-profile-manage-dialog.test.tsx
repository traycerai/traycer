import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";

/**
 * W2-T14 item 1: Manage (`ProfileEditDialog`) reuses today's rename / recolor
 * / enable-disable / remove, and its "Switch account" entry now routes to the
 * Account tab through the focus store's `startSignIn` intent instead of
 * mounting a second `ProviderProfileReauthPanel` inside this dialog (that
 * panel is the Account tab's own oauth arm since W2-T10). The tooltip on a
 * disabled Switch-account button is the mode-aware
 * `providerSignInUnavailableHint`, not the old hardcoded local-host sentence.
 */

const mutateMocks = vi.hoisted(() => ({
  rename: vi.fn(),
  recolor: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/hooks/providers/use-rename-provider-profile-mutation", () => ({
  useRenameProviderProfile: () => ({
    mutate: mutateMocks.rename,
    isPending: false,
    error: null,
  }),
}));
vi.mock("@/hooks/providers/use-recolor-provider-profile-mutation", () => ({
  useRecolorProviderProfile: () => ({
    mutate: mutateMocks.recolor,
    isPending: false,
    error: null,
  }),
}));
vi.mock("@/hooks/providers/use-remove-provider-profile-mutation", () => ({
  useRemoveProviderProfile: () => ({
    mutate: mutateMocks.remove,
    isPending: false,
    error: null,
  }),
}));

import { ProfileEditDialog } from "../provider-profile-edit-dialog";
import { providerProfileFixture } from "@/testing/provider-profile-fixture";

const HOST_ID = "host-a";

function claudeState(
  loginCapability: ProviderCliState["loginCapability"],
): ProviderCliState {
  return {
    providerId: "claude-code",
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability,
    availabilityPending: false,
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
      modelProviders: null,
    },
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles: [],
    profilesSupported: true,
  };
}

function managedProfile(): ProviderProfile {
  return providerProfileFixture({
    profileId: "m1",
    enabled: true,
    kind: "managed",
    authType: "oauth",
    label: "Managed One",
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: { email: "m1@example.test", tier: null, accountUuid: null },
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  });
}

function renderDialog(overrides: {
  readonly canOauth: boolean;
  readonly state: ProviderCliState;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const profile = managedProfile();
  return render(
    <TooltipProvider>
      <ProfileEditDialog
        state={overrides.state}
        profile={profile}
        profiles={[profile]}
        hostId={HOST_ID}
        isSelectedHostLocal
        canOauth={overrides.canOauth}
        startInReauth={false}
        open
        onOpenChange={overrides.onOpenChange}
        remainingProfilesAfterRemoval={[]}
        onSelectedProfileIdChange={() => {}}
        profileEnablementAvailable
        profileEnablementPending={() => false}
        onSetProfileEnabled={() => {}}
      />
    </TooltipProvider>,
  );
}

const NO_TERMINAL_LOGIN_CAPABILITY: ProviderCliState["loginCapability"] = {
  oauthArgs: ["login"],
  token: null,
  codePaste: null,
  terminalLogin: null,
};

beforeEach(() => {
  useProvidersFocusStore.setState({
    focusHarnessId: null,
    focusHostId: null,
    focusTargetHostId: null,
    focusProfileId: null,
    startSignIn: false,
    focusTab: null,
  });
  mutateMocks.rename.mockClear();
  mutateMocks.recolor.mockClear();
  mutateMocks.remove.mockClear();
});
afterEach(() => cleanup());

describe("ProfileEditDialog (Manage)", () => {
  it("exposes rename, recolor, enable/disable, remove (with confirmation), and Switch account", () => {
    renderDialog({
      canOauth: true,
      state: claudeState(NO_TERMINAL_LOGIN_CAPABILITY),
      onOpenChange: () => {},
    });

    const profileName = screen.getByLabelText(
      "Profile name",
    ) as HTMLInputElement;
    expect(profileName.value).toBe("Managed One");
    expect(screen.getByText("Accent color")).not.toBeNull();
    expect(
      screen.getByRole("switch", { name: "Allow agents to use Managed One" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Switch account" }),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove profile" }));
    expect(screen.getByText("Remove Managed One?")).not.toBeNull();
  });

  it("Switch account arms the focus store with startSignIn: true for that profile and does not mount a second reauth panel inside the dialog", () => {
    const onOpenChange = vi.fn();
    renderDialog({
      canOauth: true,
      state: claudeState(NO_TERMINAL_LOGIN_CAPABILITY),
      onOpenChange,
    });

    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));

    expect(useProvidersFocusStore.getState()).toMatchObject({
      focusHarnessId: "claude",
      focusHostId: HOST_ID,
      focusTargetHostId: HOST_ID,
      focusProfileId: "m1",
      startSignIn: true,
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // The Account tab's own oauth arm owns `ProviderProfileReauthPanel` now -
    // this dialog must never mount a second copy of it.
    expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull();
  });

  it("the Switch-account tooltip is the mode-aware hint, not the hardcoded local-host sentence", () => {
    renderDialog({
      canOauth: false,
      state: claudeState({
        oauthArgs: null,
        token: null,
        codePaste: null,
        terminalLogin: {},
      }),
      onOpenChange: () => {},
    });

    const button = screen.getByRole("button", { name: "Switch account" });
    // The tooltip trigger (`TooltipTrigger asChild`) is the wrapping `<span>`,
    // not the disabled `<button>` itself - the same shape the Remove-profile
    // button's own tooltip uses, so a disabled action can still explain why.
    fireEvent.focus(button.parentElement ?? button);
    const tooltips = screen.getAllByRole("tooltip").map((el) => el.textContent);
    expect(
      tooltips.some(
        (text) =>
          text ===
          "Claude Code is signed in from a terminal. Use the sign-in option in the chat composer.",
      ),
    ).toBe(true);
    expect(
      tooltips.some((text) =>
        text.includes("requires a local host with browser sign-in"),
      ),
    ).toBe(false);
  });
});
