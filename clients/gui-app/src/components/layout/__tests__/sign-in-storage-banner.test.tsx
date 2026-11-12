import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignInStorageBanner } from "@/components/layout/sign-in-storage-banner";
import {
  DISK_FULL_SIGN_IN_BODY,
  DISK_FULL_SIGN_IN_TITLE,
} from "@traycer-clients/shared/auth/sign-in-storage";
import { useAuthStore } from "@/stores/auth/auth-store";

describe("SignInStorageBanner", () => {
  beforeEach(() => {
    useAuthStore.getState().setSignInStorageLow(false);
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignInStorageLow(false);
  });

  it("announces the approved notice as soon as the initial store flag is true", () => {
    act(() => useAuthStore.getState().setSignInStorageLow(true));
    render(<SignInStorageBanner />);

    const notice = screen.getByRole("status", {
      name: DISK_FULL_SIGN_IN_TITLE,
    });
    expect(notice.textContent).toBe(
      `${DISK_FULL_SIGN_IN_TITLE} ${DISK_FULL_SIGN_IN_BODY}`,
    );
  });

  it("self-clears when the store flag clears", () => {
    act(() => useAuthStore.getState().setSignInStorageLow(true));
    render(<SignInStorageBanner />);
    expect(
      screen.getByRole("status", { name: DISK_FULL_SIGN_IN_TITLE }),
    ).not.toBeNull();

    act(() => useAuthStore.getState().setSignInStorageLow(false));
    expect(
      screen.queryByRole("status", { name: DISK_FULL_SIGN_IN_TITLE }),
    ).toBeNull();
  });
});
