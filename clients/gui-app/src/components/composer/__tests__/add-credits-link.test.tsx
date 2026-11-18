import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderWithQueryClient } from "@/components/composer/__tests__/composer-query-wrapper";
import { AddCreditsLink } from "@/components/composer/consequences-block";
import type { StageConfiguration } from "@/lib/sandboxes/sandbox-stage-model";
import { useAuthStore } from "@/stores/auth/auth-store";

const mocks = vi.hoisted(() => ({
  openLink: vi.fn<(url: string, kind: string) => void>(),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ signInUrl: "https://platform.example.dev/sign-in" }),
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => (url: string, kind: string) => {
    mocks.openLink(url, kind);
    return Promise.resolve();
  },
}));

const POOL: StageConfiguration = {
  kind: "team",
  teamId: "team-pool",
  teamName: "pool-e2e-fixture",
};

function openAddCredits(configuration: StageConfiguration): void {
  renderWithQueryClient(
    <AddCreditsLink configuration={configuration} testId="add-credits" />,
  );
  fireEvent.click(screen.getByTestId("add-credits"));
}

describe("<AddCreditsLink />", () => {
  beforeEach(() => {
    useAuthStore.setState({ shareableTeams: [] });
  });
  afterEach(() => {
    cleanup();
    mocks.openLink.mockReset();
    useAuthStore.setState({ shareableTeams: [] });
  });

  it("draws no link for a team's member who is not its Admin, and never the Personal top-up", () => {
    useAuthStore.setState({
      shareableTeams: [
        { teamId: "team-pool", slug: "pool-e2e-fixture", avatarUrl: null },
      ],
    });
    renderWithQueryClient(
      <AddCreditsLink configuration={POOL} testId="add-credits" />,
    );

    expect(screen.queryByTestId("add-credits")).toBeNull();
    expect(mocks.openLink).not.toHaveBeenCalled();
  });

  it("opens the person's own billing page for Personal", () => {
    openAddCredits({ kind: "personal" });

    expect(mocks.openLink).toHaveBeenCalledWith(
      "https://platform.example.dev/billing",
      "account",
    );
  });
});
