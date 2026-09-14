/**
 * App Store review guideline 5.1.1(v) is satisfied by what this page SAYS as
 * much as by what it does: the option has to be findable, it has to state what
 * is removed and how long it takes, and it must not claim the account is gone
 * the moment the button is pressed. So the copy is pinned here alongside the
 * behaviour - a reviewer reads these sentences, and a silent reword is exactly
 * the change that would get the build rejected again.
 */
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type { OpenLink } from "@/lib/links/open-link";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  data: null as AuthenticatedUser | null,
  // Typed to the seam's own signature so the recorded call is a real
  // `[url, kind, event]` tuple rather than `any[]` - the argument assertions
  // below are the point of these tests.
  openLink: vi.fn<OpenLink>(),
}));

vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => mocks.openLink }));

vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({
    data: mocks.data,
    isPending: false,
    isError: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

import { DeleteAccountSettingsPanel } from "@/components/settings/panels/delete-account-settings-panel";

const EPOCH = new Date(0);

function userWithEmail(email: string | null): AuthenticatedUser {
  return {
    user: {
      id: "u1",
      name: "Ada",
      providerId: "p1",
      providerHandle: "ada",
      providerType: "GITHUB",
      email,
      avatarUrl: null,
      activatedAt: EPOCH,
      createdAt: EPOCH,
      updatedAt: EPOCH,
      lastSeenAt: EPOCH,
      privacyMode: false,
      isLearningEnabled: true,
    },
    userSubscription: {
      id: "sub",
      userID: "u1",
      orgID: null,
      teamID: null,
      customerId: "cus",
      createdAt: EPOCH,
      updatedAt: EPOCH,
      subscriptionExpiry: null,
      trialEndsAt: null,
      hasPaymentMethod: true,
      rechargeRateSeconds: 60,
      subscriptionStatus: "PRO_V3",
      isInTrial: false,
      totalPlanCredits: 100,
    },
    payAsYouGoUsage: { allowPayAsYouGo: false },
    teamSubscriptions: [],
  };
}

describe("DeleteAccountSettingsPanel", () => {
  beforeEach(() => {
    mocks.data = userWithEmail("ada@example.com");
    mocks.openLink.mockClear();
  });

  afterEach(cleanup);

  it("states what is removed, that it is final, and how long it takes", () => {
    render(<DeleteAccountSettingsPanel />);

    expect(screen.getByText("Delete account")).toBeDefined();
    expect(
      screen.getByText(
        "Permanently delete your Traycer account and all associated data.",
      ),
    ).toBeDefined();
    expect(
      screen.getByText(
        "Deleting your account removes your profile, sessions, epics, chats and generated documents from Traycer. This cannot be undone.",
      ),
    ).toBeDefined();
    expect(
      screen.getByText(
        "Requests are processed by our team within 30 days. You will receive a confirmation email at the address on your account when the deletion is complete.",
      ),
    ).toBeDefined();
  });

  it("names the account the request would be for", () => {
    render(<DeleteAccountSettingsPanel />);

    expect(screen.getByTestId("delete-account-signed-in-as").textContent).toBe(
      "Signed in as ada@example.com.",
    );
  });

  it("opens nothing until the confirm is accepted", () => {
    render(<DeleteAccountSettingsPanel />);

    fireEvent.click(screen.getByTestId("delete-account-request"));

    // The press asks; it does not hand off. Anything else would background the
    // app from a control labelled "Request account deletion".
    expect(mocks.openLink).not.toHaveBeenCalled();
    expect(screen.getByTestId("confirm-destructive-dialog")).toBeDefined();
    expect(screen.getByText("Request account deletion?")).toBeDefined();
    // The sentence that has to arrive BEFORE the handoff, not after it.
    expect(
      screen.getByText(
        "We will open a short form to confirm your request. Your account stays active until our team completes the deletion.",
      ),
    ).toBeDefined();
  });

  it("opens the pre-filled form through the account link seam on Continue", () => {
    render(<DeleteAccountSettingsPanel />);

    fireEvent.click(screen.getByTestId("delete-account-request"));
    const confirm = screen.getByTestId("confirm-action");
    expect(confirm.textContent).toBe("Continue");
    fireEvent.click(confirm);

    expect(mocks.openLink).toHaveBeenCalledTimes(1);
    const [url, kind, event] = mocks.openLink.mock.calls[0];
    // `account` is hard-external, so the in-app link preference never applies
    // and the runner-error mapping behind the seam still runs.
    expect(kind).toBe("account");
    expect(event).toBeNull();
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://docs.google.com");
    // Both address branches are prefilled; the sign-in method is left for the
    // user (this account signs in with GitHub, per the fixture).
    expect(parsed.searchParams.get("entry.833738174")).toBe("ada@example.com");
    expect(parsed.searchParams.get("entry.671973110")).toBe("ada@example.com");
    expect(parsed.searchParams.has("entry.1825201942")).toBe(false);
  });

  it("dismisses the confirm and opens nothing on Cancel", () => {
    render(<DeleteAccountSettingsPanel />);

    fireEvent.click(screen.getByTestId("delete-account-request"));
    fireEvent.click(screen.getByTestId("confirm-cancel"));

    expect(mocks.openLink).not.toHaveBeenCalled();
  });

  it("still offers the form when the account address has not resolved", () => {
    mocks.data = userWithEmail(null);
    render(<DeleteAccountSettingsPanel />);

    // No line claiming an account, since there is no address to name.
    expect(screen.queryByTestId("delete-account-signed-in-as")).toBeNull();

    fireEvent.click(screen.getByTestId("delete-account-request"));
    fireEvent.click(screen.getByTestId("confirm-action"));

    expect(mocks.openLink).toHaveBeenCalledTimes(1);
    const [url] = mocks.openLink.mock.calls[0];
    const parsed = new URL(url);
    // The form still opens, with no address prefilled for the user to submit.
    expect(parsed.origin).toBe("https://docs.google.com");
    expect(parsed.searchParams.has("entry.833738174")).toBe(false);
    expect(parsed.searchParams.has("entry.671973110")).toBe(false);
  });

  it("names no account before the user query has answered", () => {
    mocks.data = null;
    render(<DeleteAccountSettingsPanel />);

    expect(screen.queryByTestId("delete-account-signed-in-as")).toBeNull();
    expect(screen.getByTestId("delete-account-request")).toBeDefined();
  });
});
