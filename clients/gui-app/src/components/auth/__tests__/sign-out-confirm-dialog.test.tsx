import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { HeaderIdentity } from "@/components/layout/header/header-actions";
import { AuthService } from "@/lib/auth/auth-service";
import { HostRuntimeContext, useHostBinding } from "@/lib/host/runtime";
import { HostRuntimeTestProvider } from "@/lib/host/__tests__/host-runtime-test-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSignOutConfirmStore } from "@/stores/auth/sign-out-confirm-store";

const authHarness = vi.hoisted(() => ({
  signOut: vi.fn<() => Promise<boolean>>(),
}));

vi.mock("@/components/auth/user-menu", () => ({
  UserMenu: () => <span data-testid="user-menu" />,
}));
vi.mock("@/components/layout/header/sign-in-button", () => ({
  SignInButton: () => <span data-testid="sign-in" />,
}));

function signedInAs(userId: string): void {
  act(() => {
    useAuthStore.setState({
      status: "signed-in",
      profile: { userId, userName: userId, email: `${userId}@example.com` },
    });
  });
}

function signedOut(): void {
  act(() => {
    useAuthStore.setState({ status: "signed-out", profile: null });
  });
}

/** The gate's header, the dialog's real seat where no shell is up. */
function mountSeat(): void {
  mountSeatWithQueryClient(new QueryClient());
}

function HostRuntimeAuthContext(props: {
  readonly auth: AuthService | null;
  readonly onCapture: (auth: AuthService) => void;
  readonly children: ReactNode;
}) {
  const binding = useHostBinding();
  if (binding === null) throw new Error("expected the host runtime binding");
  props.onCapture(binding.auth);
  const contextValue =
    props.auth === null ? binding : { ...binding, auth: props.auth };
  return (
    <HostRuntimeContext.Provider value={contextValue}>
      {props.children}
    </HostRuntimeContext.Provider>
  );
}

interface MountedSeat {
  readonly auth: AuthService;
  readonly replaceAuth: (auth: AuthService) => void;
}

function mountSeatWithQueryClient(queryClient: QueryClient): MountedSeat {
  const captured: { auth: AuthService | null } = { auth: null };
  const renderSeat = (replacement: AuthService | null) => (
    <QueryClientProvider client={queryClient}>
      <HostRuntimeTestProvider>
        <HostRuntimeAuthContext
          auth={replacement}
          onCapture={(current) => (captured.auth = current)}
        >
          <HeaderIdentity showAppSettings={false} hostsSignOutConfirm />
        </HostRuntimeAuthContext>
      </HostRuntimeTestProvider>
    </QueryClientProvider>
  );
  const mounted = render(renderSeat(null));
  const auth = captured.auth;
  if (auth === null) throw new Error("expected the host runtime auth service");
  vi.spyOn(auth, "signOut").mockImplementation(() => authHarness.signOut());
  return {
    auth,
    replaceAuth: (replacement) => mounted.rerender(renderSeat(replacement)),
  };
}

function createReplacementAuthService(): AuthService {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "https://authn.traycer.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  return new AuthService({ runnerHost });
}

function askToSignOut(): void {
  act(() => {
    useSignOutConfirmStore.getState().setOpen(true);
  });
}

function deferred<T>() {
  let resolvePromise: (value: T) => void = () => {
    throw new Error("deferred promise has not been initialized");
  };
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe("the pending sign-out question", () => {
  beforeEach(() => {
    signedOut();
    useSignOutConfirmStore.setState({ open: false });
    authHarness.signOut.mockReset();
    authHarness.signOut.mockResolvedValue(true);
  });

  afterEach(() => {
    cleanup();
    signedOut();
    useSignOutConfirmStore.setState({ open: false });
    vi.useRealTimers();
  });

  it("does not come back for the next account after the session ends elsewhere", () => {
    signedInAs("user-a");
    mountSeat();
    askToSignOut();
    expect(screen.getByTestId("confirm-destructive-dialog")).not.toBeNull();

    signedOut();
    expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();

    signedInAs("user-b");
    expect(screen.getByTestId("user-menu")).not.toBeNull();
    expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
  });

  it("survives an update to the same session, and the seat changing hands", () => {
    signedInAs("user-a");
    mountSeat();
    askToSignOut();

    signedInAs("user-a");
    expect(screen.getByTestId("confirm-destructive-dialog")).not.toBeNull();

    cleanup();
    mountSeat();
    expect(screen.getByTestId("confirm-destructive-dialog")).not.toBeNull();
  });

  it("keeps the failed sign-out visible, locks while retrying, and closes after success", async () => {
    signedInAs("test-session");
    const retry = deferred<boolean>();
    const retryStarted = deferred<void>();
    authHarness.signOut
      .mockImplementationOnce(() => Promise.resolve(false))
      .mockImplementationOnce(() => {
        retryStarted.resolve(undefined);
        return retry.promise;
      });
    mountSeat();
    askToSignOut();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Couldn't sign out. Please try again.");
    expect(
      screen.getByText(
        "You'll need to sign in again to use Traycer in this app.",
      ),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Sign out" }).hasAttribute("disabled"),
    ).toBe(false);
    expect(useAuthStore.getState().status).toBe("signed-in");
    expect(screen.getByTestId("user-menu")).not.toBeNull();

    const retryButton = screen.getByRole("button", { name: "Sign out" });
    fireEvent.click(retryButton);
    await retryStarted.promise;
    expect(authHarness.signOut).toHaveBeenCalledTimes(2);
    expect(retryButton.hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("confirm-destructive-dialog")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(useAuthStore.getState().status).toBe("signed-in");

    await act(async () => {
      retry.resolve(true);
      await retry.promise;
    });
    await waitFor(() =>
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull(),
    );
    expect(authHarness.signOut).toHaveBeenCalledTimes(2);
  });

  it("keeps pending and failed sign-out state across header-seat remounts", async () => {
    signedInAs("test-session");
    const pendingSignOut = deferred<boolean>();
    const signOutStarted = deferred<void>();
    const queryClient = new QueryClient();
    authHarness.signOut.mockImplementationOnce(() => {
      signOutStarted.resolve(undefined);
      return pendingSignOut.promise;
    });
    mountSeatWithQueryClient(queryClient);
    askToSignOut();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await signOutStarted.promise;
    expect(authHarness.signOut).toHaveBeenCalledTimes(1);

    cleanup();
    mountSeatWithQueryClient(queryClient);
    const remountedAction = screen.getByRole("button", { name: "Sign out" });
    expect.soft(remountedAction.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      pendingSignOut.resolve(false);
      await pendingSignOut.promise;
    });

    expect
      .soft(screen.queryByRole("alert")?.textContent)
      .toBe("Couldn't sign out. Please try again.");
    expect.soft(remountedAction.hasAttribute("disabled")).toBe(false);
    expect(useAuthStore.getState().status).toBe("signed-in");

    cleanup();
    mountSeatWithQueryClient(queryClient);
    expect
      .soft(screen.queryByRole("alert")?.textContent)
      .toBe("Couldn't sign out. Please try again.");
    expect(
      screen.getByRole("button", { name: "Sign out" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("retries through the replacement host-runtime auth service", async () => {
    signedInAs("test-session");
    const queryClient = new QueryClient();
    const seat = mountSeatWithQueryClient(queryClient);
    const authA = seat.auth;
    const signOutA = vi.spyOn(authA, "signOut");
    signOutA.mockReset();
    const firstAttempt = deferred<void>();
    const retryOnA = deferred<void>();
    const retryOnB = deferred<void>();
    signOutA
      .mockImplementationOnce(() => {
        firstAttempt.resolve(undefined);
        return Promise.resolve(false);
      })
      .mockImplementation(() => {
        retryOnA.resolve(undefined);
        return Promise.resolve(false);
      });

    askToSignOut();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await firstAttempt.promise;
    expect(signOutA).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("alert")).toBeDefined();

    const authB = createReplacementAuthService();
    onTestFinished(() => authB.dispose());
    expect(authB).not.toBe(authA);
    const signOutB = vi.spyOn(authB, "signOut").mockImplementation(() => {
      retryOnB.resolve(undefined);
      return Promise.resolve(true);
    });
    seat.replaceAuth(authB);
    expect(screen.getByRole("alert")).toBeDefined();
    expect(useAuthStore.getState().status).toBe("signed-in");

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    const retryTarget = await Promise.race([
      retryOnA.promise.then(() => "original" as const),
      retryOnB.promise.then(() => "replacement" as const),
    ]);

    expect(retryTarget).toBe("replacement");
    expect(signOutA).toHaveBeenCalledTimes(1);
    expect(signOutB).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull(),
    );
  });

  it("queues a new sign-out behind old cleanup without leaking its failure", async () => {
    signedInAs(crypto.randomUUID());
    const queryClient = new QueryClient();
    const oldCleanup = deferred<boolean>();
    const newCleanup = deferred<boolean>();
    const oldSignOutStarted = deferred<void>();
    const newSignOutStarted = deferred<void>();
    authHarness.signOut
      .mockImplementationOnce(() => {
        oldSignOutStarted.resolve(undefined);
        return oldCleanup.promise;
      })
      .mockImplementationOnce(() => {
        newSignOutStarted.resolve(undefined);
        return newCleanup.promise;
      });
    mountSeatWithQueryClient(queryClient);
    askToSignOut();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await oldSignOutStarted.promise;
    expect(authHarness.signOut).toHaveBeenCalledTimes(1);

    signedOut();
    signedInAs(crypto.randomUUID());
    askToSignOut();
    expect(screen.getByTestId("confirm-destructive-dialog")).not.toBeNull();
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(authHarness.signOut).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("confirm-destructive-dialog")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Sign out" }).hasAttribute("disabled"),
    ).toBe(true);

    await act(async () => {
      oldCleanup.resolve(false);
      await oldCleanup.promise;
      await vi.advanceTimersByTimeAsync(0);
    });
    await newSignOutStarted.promise;
    expect(authHarness.signOut).toHaveBeenCalledTimes(2);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("confirm-destructive-dialog")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Sign out" }).hasAttribute("disabled"),
    ).toBe(true);

    await act(async () => {
      newCleanup.resolve(true);
      await newCleanup.promise;
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    expect(authHarness.signOut).toHaveBeenCalledTimes(2);
  });
});
