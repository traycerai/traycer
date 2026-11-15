import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SandboxBillingRuntime } from "@/hooks/sandboxes/__tests__/sandbox-billing-runtime-fixture";
import { serveEnvironmentList } from "@/hooks/sandboxes/__tests__/sandbox-environment-list-fixture";
import { AddCreditsLink } from "@/components/composer/consequences-block";
import type { StageConfiguration } from "@/lib/sandboxes/sandbox-stage-model";
import { useAuthStore } from "@/stores/auth/auth-store";

// The one case that runs the link over a real host runtime, so the file does
// not replace the runner host the way `add-credits-link.test.tsx` does.
const mocks = vi.hoisted(() => ({
  openLink: vi.fn<(url: string, kind: string) => void>(),
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
const POOL_TEAM = { id: "team-pool", slug: "pool-e2e-fixture" } as const;

afterEach(() => {
  cleanup();
  mocks.openLink.mockReset();
  useAuthStore.setState({ shareableTeams: [] });
});

describe("<AddCreditsLink /> for a team's Admin", () => {
  it("opens the team's billing page once the person's environment list names them its Admin", async () => {
    render(
      <SandboxBillingRuntime
        answer={{ kind: "ready", role: "admin" }}
        environmentId="env-pool"
        hostId="billing-host"
        queryClient={undefined}
        onBinding={(binding) => {
          // The team is the person's own: its environment, and its place in
          // their account, which the billing page's address is built from.
          vi.spyOn(binding.auth, "getTeamEnvironment").mockResolvedValue({
            kind: "ok",
            environmentId: "env-pool",
          });
          serveEnvironmentList(binding.auth, {
            answer: { kind: "ready", role: "admin" },
            environmentId: "env-pool",
            team: POOL_TEAM,
            onRead: null,
          });
        }}
        onEnvironmentListRead={null}
      >
        <AddCreditsLink configuration={POOL} testId="add-credits" />
      </SandboxBillingRuntime>,
    );

    fireEvent.click(await screen.findByTestId("add-credits"));

    expect(mocks.openLink).toHaveBeenCalledTimes(1);
    expect(mocks.openLink.mock.calls[0]?.[0]).toMatch(
      /\/team\/pool-e2e-fixture\/billing$/u,
    );
    expect(mocks.openLink.mock.calls[0]?.[1]).toBe("account");
  });
});
