import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  render(<AddCreditsLink configuration={configuration} testId="add-credits" />);
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

  it("opens a team's billing page when the team is among the shareable teams", () => {
    useAuthStore.setState({
      shareableTeams: [
        { teamId: "team-pool", slug: "pool-e2e-fixture", avatarUrl: null },
      ],
    });

    openAddCredits(POOL);

    expect(mocks.openLink).toHaveBeenCalledWith(
      "https://platform.example.dev/team/pool-e2e-fixture/billing",
      "account",
    );
  });

  it("opens the same team page for a team the list does not hold, never the Personal top-up", () => {
    openAddCredits(POOL);

    expect(mocks.openLink).toHaveBeenCalledWith(
      "https://platform.example.dev/team/pool-e2e-fixture/billing",
      "account",
    );
  });

  it("opens the person's own billing page for Personal", () => {
    openAddCredits({ kind: "personal" });

    expect(mocks.openLink).toHaveBeenCalledWith(
      "https://platform.example.dev/billing",
      "account",
    );
  });
});
