import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeaderIdentity } from "@/components/layout/header/header-actions";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSignOutConfirmStore } from "@/stores/auth/sign-out-confirm-store";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useAuthService: () => ({ signOut: () => Promise.resolve() }),
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
  render(<HeaderIdentity showAppSettings={false} hostsSignOutConfirm />);
}

function askToSignOut(): void {
  act(() => {
    useSignOutConfirmStore.getState().setOpen(true);
  });
}

describe("the pending sign-out question", () => {
  beforeEach(() => {
    signedOut();
    useSignOutConfirmStore.setState({ open: false });
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
});
