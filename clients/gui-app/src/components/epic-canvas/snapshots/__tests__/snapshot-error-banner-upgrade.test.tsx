import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SnapshotErrorBanner } from "@/components/epic-canvas/snapshots/snapshot-error-banner";
import { useAccountContextStore } from "@/stores/auth/account-context-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { SnapshotFetchError } from "@/stores/epics/open-epic/store";

/**
 * "Cloud sync is not available on your current plan" is answered by a plan,
 * so its Upgrade opens the Billing page of the account selected in the app -
 * never the bare platform origin, which is the marketing homepage.
 */

const mocks = vi.hoisted(() => ({
  openLink: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicRequestFreshSnapshot: () => () => undefined,
}));

vi.mock("@/lib/links/open-link", () => ({
  useOpenLinkWithPending: () => ({
    isPending: false,
    openLink: mocks.openLink,
  }),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    authnBaseUrl: "https://authn.test",
    signInUrl: "https://platform.test/sign-in",
  }),
}));

const ENTITLEMENT_ERROR: SnapshotFetchError = {
  code: "ENTITLEMENT_REQUIRED",
  message: "Cloud sync is not available on your current plan.",
  localStoreRemedy: undefined,
  upgradeGuidance: null,
};

afterEach(() => {
  cleanup();
  mocks.openLink.mockClear();
  useAuthStore.setState({ shareableTeams: [] });
  useAccountContextStore.setState({ accountContext: { type: "PERSONAL" } });
});

describe("SnapshotErrorBanner Upgrade", () => {
  it("opens the personal Billing page", () => {
    render(
      <SnapshotErrorBanner error={ENTITLEMENT_ERROR} className={undefined} />,
    );

    fireEvent.click(screen.getByTestId("snapshot-error-upgrade"));

    // The link kind is unchanged: only the address moved.
    expect(mocks.openLink).toHaveBeenCalledExactlyOnceWith(
      "https://platform.test/billing",
      "auth",
      null,
    );
  });

  it("opens the selected team's Billing page", () => {
    useAuthStore.setState({
      shareableTeams: [{ teamId: "team-1", slug: "acme", avatarUrl: null }],
    });
    useAccountContextStore.setState({
      accountContext: { type: "TEAM", teamId: "team-1" },
    });
    render(
      <SnapshotErrorBanner error={ENTITLEMENT_ERROR} className={undefined} />,
    );

    fireEvent.click(screen.getByTestId("snapshot-error-upgrade"));

    expect(mocks.openLink).toHaveBeenCalledExactlyOnceWith(
      "https://platform.test/team/acme/billing",
      "auth",
      null,
    );
  });
});
