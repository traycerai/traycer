import { Fragment, StrictMode, type ReactNode } from "react";
import type {
  ProviderCliState,
  ProviderLoginRefusal,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { TooltipProvider } from "@/components/ui/tooltip";

// The whole point of this suite is the REAL mutation stack: `useMutation`'s
// observer, the host-scoped hook's own `onError` toast, and the login flow on
// top of it. Only the host transport is faked. The sibling suites fake the
// start-login hook itself, and a fake `mutate` that calls its per-call
// `onError` synchronously can never show what went wrong here - TanStack
// dropping that callback while its own mutation-level toast still fires.
const host = vi.hoisted(() => ({
  request: vi.fn<(method: string, params: unknown) => Promise<unknown>>(),
  requestWithResponseTimeout:
    vi.fn<(method: string, params: unknown) => Promise<unknown>>(),
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  const client = Object.assign({} as HostClient<HostRpcRegistry>, {
    getActiveHostId: () => "host-local",
    request: host.request,
    requestWithSignal: host.request,
    requestWithResponseTimeout: host.requestWithResponseTimeout,
  });
  return { ...actual, useHostClient: () => client };
});
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/hooks/providers/use-refresh-providers", () => ({
  useRefreshProviders: () => () => Promise.resolve(),
}));
// A spy, so a test can see which link a button sent the user to.
const links = vi.hoisted(() => ({
  openLink: vi.fn<(url: string, kind: string, event: unknown) => unknown>(),
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => links.openLink,
}));
vi.mock("@/lib/host-error-toast", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/host-error-toast")>();
  return { ...actual, toastFromHostError: vi.fn() };
});

import { toastFromHostError } from "@/lib/host-error-toast";
import { ProfileEditDialog } from "@/components/settings/panels/provider-profile-edit-dialog";
import { AddProviderProfileDialog } from "@/components/settings/panels/add-provider-profile-dialog";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";

const PROVIDER_ID = "claude-code";
const PROFILE_ID = "profile-surya-2";

function signedOutProfile(): ProviderProfile {
  return {
    profileId: PROFILE_ID,
    enabled: true,
    kind: "managed",
    authType: "oauth",
    label: "Surya 2",
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

function claudeState(profile: ProviderProfile): ProviderCliState {
  return {
    providerId: PROVIDER_ID,
    enabled: true,
    disabledBy: null,
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "unauthenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles: [profile],
  };
}

function refusal(): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: "Refused to start the login",
    requestId: "req-start-login",
    method: "providers.startLogin",
    fatalDetails: null,
  });
}

/** The desktop renderer mounts under `<StrictMode>`, so the dev builds a
 *  sign-in is driven in run every mount effect setup -> cleanup -> setup.
 *  Production runs it once; both have to settle. */
const MOUNT_MODES = [
  { name: "under StrictMode", Wrapper: StrictMode },
  { name: "without StrictMode", Wrapper: Fragment },
] as const;

function renderSignInDialog(
  Wrapper: (props: { readonly children: ReactNode }) => ReactNode,
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const profile = signedOutProfile();
  return render(
    <Wrapper>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileEditDialog
            state={claudeState(profile)}
            profile={profile}
            profiles={[profile]}
            canOauth
            oauthUnavailableHint={null}
            startInReauth
            isLocalHost
            open
            onOpenChange={() => undefined}
            remainingProfilesAfterRemoval={[]}
            onSelectedProfileIdChange={() => undefined}
            profileEnablementAvailable
            profileEnablementPending={() => false}
            onSetProfileEnabled={() => undefined}
          />
        </TooltipProvider>
      </QueryClientProvider>
    </Wrapper>,
  );
}

function authenticatedAmbientProfile(): ProviderProfile {
  return {
    ...signedOutProfile(),
    profileId: "ambient",
    kind: "ambient",
    label: "Terminal account",
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: { email: "before@example.test", tier: null, accountUuid: null },
  };
}

function renderSwitchAccountDialog(profile: ProviderProfile) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const dialog = (currentProfile: ProviderProfile): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ProfileEditDialog
          state={claudeState(currentProfile)}
          profile={currentProfile}
          profiles={[currentProfile]}
          canOauth
          oauthUnavailableHint={null}
          startInReauth={false}
          isLocalHost
          open
          onOpenChange={() => undefined}
          remainingProfilesAfterRemoval={[]}
          onSelectedProfileIdChange={() => undefined}
          profileEnablementAvailable
          profileEnablementPending={() => false}
          onSetProfileEnabled={() => undefined}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
  const rendered = render(dialog(profile));
  return {
    rerender: (refreshedProfile: ProviderProfile): void => {
      rendered.rerender(dialog(refreshedProfile));
    },
  };
}

function startLoginCalls(): number {
  return host.request.mock.calls.filter(
    ([method]) => method === "providers.startLogin",
  ).length;
}

beforeEach(() => {
  host.request.mockImplementation((method) =>
    method === "providers.startLogin"
      ? Promise.reject(refusal())
      : Promise.resolve({}),
  );
  // The long-poll that follows a started login: it stays open for the whole
  // browser leg, which is exactly the state a started sign-in should show.
  host.requestWithResponseTimeout.mockImplementation(
    () => new Promise<unknown>(() => undefined),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe.each(MOUNT_MODES)(
  "the 'Sign in to <profile>' dialog $name",
  ({ Wrapper }) => {
    it("leaves 'Opening the sign-in page…' when providers.startLogin is refused", async () => {
      renderSignInDialog(Wrapper);

      expect(
        screen.getByRole("heading", { name: "Sign in to Surya 2" }),
      ).toBeTruthy();
      expect(screen.getByText("Opening the sign-in page…")).toBeTruthy();

      // The hook's own toast, once. This is the half that always worked: it
      // runs from the mutation's own options, not the observer's.
      await waitFor(() => expect(toastFromHostError).toHaveBeenCalledTimes(1));
      expect(toastFromHostError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "RPC_ERROR" }),
        "Couldn't start the sign-in flow.",
      );

      // The dialog follows it: the refusal is said inline, the pending step
      // is gone, and the retry is live - not a spinner outliving the toast.
      expect(
        await screen.findByText("Sign-in did not start. Try again when ready."),
      ).toBeTruthy();
      expect(screen.queryByText("Opening the sign-in page…")).toBeNull();
      const retry = screen.getByRole("button", { name: "Retry" });
      expect(retry.hasAttribute("disabled")).toBe(false);
      expect(startLoginCalls()).toBe(1);
    });

    it("sends a fresh providers.startLogin from Retry after a refusal", async () => {
      renderSignInDialog(Wrapper);
      await screen.findByText("Sign-in did not start. Try again when ready.");

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));

      await waitFor(() => expect(startLoginCalls()).toBe(2));
      // Refused again: the dialog settles again rather than sticking.
      await waitFor(() => expect(toastFromHostError).toHaveBeenCalledTimes(2));
      expect(
        await screen.findByText("Sign-in did not start. Try again when ready."),
      ).toBeTruthy();
      expect(screen.queryByText("Opening the sign-in page…")).toBeNull();
    });

    it("moves on to the browser step when providers.startLogin starts the login", async () => {
      host.request.mockImplementation((method) =>
        method === "providers.startLogin"
          ? Promise.resolve({
              url: "https://claude.test/oauth",
              started: true,
              profileId: PROFILE_ID,
              userCode: null,
            })
          : Promise.resolve({}),
      );
      renderSignInDialog(Wrapper);

      expect(
        await screen.findByText("Approve sign-in in your browser"),
      ).toBeTruthy();
      expect(screen.queryByText("Opening the sign-in page…")).toBeNull();
      expect(host.requestWithResponseTimeout).toHaveBeenCalledWith(
        "providers.awaitLogin",
        { providerId: PROVIDER_ID, profileId: PROFILE_ID },
        expect.any(Number),
      );
    });

    it("consumes a refusal that lands after the dialog unmounted", async () => {
      let refuse: (error: HostRpcError) => void = () => undefined;
      host.request.mockImplementation((method) =>
        method === "providers.startLogin"
          ? new Promise<unknown>((_resolve, reject) => {
              refuse = reject;
            })
          : Promise.resolve({}),
      );
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        const { unmount } = renderSignInDialog(Wrapper);
        await waitFor(() => expect(startLoginCalls()).toBe(1));
        unmount();

        refuse(refusal());
        // Node reports an unhandled rejection only once the microtasks that
        // produced it have drained, so give it two macrotask turns.
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(unhandled).not.toHaveBeenCalled();
        // The refusal is still reported, by the hook, exactly once.
        expect(toastFromHostError).toHaveBeenCalledTimes(1);
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    });
  },
);

describe("the Switch account panel through a providers refresh", () => {
  it("keeps waiting and its copy link through a refreshed ambient row, then shows a failed attempt without returning to the switch row", async () => {
    let resolveAwait: (result: {
      readonly state: null;
      readonly existingProfileId: string | null;
      readonly codeRejected: boolean;
      readonly refusal: ProviderLoginRefusal | null;
    }) => void = () => undefined;
    host.request.mockImplementation((method) =>
      method === "providers.startLogin"
        ? Promise.resolve({
            url: "https://claude.test/oauth",
            started: true,
            profileId: "ambient",
            userCode: null,
          })
        : Promise.resolve({}),
    );
    host.requestWithResponseTimeout.mockImplementation(
      () =>
        new Promise<unknown>((resolve) => {
          resolveAwait = (result) => resolve(result);
        }),
    );
    const profile = authenticatedAmbientProfile();
    const { rerender } = renderSwitchAccountDialog(profile);

    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
    expect(
      await screen.findByText("Approve sign-in in your browser"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy sign-in link" }),
    ).toBeTruthy();

    // A cache refresh replaces both the provider and profile objects while
    // the browser approval remains pending. The reauth panel owns the attempt
    // and must not fall back to the Switch account row because those props did.
    rerender({
      ...profile,
      auth: { ...profile.auth },
      identity: profile.identity === null ? null : { ...profile.identity },
    });
    expect(screen.getByText("Approve sign-in in your browser")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy sign-in link" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Switch account" })).toBeNull();

    resolveAwait({
      state: null,
      existingProfileId: null,
      codeRejected: false,
      refusal: null,
    });

    expect(
      await screen.findByText("Sign-in did not finish. Try again."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel sign-in" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Edit profile" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Switch account" })).toBeNull();
  });
});

// A provider can accept the browser consent and still turn the account away
// (`providers.awaitLogin@2.2` `refusal`): Antigravity does it for an account
// Google wants verified first. Both surfaces that run the sign-in flow have to
// say so in the provider's own words and offer the way through, instead of the
// generic "did not finish" a refused sign-in used to end in.
const ANTIGRAVITY_REFUSAL: ProviderLoginRefusal = {
  reason:
    "Your current account is not eligible for Antigravity. Verify your account to continue.",
  actionUrl: "https://accounts.google.com/signin/continue?sarp=1&scc=1",
};

const REFUSAL_HEADLINE = "Antigravity turned down this sign-in.";

function antigravityState(profile: ProviderProfile): ProviderCliState {
  return { ...claudeState(profile), providerId: "antigravity" };
}

/** The host answers `startLogin` with a started sign-in and holds `awaitLogin`
 *  until the browser leg is over, then answers it with `awaitAnswer`. */
function answerSignInWith(awaitAnswer: {
  readonly state: null;
  readonly existingProfileId: string | null;
  readonly codeRejected: boolean;
  readonly refusal: ProviderLoginRefusal | null;
}): void {
  host.request.mockImplementation((method) =>
    method === "providers.startLogin"
      ? Promise.resolve({
          url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=agy",
          started: true,
          profileId: PROFILE_ID,
          userCode: null,
        })
      : Promise.resolve({}),
  );
  host.requestWithResponseTimeout.mockImplementation((method) =>
    method === "providers.awaitLogin"
      ? Promise.resolve(awaitAnswer)
      : new Promise<unknown>(() => undefined),
  );
}

function renderAntigravityReauth() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const profile = signedOutProfile();
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ProfileEditDialog
          state={antigravityState(profile)}
          profile={profile}
          profiles={[profile]}
          canOauth
          oauthUnavailableHint={null}
          startInReauth
          isLocalHost
          open
          onOpenChange={() => undefined}
          remainingProfilesAfterRemoval={[]}
          onSelectedProfileIdChange={() => undefined}
          profileEnablementAvailable
          profileEnablementPending={() => false}
          onSetProfileEnabled={() => undefined}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function renderAntigravityAddDialog(
  onFailedAttempt: (attempt: unknown) => void,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const client = Object.assign({} as HostClient<HostRpcRegistry>, {
    getActiveHostId: () => "host-local",
    request: host.request,
    requestWithSignal: host.request,
    requestWithResponseTimeout: host.requestWithResponseTimeout,
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AddProviderProfileDialog
          state={antigravityState(signedOutProfile())}
          client={client}
          isLocalHost
          open
          onOpenChange={() => undefined}
          onFailedAttempt={onFailedAttempt}
          onProfileCreated={() => undefined}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("the reauth panel when the provider refuses the sign-in", () => {
  it("names the provider, gives its reason, offers Verify account and retries as 'Try another account'", async () => {
    answerSignInWith({
      state: null,
      existingProfileId: null,
      codeRejected: false,
      refusal: ANTIGRAVITY_REFUSAL,
    });
    renderAntigravityReauth();

    expect(await screen.findByText(REFUSAL_HEADLINE)).toBeTruthy();
    expect(screen.getByText(ANTIGRAVITY_REFUSAL.reason)).toBeTruthy();
    // The flow's own wording is replaced, not stacked under the provider's.
    expect(screen.queryByText(/did not finish/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Verify account" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Try another account" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("sends the user to the provider's verification link through the auth link opener", async () => {
    answerSignInWith({
      state: null,
      existingProfileId: null,
      codeRejected: false,
      refusal: ANTIGRAVITY_REFUSAL,
    });
    renderAntigravityReauth();

    fireEvent.click(
      await screen.findByRole("button", { name: "Verify account" }),
    );

    expect(links.openLink).toHaveBeenCalledTimes(1);
    expect(links.openLink).toHaveBeenCalledWith(
      ANTIGRAVITY_REFUSAL.actionUrl,
      "auth",
      expect.anything(),
    );
  });

  it("starts a fresh sign-in from 'Try another account'", async () => {
    answerSignInWith({
      state: null,
      existingProfileId: null,
      codeRejected: false,
      refusal: ANTIGRAVITY_REFUSAL,
    });
    renderAntigravityReauth();
    await screen.findByText(REFUSAL_HEADLINE);
    expect(startLoginCalls()).toBe(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Try another account" }),
    );

    await waitFor(() => expect(startLoginCalls()).toBe(2));
  });

  it("offers no Verify account button when the provider offered no link, but still retries as 'Try another account'", async () => {
    answerSignInWith({
      state: null,
      existingProfileId: null,
      codeRejected: false,
      refusal: { reason: "This account cannot be used.", actionUrl: null },
    });
    renderAntigravityReauth();

    expect(await screen.findByText(REFUSAL_HEADLINE)).toBeTruthy();
    expect(screen.getByText("This account cannot be used.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Verify account" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Try another account" }),
    ).toBeTruthy();
  });

  it("keeps the flow's own wording and the plain Retry when the sign-in simply did not finish", async () => {
    answerSignInWith({
      state: null,
      existingProfileId: null,
      codeRejected: false,
      refusal: null,
    });
    renderAntigravityReauth();

    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText(REFUSAL_HEADLINE)).toBeNull();
    expect(screen.queryByRole("button", { name: "Verify account" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Try another account" }),
    ).toBeNull();
  });
});

describe("the add-profile dialog when the provider refuses the sign-in", () => {
  it("shows the provider's refusal with Verify account and a 'Try another account' retry, and reports the reason as the failed attempt", async () => {
    answerSignInWith({
      state: null,
      existingProfileId: null,
      codeRejected: false,
      refusal: ANTIGRAVITY_REFUSAL,
    });
    const onFailedAttempt = vi.fn<(attempt: unknown) => void>();
    renderAntigravityAddDialog(onFailedAttempt);

    fireEvent.click(screen.getByRole("button", { name: "Link account" }));

    expect(await screen.findByText(REFUSAL_HEADLINE)).toBeTruthy();
    expect(screen.getByText(ANTIGRAVITY_REFUSAL.reason)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Verify account" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Try another account" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(onFailedAttempt).toHaveBeenCalledWith({
      providerId: "antigravity",
      message: ANTIGRAVITY_REFUSAL.reason,
    });
  });

  it("opens the verification link and starts a fresh sign-in from 'Try another account'", async () => {
    answerSignInWith({
      state: null,
      existingProfileId: null,
      codeRejected: false,
      refusal: ANTIGRAVITY_REFUSAL,
    });
    renderAntigravityAddDialog(vi.fn());
    fireEvent.click(screen.getByRole("button", { name: "Link account" }));

    fireEvent.click(
      await screen.findByRole("button", { name: "Verify account" }),
    );
    expect(links.openLink).toHaveBeenCalledWith(
      ANTIGRAVITY_REFUSAL.actionUrl,
      "auth",
      expect.anything(),
    );

    expect(startLoginCalls()).toBe(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Try another account" }),
    );
    await waitFor(() => expect(startLoginCalls()).toBe(2));
  });

  it("offers no Verify account button when the provider offered no link", async () => {
    answerSignInWith({
      state: null,
      existingProfileId: null,
      codeRejected: false,
      refusal: { reason: "This account cannot be used.", actionUrl: null },
    });
    renderAntigravityAddDialog(vi.fn());
    fireEvent.click(screen.getByRole("button", { name: "Link account" }));

    expect(await screen.findByText(REFUSAL_HEADLINE)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Verify account" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Try another account" }),
    ).toBeTruthy();
  });

  it("keeps the plain failure and the Retry label when the sign-in did not finish without a refusal", async () => {
    answerSignInWith({
      state: null,
      existingProfileId: null,
      codeRejected: false,
      refusal: null,
    });
    renderAntigravityAddDialog(vi.fn());
    fireEvent.click(screen.getByRole("button", { name: "Link account" }));

    expect(
      await screen.findByText(
        "Sign-in did not finish. Retry when you are ready.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText(REFUSAL_HEADLINE)).toBeNull();
    expect(screen.queryByRole("button", { name: "Verify account" })).toBeNull();
  });
});
