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

  it("keeps one empty status region as the store flag toggles", () => {
    render(<SignInStorageBanner />);

    const status = screen.getByRole("status");
    expect(status.textContent).toBe("");
    expect(status.getAttribute("aria-label")).toBeNull();
    expect(
      screen.queryByRole("status", { name: DISK_FULL_SIGN_IN_TITLE }),
    ).toBeNull();

    act(() => useAuthStore.getState().setSignInStorageLow(true));
    expect(
      screen.getByRole("status", { name: DISK_FULL_SIGN_IN_TITLE }),
    ).toBe(status);
    expect(status.textContent).toBe(
      `${DISK_FULL_SIGN_IN_TITLE} ${DISK_FULL_SIGN_IN_BODY}`,
    );

    act(() => useAuthStore.getState().setSignInStorageLow(false));
    expect(screen.getByRole("status")).toBe(status);
    expect(status.textContent).toBe("");
    expect(status.getAttribute("aria-label")).toBeNull();
    expect(status.classList.contains("sr-only")).toBe(true);
    expect(status.classList.contains("border-warning/30")).toBe(false);
    expect(status.classList.contains("bg-warning/10")).toBe(false);
    expect(status.classList.contains("text-warning-foreground")).toBe(false);
  });
});
