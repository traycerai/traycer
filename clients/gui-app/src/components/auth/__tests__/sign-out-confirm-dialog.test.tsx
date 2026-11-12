import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeaderIdentity } from "@/components/layout/header/header-actions";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSignOutConfirmStore } from "@/stores/auth/sign-out-confirm-store";

const authHarness = vi.hoisted(() => ({
  signOut: vi.fn<() => Promise<boolean>>(),
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useAuthService: () => ({ signOut: authHarness.signOut }),
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

function mountSeatWithQueryClient(queryClient: QueryClient): void {
  render(
    <QueryClientProvider client={queryClient}>
      <HeaderIdentity showAppSettings={false} hostsSignOutConfirm />
    </QueryClientProvider>,
  );
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
    authHarness.signOut
      .mockResolvedValueOnce(false)
      .mockReturnValueOnce(retry.promise);
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
    await waitFor(() => expect(authHarness.signOut).toHaveBeenCalledTimes(2));
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
    const queryClient = new QueryClient();
    authHarness.signOut.mockReturnValueOnce(pendingSignOut.promise);
    mountSeatWithQueryClient(queryClient);
    askToSignOut();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => {
      expect(authHarness.signOut).toHaveBeenCalledTimes(1);
    });

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
});
