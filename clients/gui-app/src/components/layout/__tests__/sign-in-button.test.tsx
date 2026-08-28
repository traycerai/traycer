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
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { IHostMessenger } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  IRunnerHost,
  LinkLoginDeepLinkDelivery,
} from "@traycer-clients/shared/platform/runner-host";
import { useEffect } from "react";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    // The bridge's "already signed in" notice rides the info channel.
    info: vi.fn(),
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
import { setMobileApp } from "@/lib/mobile-app";
import { AuthSessionExpiredToastBridge } from "@/providers/auth-session-expired-toast-bridge";
import { LinkLoginDeepLinkBridge } from "@/components/layout/bridges/link-login-deep-link-bridge";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";
import { decideDeepLinkRouting } from "@/lib/auth/link-login-deep-link-routing";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useLinkLoginDeepLinkOutcomeStore } from "@/stores/auth/link-login-deep-link-outcome-store";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

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
            busy: false,
            busySessionCount: 0,
            updateProgress: null,
            busyBreakdown: null,
            // `null` = this fixture's host did not report the durable attempt,
            // which is exactly what host.status@1.2-and-older peers send.
            updateOperation: null,
            updateTransaction: null,
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

interface MountResult<H extends IRunnerHost> {
  readonly host: H;
  readonly cleanupClient: () => void;
  readonly getAuthService: () => AuthService;
  readonly waitForAuthService: () => Promise<AuthService>;
}

function mountSignInButton<H extends IRunnerHost>(
  host: H,
  layout: "compact" | "hero",
): MountResult<H> {
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
          remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
          fallback={<div data-testid="runtime-fallback">…</div>}
        >
          <AuthSessionExpiredToastBridge />
          <LinkLoginDeepLinkBridge />
          <CaptureAuthService
            onCapture={(auth) => {
              authService = auth;
            }}
          />
          <SignInButton layout={layout} />
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
          remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
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
              phase: "waiting-approval",
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

/**
 * A link code can be handed to the app by the OS at any moment — including
 * ones where this surface does not exist. What happens then is a decision, not
 * a rendering concern, so it is asserted as one.
 */
describe("routing a link code the OS delivered", () => {
  it("redeems only when signed out", () => {
    expect(decideDeepLinkRouting("signed-out")).toBe("redeem");
  });

  it("refuses to claim while already signed in", () => {
    // Claiming would swap the signed-in user underneath whatever they were
    // doing, from a QR that may have been scanned by accident.
    expect(decideDeepLinkRouting("signed-in")).toBe("already-signed-in");
  });

  it("holds the code while a sign-in is already in flight", () => {
    // Not dropped: attempts supersede each other, so redeeming now would kill
    // the attempt in progress. The decision is retaken when it settles.
    expect(decideDeepLinkRouting("signing-in")).toBe("hold");
  });
});

describe("link-code entry is gated on the mobile-app PRODUCT signal", () => {
  // The immutable Capacitor product flag, never the viewport: a narrow
  // desktop window is still a desktop, and a desktop offering to scan a QR
  // from itself is a nonsense affordance (and would mint a `mobile` session
  // for a non-mobile shell).
  let restoreFetch: () => void = () => undefined;

  beforeEach(() => {
    useAuthStore.getState().setSignedOut();
    restoreFetch = installFetch(() =>
      Promise.resolve(new Response(null, { status: 401 })),
    );
  });

  afterEach(() => {
    cleanup();
    setMobileApp(false);
    useAuthStore.getState().setSignedOut();
    useLinkLoginDeepLinkOutcomeStore.getState().clear();
    restoreFetch();
  });

  /**
   * A code the SYSTEM camera delivered, with the claim under this test's
   * control. `emitCode` is the OS handing the app a scanned QR.
   */
  function deepLinkHost(): {
    readonly host: IRunnerHost;
    readonly emitCode: (code: string) => void;
  } {
    // A holder, not a bare `let`: the assignment happens inside a callback,
    // where narrowing would otherwise keep the binding at its initial `null`.
    const sink: {
      subscriber: ((delivery: LinkLoginDeepLinkDelivery) => void) | null;
      nextDeliveryId: number;
    } = { subscriber: null, nextDeliveryId: 1 };
    const host = createFakeRunnerHost({
      authnBaseUrl: "http://localhost:5005",
      linkLoginDeepLinks: {
        onLinkLoginCode: (handler) => {
          sink.subscriber = handler;
          return { dispose: () => undefined };
        },
      },
    });
    return {
      host,
      // Each call is a distinct arrival, exactly as the shell reports them -
      // including a repeat of a code already delivered, which is what a
      // deliberate rescan looks like from here.
      emitCode: (code: string) => {
        const subscriber = sink.subscriber;
        if (subscriber === null) {
          throw new Error("the bridge never subscribed");
        }
        subscriber({ code, deliveryId: sink.nextDeliveryId });
        sink.nextDeliveryId += 1;
      },
    };
  }

  it("locks the in-app scan while a camera-launched claim is still outstanding", async () => {
    // The race the gate closes: the claim POST is in flight, so nothing has
    // published poll progress yet. A tap on the still-live Scan button would
    // start a second attempt that SUPERSEDES the camera-launched one, whose
    // failure then lands under the replacement's wait.
    setMobileApp(true);
    const outstanding = installFetch(
      () => new Promise<Response>(() => undefined),
    );
    const { host, emitCode } = deepLinkHost();
    const mobile = mountSignInButton(host, "hero");
    await mobile.waitForAuthService();
    expect(
      screen.getByTestId("link-code-signin-open").hasAttribute("disabled"),
    ).toBe(false);

    act(() => {
      emitCode("ABCDEFGHJK");
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("link-code-signin-open").hasAttribute("disabled"),
      ).toBe(true);
    });
    expect(screen.getByTestId("link-code-signin-waiting")).toBeTruthy();
    // Retry is the device flow's escape hatch from a stalled browser round
    // trip. Offering it here offers to throw away a claim the user's desktop
    // is prompting them to approve: `signIn()` is re-entrant, so tapping it
    // would supersede the camera-launched attempt.
    expect(screen.queryByTestId("signin-retry-link")).toBeNull();
    outstanding();
    mobile.cleanupClient();
  });

  it("keeps a superseded camera claim silent under whatever replaced it", async () => {
    // The claim settles only AFTER a newer attempt has taken the surface. Its
    // result is `superseded`, not a failure, and must not surface at all - a
    // discarded attempt's complaint under the successor's progress describes a
    // request nobody is waiting on.
    setMobileApp(true);
    const claimSettles: { resolve: (() => void) | null } = { resolve: null };
    const gated = installFetch(
      () =>
        new Promise<Response>((resolveResponse) => {
          claimSettles.resolve = () => {
            resolveResponse(new Response(null, { status: 401 }));
          };
        }),
    );
    const { host, emitCode } = deepLinkHost();
    const mobile = mountSignInButton(host, "hero");
    const auth = await mobile.waitForAuthService();

    act(() => {
      emitCode("ABCDEFGHJK");
    });
    await waitFor(() => {
      expect(screen.getByTestId("link-code-signin-waiting")).toBeTruthy();
    });

    // A newer attempt takes over, discarding the link attempt's fence.
    await act(async () => {
      await auth.signIn();
    });
    await act(async () => {
      claimSettles.resolve?.();
      await Promise.resolve();
    });

    expect(screen.queryByTestId("link-code-signin-notice")).toBeNull();
    gated();
    mobile.cleanupClient();
  });

  it("claims a rescan of the same code the shell chose to redeliver", async () => {
    // Scan while signed in (refused with a notice), sign out, rescan the same
    // still-live QR. The shell judged that second arrival intentional; a guard
    // here keyed on the code value would silently swallow it.
    setMobileApp(true);
    const claimed: string[] = [];
    const observing = installFetch((url) => {
      if (url.includes("/link/claim")) {
        claimed.push(url);
      }
      return Promise.resolve(new Response(null, { status: 401 }));
    });
    const { host, emitCode } = deepLinkHost();
    const mobile = mountSignInButton(host, "hero");
    await mobile.waitForAuthService();

    act(() => {
      useAuthStore.getState().setSignedIn(
        {
          userId: "u1",
          userName: "U",
          email: "u@example.test",
          avatarUrl: null,
        },
        { userId: "u1", username: "U" },
        [],
      );
    });
    act(() => {
      emitCode("ABCDEFGHJK");
    });
    expect(claimed.length).toBe(0);

    act(() => {
      useAuthStore.getState().setSignedOut();
    });
    act(() => {
      emitCode("ABCDEFGHJK");
    });

    await waitFor(() => {
      expect(claimed.length).toBe(1);
    });
    observing();
    mobile.cleanupClient();
  });

  it("explains a failed camera claim once, not twice", async () => {
    // The precise reason and the generic "Sign-in failed - please try again"
    // used to render together on the same screen; for an expired code the
    // generic one is advice that cannot work.
    setMobileApp(true);
    const rejected = installFetch(() =>
      Promise.resolve(new Response(null, { status: 401 })),
    );
    const { host, emitCode } = deepLinkHost();
    const mobile = mountSignInButton(host, "hero");
    await mobile.waitForAuthService();

    act(() => {
      emitCode("ABCDEFGHJK");
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("link-code-signin-notice").textContent,
      ).toContain("invalid, expired, or already used");
    });
    expect(screen.queryByTestId("signin-error")).toBeNull();
    rejected();
    mobile.cleanupClient();
  });

  it("retires a camera-scan notice when a newer attempt starts", async () => {
    // Otherwise the verdict outlives its own flow and reappears on a later
    // sign-in screen, describing something the user has moved on from.
    setMobileApp(true);
    useLinkLoginDeepLinkOutcomeStore.getState().report("invalid-code");
    const mobile = mountSignInButton(buildHost(), "hero");
    await mobile.waitForAuthService();
    expect(screen.getByTestId("link-code-signin-notice")).toBeTruthy();

    act(() => {
      useAuthStore.getState().setSigningIn("device");
    });

    await waitFor(() => {
      expect(screen.queryByTestId("link-code-signin-notice")).toBeNull();
    });
    mobile.cleanupClient();
  });

  it("speaks the real reason a camera-scanned code failed", async () => {
    // The deep-link path is where a DEAD code is most likely: one live code
    // per account means a re-mint kills the QR still on the desktop screen.
    // "Try again" would be advice that cannot work, so the surface renders the
    // same precise copy an in-app scan gets.
    setMobileApp(true);
    useLinkLoginDeepLinkOutcomeStore.getState().report("invalid-code");
    const mobile = mountSignInButton(buildHost(), "hero");
    await mobile.waitForAuthService();
    expect(screen.getByTestId("link-code-signin-notice").textContent).toContain(
      "invalid, expired, or already used",
    );
    mobile.cleanupClient();
  });

  it("mobile hero leads with a primary Scan CTA above a secondary Sign in", async () => {
    setMobileApp(true);
    const mobile = mountSignInButton(buildHost(), "hero");
    await mobile.waitForAuthService();
    const scan = screen.getByTestId("link-code-signin-open");
    const signIn = screen.getByTestId("signin-button");
    expect(scan.textContent).toContain("Scan QR code");
    // Scan is the emphasized action and renders ABOVE the device-flow button.
    expect(
      scan.compareDocumentPosition(signIn) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Manual code entry stays reachable as a tertiary link.
    const manual = screen.getByTestId("link-code-signin-manual");
    expect(manual).toBeTruthy();
    // The hero's inherited white text must not reach this outline button's
    // light surface - the label pins its own foreground.
    expect(manual.className).toContain("text-foreground");
    mobile.cleanupClient();
  });

  it("shows the link-code entry only in the mobile app", async () => {
    setMobileApp(true);
    const mobile = mountSignInButton(buildHost(), "compact");
    await mobile.waitForAuthService();
    expect(screen.getByTestId("link-code-signin-open")).toBeTruthy();
    cleanup();
    mobile.cleanupClient();

    setMobileApp(false);
    const desktopHero = mountSignInButton(buildHost(), "hero");
    await desktopHero.waitForAuthService();
    expect(screen.getByTestId("signin-button")).toBeTruthy();
    expect(screen.queryByTestId("link-code-signin-open")).toBeNull();
    expect(screen.queryByTestId("link-code-signin-manual")).toBeNull();
    desktopHero.cleanupClient();
  });
});

describe("<SignInButton />", () => {
  let restoreFetch: () => void = () => undefined;

  beforeEach(() => {
    useAuthStore.getState().setSignedOut();
    useDesktopDialogStore.setState({
      activeDialog: null,
      reportIssueAvailable: false,
      reportIssueContext: null,
      reportIssueDraftId: 0,
    });
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
    useDesktopDialogStore.setState({
      activeDialog: null,
      reportIssueAvailable: false,
      reportIssueContext: null,
      reportIssueDraftId: 0,
    });
    restoreFetch();
  });

  it("renders 'Sign-in failed - please try again.' when lastError is sign-in-failed", async () => {
    const result = mountSignInButton(buildHost(), "compact");

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

    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();
    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));
    expect(useDesktopDialogStore.getState()).toMatchObject({
      activeDialog: "report-issue",
      reportIssueContext: {
        title: "Sign in failed",
        message: null,
        code: null,
        source: "Sign in",
      },
    });
    result.cleanupClient();
  });

  it("offers a Retry affordance during signing-in that re-triggers the browser sign-in", async () => {
    const result = mountSignInButton(buildHost(), "compact");

    await waitFor(() => {
      expect(screen.queryByTestId("runtime-fallback")).toBeNull();
    });

    // Idle (signed-out): no retry affordance - the primary button is the CTA.
    expect(screen.queryByTestId("signin-retry-link")).toBeNull();

    act(() => {
      useAuthStore.getState().setSigningIn("device");
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
    await host.tokenStore.signIn(
      {
        token: "revoked-stored-token",
        refreshToken: "revoked-stored-token-refresh",
      },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    const result = mountSignInButton(host, "compact");

    // The HostRuntimeProvider auto-starts the AuthService, which calls
    // validateToken() against the pre-installed 401 fetch; the stored-token
    // rehydration path must surface AUTH_ERROR_SESSION_EXPIRED as a toast
    // rather than keeping a persistent inline error beside the sign-in CTA.
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Session expired - sign in again.",
        { id: "auth-session:expired", cancel: null },
      );
    });
    expect(screen.queryByTestId("signin-error")).toBeNull();
    result.cleanupClient();
  });

  it("keeps credentials file when a stored session is rejected (UI-only sign-out)", async () => {
    // Automatic failure paths never destroy the shared credentials file —
    // only explicit sign-out does (tech plan §5). CLI seeding is gone; the
    // file is the single store.
    const host = buildHost();
    await host.tokenStore.signIn(
      {
        token: "revoked-stored-token",
        refreshToken: "revoked-stored-token-refresh",
      },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    const result = mountSignInButton(host, "compact");

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Session expired - sign in again.",
        { id: "auth-session:expired", cancel: null },
      );
    });
    // UI is signed out but the file is kept so a sibling rotation can recover.
    // No `authnBaseUrl`: the stored session carries only the token pair and
    // the cached identity - the origin lives on the host's own config.
    expect(await host.tokenStore.get()).toEqual({
      token: "revoked-stored-token",
      refreshToken: "revoked-stored-token-refresh",
      // `expect.any(String)` is an `any`-typed matcher; type it as the string
      // field it stands in for so the object literal stays free of unsafe `any`.
      savedAt: expect.any(String) as string,
      user: { id: "user-1", email: "test@example.com", name: "Test User" },
    });
    result.cleanupClient();
  });

  it("toasts and clears session-expired after active-session revalidation rejects", async () => {
    restoreFetch();
    restoreFetch = installFetch(() => okWithProfile());
    const result = mountSignInButton(buildHost(), "compact");

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
        { id: "auth-session:expired", cancel: null },
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
    const result = mountSignInButton(buildHost(), "compact");

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
    expect(
      screen
        .getByRole("button", { name: "Use code instead" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
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
