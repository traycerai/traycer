import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { IHostMessenger } from "@traycer-clients/shared/host-transport/host-messenger";
import { useEffect } from "react";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

import { toast } from "sonner";
import { SignInButton } from "@/components/layout/header/sign-in-button";
import { DeviceCodeProgress } from "@/components/layout/header/sign-in/device-code-progress";
import {
  hostRpcRegistry,
  HostRuntimeProvider,
  useAuthService,
  type HostRpcRegistry,
} from "@/lib/host";
import type { AuthService } from "@/lib/auth/auth-service";
import { AuthSessionExpiredToastBridge } from "@/providers/auth-session-expired-toast-bridge";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";

function buildHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

function buildHostWithCli(cli: MockTraycerCli): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: cli,
  });
}

function makeMessengerFactory(): (args: {
  registry: HostRpcRegistry;
}) => IHostMessenger<HostRpcRegistry> {
  return (args) =>
    new MockHostMessenger<HostRpcRegistry>({
      registry: args.registry,
      requestId: () => "req-1",
      handlers: {
        "host.status": () =>
          Promise.resolve({
            ready: true,
            hostVersion: "1.2.3",
            protocolVersion: { major: 1, minor: 0 },
          }),
      },
    });
}

function installFetch(handler: (url: string) => Promise<Response>): () => void {
  const originalFetch: unknown = (globalThis as { fetch?: unknown }).fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (input: unknown): Promise<Response> =>
      handler(typeof input === "string" ? input : String(input)),
  });
  return () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  };
}

function okWithProfile(): Promise<Response> {
  return Promise.resolve(
    new Response(
      JSON.stringify({
        user: {
          id: "user-1",
          name: "Test User",
          providerId: "gh-1",
          providerHandle: "test-user",
          providerType: "GITHUB",
          email: "test@example.com",
          avatarUrl: null,
          activatedAt: null,
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          lastSeenAt: null,
          privacyMode: false,
          isLearningEnabled: true,
        },
        userSubscription: {
          id: "sub-1",
          userID: "user-1",
          orgID: null,
          teamID: null,
          customerId: "cus-1",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          subscriptionExpiry: null,
          trialEndsAt: null,
          subscriptionStatus: "FREE",
          hasPaymentMethod: false,
          isInTrial: false,
          rechargeRateSeconds: 0,
        },
        teamSubscriptions: [],
        payAsYouGoUsage: { allowPayAsYouGo: false },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    ),
  );
}

interface MountResult {
  readonly host: MockRunnerHost;
  readonly cleanupClient: () => void;
  readonly getAuthService: () => AuthService;
  readonly waitForAuthService: () => Promise<AuthService>;
}

function mountSignInButton(host: MockRunnerHost): MountResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let authService: AuthService | null = null;

  render(
    <RunnerHostProvider runnerHost={host}>
      <QueryClientProvider client={queryClient}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={makeMessengerFactory()}
          invalidator={null}
          requestId={null}
          remoteFetcher={() => Promise.resolve([])}
          fallback={<div data-testid="runtime-fallback">…</div>}
        >
          <AuthSessionExpiredToastBridge />
          <CaptureAuthService
            onCapture={(auth) => {
              authService = auth;
            }}
          />
          <SignInButton layout="compact" />
        </HostRuntimeProvider>
      </QueryClientProvider>
    </RunnerHostProvider>,
  );

  return {
    host,
    cleanupClient: () => {
      queryClient.clear();
    },
    getAuthService: () => {
      if (authService === null) {
        throw new Error("AuthService was not captured");
      }
      return authService;
    },
    waitForAuthService: async () => {
      // `CaptureAuthService`'s effect runs as its own passive-effect flush,
      // separate from the state update that clears `runtime-fallback` - a
      // `waitFor` on the fallback disappearing can resolve (via the DOM
      // MutationObserver microtask) before this sibling effect has committed.
      // Wait on the capture itself instead of assuming the fallback check
      // implies it.
      await waitFor(() => {
        if (authService === null) {
          throw new Error("AuthService was not captured");
        }
      });
      if (authService === null) {
        throw new Error("AuthService was not captured");
      }
      return authService;
    },
  };
}

function mountDeviceCodeProgress(host: MockRunnerHost): () => void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    <RunnerHostProvider runnerHost={host}>
      <QueryClientProvider client={queryClient}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={makeMessengerFactory()}
          invalidator={null}
          requestId={null}
          remoteFetcher={() => Promise.resolve([])}
          fallback={<div data-testid="runtime-fallback">…</div>}
        >
          <DeviceCodeProgress
            isHero
            progress={{
              userCode: "ABCDE-FGHIJ",
              verificationUri: "https://app.traycer.ai/device",
              verificationUriComplete:
                "https://app.traycer.ai/device?user_code=ABCDE-FGHIJ",
              expiresAtMs: 0,
            }}
          />
        </HostRuntimeProvider>
      </QueryClientProvider>
    </RunnerHostProvider>,
  );

  return () => {
    queryClient.clear();
  };
}

function CaptureAuthService(props: {
  readonly onCapture: (auth: AuthService) => void;
}): null {
  const auth = useAuthService();
  const { onCapture } = props;
  useEffect(() => {
    onCapture(auth);
  }, [auth, onCapture]);
  return null;
}

describe("<SignInButton />", () => {
  let restoreFetch: () => void = () => undefined;

  beforeEach(() => {
    useAuthStore.getState().setSignedOut();
    vi.clearAllMocks();
    // Default profile fetch is unused by these tests; install a benign 401
    // so any stray call does not accidentally sign the user in.
    restoreFetch = installFetch(() =>
      Promise.resolve(new Response(null, { status: 401 })),
    );
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    restoreFetch();
  });

  it("renders 'Sign-in failed - please try again.' when lastError is sign-in-failed", async () => {
    const result = mountSignInButton(buildHost());

    await waitFor(() => {
      expect(screen.queryByTestId("runtime-fallback")).toBeNull();
    });

    // Drive a device sign-in whose minted token the pre-installed 401 fetch
    // makes AuthnV3 reject, which must surface AUTH_ERROR_SIGN_IN_FAILED on the
    // header sign-in surface via the new copy.
    const auth = await result.waitForAuthService();
    await auth.signIn();
    result.host.deviceFlow.emitResult({
      kind: "authorized",
      token: "rejected-callback-token",
      refreshToken: "rejected-callback-token-refresh",
    });

    await waitFor(() => {
      const error = screen.queryByTestId("signin-error");
      expect(error).not.toBeNull();
      expect(error?.textContent ?? "").toContain(
        "Sign-in failed - please try again.",
      );
    });
    const detail = screen.getByTestId("signin-error-detail");
    expect(detail.textContent).toBe("sign-in-failed");
    result.cleanupClient();
  });

  it("offers a Retry affordance during signing-in that re-triggers the browser sign-in", async () => {
    const result = mountSignInButton(buildHost());

    await waitFor(() => {
      expect(screen.queryByTestId("runtime-fallback")).toBeNull();
    });

    // Idle (signed-out): no retry affordance - the primary button is the CTA.
    expect(screen.queryByTestId("signin-retry-link")).toBeNull();

    act(() => {
      useAuthStore.getState().setSigningIn();
    });

    expect(screen.queryByRole("button", { name: "Signing in" })).toBeNull();
    await waitFor(() => {
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "Sign in" })
          .disabled,
      ).toBe(true);
    });
    const retry = await screen.findByTestId("signin-retry-link");
    // `signIn()` restarts the device flow and re-opens the verification page, so
    // a stalled attempt has an immediate escape hatch. Capturing the count
    // before the retry proves the click drove a fresh start, not just the
    // initial sign-in.
    const startCallsBeforeRetry = result.host.deviceFlow.startCalls;
    fireEvent.click(retry);

    await waitFor(() => {
      expect(result.host.deviceFlow.startCalls).toBe(startCallsBeforeRetry + 1);
      expect(
        result.host.openedExternalLinks.some((url) =>
          url.startsWith("https://app.traycer.ai/device"),
        ),
      ).toBe(true);
    });

    result.cleanupClient();
  });

  it("toasts and clears session-expired instead of rendering persistent inline copy", async () => {
    const host = buildHost();
    await host.tokenStore.set({
      token: "revoked-stored-token",
      refreshToken: "revoked-stored-token-refresh",
    });
    const result = mountSignInButton(host);

    // The HostRuntimeProvider auto-starts the AuthService, which calls
    // validateToken() against the pre-installed 401 fetch; the stored-token
    // rehydration path must surface AUTH_ERROR_SESSION_EXPIRED as a toast
    // rather than keeping a persistent inline error beside the sign-in CTA.
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Session expired - sign in again.",
        { id: "auth-session:expired" },
      );
    });
    expect(screen.queryByTestId("signin-error")).toBeNull();
    result.cleanupClient();
  });

  it("clears local CLI credentials when a stored session is rejected", async () => {
    const cli = new MockTraycerCli();
    await cli.cliLogin("stale-cli-token", "stale-cli-refresh");
    const host = buildHostWithCli(cli);
    await host.tokenStore.set({
      token: "revoked-stored-token",
      refreshToken: "revoked-stored-token-refresh",
    });
    const result = mountSignInButton(host);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Session expired - sign in again.",
        { id: "auth-session:expired" },
      );
    });
    expect(await host.tokenStore.get()).toBeNull();
    expect(cli.lastLoginToken).toBeNull();
    expect(cli.lastLoginRefreshToken).toBeNull();
    result.cleanupClient();
  });

  it("toasts and clears session-expired after active-session revalidation rejects", async () => {
    restoreFetch();
    restoreFetch = installFetch(() => okWithProfile());
    const result = mountSignInButton(buildHost());

    await waitFor(() => {
      expect(screen.queryByTestId("runtime-fallback")).toBeNull();
    });

    const auth = await result.waitForAuthService();
    await auth.signIn();
    result.host.deviceFlow.emitResult({
      kind: "authorized",
      token: "valid-token",
      refreshToken: "valid-token-refresh",
    });
    await waitFor(() => {
      expect(useAuthStore.getState().status).toBe("signed-in");
    });
    vi.clearAllMocks();

    restoreFetch();
    restoreFetch = installFetch(() =>
      Promise.resolve(new Response(null, { status: 401 })),
    );

    const outcome = await result.getAuthService().revalidateCurrentContext();

    expect(outcome?.kind).toBe("rejected");
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Session expired - sign in again.",
        { id: "auth-session:expired" },
      );
    });
    expect(useAuthStore.getState().status).toBe("signed-out");
    expect(result.getAuthService().getLastError()).toBeNull();
    expect(screen.queryByTestId("signin-error")).toBeNull();
    result.cleanupClient();
  });

  it("starts the device flow and surfaces the user code on the single Sign in", async () => {
    restoreFetch();
    restoreFetch = installFetch(() => okWithProfile());
    const result = mountSignInButton(buildHost());

    await waitFor(() => {
      expect(screen.queryByTestId("runtime-fallback")).toBeNull();
    });

    // The single "Sign in" runs the device flow directly - no separate "use a
    // code" affordance. Drive it through the button so a broken click handler
    // fails the test.
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(result.host.deviceFlow.startCalls).toBe(1);
    });
    await screen.findByRole("heading", { name: "Approve in your browser" });
    expect(screen.queryByRole("button", { name: "Signing in" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use code instead" }));
    const code = await screen.findByText("ABCDE-FGHIJ");
    expect(code.textContent).toBe("ABCDE-FGHIJ");
    expect(screen.getByText("https://app.traycer.ai/device").textContent).toBe(
      "https://app.traycer.ai/device",
    );
    const writeText = vi.fn(() => Promise.resolve());
    const previousClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    try {
      expect(screen.queryByText("Copied")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Copy device code" }));
      fireEvent.click(
        screen.getByRole("button", { name: "Copy approval address" }),
      );
      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith("ABCDE-FGHIJ");
        expect(writeText).toHaveBeenCalledWith("https://app.traycer.ai/device");
      });
      expect(screen.getAllByText("Copied")).toHaveLength(2);
      // There is no device-code fallback link anymore.
      expect(screen.queryByTestId("signin-device-code-link")).toBeNull();
    } finally {
      if (previousClipboard === undefined) {
        Reflect.deleteProperty(navigator, "clipboard");
      } else {
        Object.defineProperty(navigator, "clipboard", previousClipboard);
      }
      result.cleanupClient();
    }
  });

  it("renders an expired approval status without the waiting spinner", async () => {
    const cleanupClient = mountDeviceCodeProgress(buildHost());

    expect(await screen.findByText("Approval code expired")).not.toBeNull();
    expect(screen.getByText("Code expired")).not.toBeNull();
    expect(screen.queryByTestId("signin-device-spinner")).toBeNull();

    cleanupClient();
  });
});
