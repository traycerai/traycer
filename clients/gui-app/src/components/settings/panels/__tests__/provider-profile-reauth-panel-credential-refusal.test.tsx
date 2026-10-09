import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * The reauth panel starts a sign-in on mount (a deep link, "Sign in", "Switch
 * account" all land here). On a host that takes no credentials it must start
 * nothing, say why, and offer the way back.
 */

const mocks = vi.hoisted(() => ({
  startLoginAsync: vi.fn(),
  awaitLoginMutate: vi.fn(),
  cancelLoginMutate: vi.fn(),
  /** What `useHostCredentialRefusal` answers; `null` is a host that takes sign-ins. */
  credentialRefusal: null as string | null,
}));

vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => mocks.credentialRefusal,
}));
vi.mock("@/hooks/providers/use-providers-login-ownership", () => ({
  useProvidersLoginOwnership: () => false,
}));
vi.mock("@/hooks/providers/use-providers-start-login-mutation", () => ({
  useProvidersStartLogin: () => ({
    mutateAsync: (variables: unknown) => {
      mocks.startLoginAsync(variables);
      return new Promise<never>(() => undefined);
    },
    isPending: false,
    error: null,
  }),
}));
vi.mock("@/hooks/providers/use-providers-await-login-mutation", () => ({
  useHostScopedProvidersAwaitLogin: () => ({
    mutate: mocks.awaitLoginMutate,
    isPending: false,
    error: null,
  }),
}));
vi.mock("@/hooks/providers/use-providers-cancel-login-mutation", () => ({
  useProvidersCancelLogin: () => ({
    mutate: mocks.cancelLoginMutate,
    mutateAsync: () => Promise.resolve({ cancelled: true }),
    isPending: false,
  }),
}));
vi.mock("@/hooks/providers/use-providers-submit-login-code-mutation", () => ({
  useProvidersSubmitLoginCode: () => ({
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    data: undefined,
    error: null,
    reset: vi.fn(),
  }),
}));
vi.mock("@/hooks/providers/use-providers-touch-login-mutation", () => ({
  useProvidersTouchLogin: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
    reset: vi.fn(),
  }),
}));
vi.mock("@/hooks/providers/use-providers-ensure-pack-mutation", () => ({
  useProvidersEnsurePack: () => ({
    mutate: vi.fn(),
    mutateAsync: () => Promise.resolve({}),
    isPending: false,
    error: null,
  }),
}));
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => vi.fn() }));

import { ProviderProfileReauthPanel } from "@/components/settings/panels/provider-profile-reauth-panel";

const REFUSAL = "Sandboxes don't take sign-ins";

function managedProfile(): ProviderProfile {
  return {
    profileId: "profile-managed",
    enabled: true,
    kind: "managed",
    authType: "oauth",
    label: "Work account",
    auth: {
      status: "unauthenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: { email: null, tier: null, accountUuid: null },
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

function codexState(profile: ProviderProfile): ProviderCliState {
  return {
    providerId: "codex",
    enabled: true,
    disabledBy: null,
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
    selected: { kind: "bundled" },
    candidates: [],
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: {
      oauthArgs: ["auth", "login"],
      token: null,
      codePaste: null,
      terminalLogin: null,
      remoteSafe: null,
      selfOpensBrowser: null,
    },
    availabilityPending: false,
    profiles: [profile],
  };
}

function renderPanel(onCancel: () => void) {
  const profile = managedProfile();
  return render(
    <TooltipProvider>
      <ProviderProfileReauthPanel
        state={codexState(profile)}
        profile={profile}
        isLocalHost
        onSameAccountReconnected={null}
        onCancel={onCancel}
        onDone={() => undefined}
      />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.credentialRefusal = null;
});

describe("<ProviderProfileReauthPanel /> on a host that takes no credentials", () => {
  it("starts no sign-in on mount, shows the refusal and a Back button that cancels", () => {
    mocks.credentialRefusal = REFUSAL;
    const onCancel = vi.fn();
    renderPanel(onCancel);

    expect(mocks.startLoginAsync).not.toHaveBeenCalled();
    expect(screen.getByTestId("credential-refusal").textContent).toBe(REFUSAL);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(mocks.startLoginAsync).not.toHaveBeenCalled();
  });

  it("control: on a host that takes sign-ins the panel starts the sign-in on mount and shows no refusal", () => {
    renderPanel(vi.fn());

    expect(mocks.startLoginAsync).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("credential-refusal")).toBeNull();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });
});
