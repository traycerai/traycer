import { Fragment, StrictMode, type ReactNode } from "react";
import type {
  ProviderCliState,
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
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => () => Promise.resolve(),
}));
vi.mock("@/lib/host-error-toast", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/host-error-toast")>();
  return { ...actual, toastFromHostError: vi.fn() };
});

import { toastFromHostError } from "@/lib/host-error-toast";
import { ProfileEditDialog } from "@/components/settings/panels/provider-profile-edit-dialog";
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
