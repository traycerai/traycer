import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentSecretV12 } from "@traycer/protocol/host/environment-schemas";
import {
  mountTeamPage,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import { SecretsSettingsPanel } from "@/components/settings/panels/secrets-settings-panel";
import { HeldValueHostRuntime } from "@/components/settings/personal/__tests__/held-value-host-runtime";
import { PersonalPageFrame } from "@/components/settings/personal/personal-page-frame";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));
// The configuration status chip reads the host runtime this suite does not
// mount, and none of these cases is about it.
vi.mock("@/components/settings/personal/page-chip", () => ({
  PageChip: () => <span data-testid="page-chip" />,
}));

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

// The header's subtitle on a team's page names the team.
const TEAM_SUBTITLE =
  "Values and logins Acme's agents use, on its sandboxes without being seen.";

function secret(name: string): EnvironmentSecretV12 {
  return {
    secretId: `sec-${name}`,
    name,
    kind: "api_key",
    protocol: null,
    destinations: ["api.example.com"],
    mode: "brokered",
    state: "live",
    currentVersionId: "ver-1",
    revoked: false,
    updatedAt: 1,
    variables: [],
    providerVariables: [],
  };
}

function renderPanel(
  secrets: readonly EnvironmentSecretV12[],
  listError: { current: Error | null },
): TeamPageHarness {
  useSettingsEnvironmentPickStore.setState({
    pick: { kind: "team", environmentId: "env-a" },
  });
  const harness = mountTeamPage(poolSource("owner"), {
    "environment.secrets.list": () => {
      if (listError.current !== null) throw listError.current;
      return { secrets: [...secrets], removed: [] };
    },
    "environment.list": () => ({
      environments: [
        {
          environmentId: "env-a",
          ownerKind: "organization" as const,
          ownerId: "team-a",
          roomId: "room-a",
          label: "Acme",
          effectiveRole: "owner" as const,
          kind: "team" as const,
          hostCount: 1,
          providerHandle: null,
        },
      ],
    }),
  });
  render(
    <HeldValueHostRuntime>
      <PersonalPageFrame section="secrets">
        <SecretsSettingsPanel />
      </PersonalPageFrame>
    </HeldValueHostRuntime>,
    { wrapper: harness.Wrapper },
  );
  return harness;
}

describe("the Secrets page header", () => {
  it("has no subtitle while the list is empty, so the empty state says it once", async () => {
    renderPanel([], { current: null });

    const empty = await screen.findByTestId("secrets-empty");
    expect(empty.textContent).toBe(TEAM_SUBTITLE);
    expect(empty.textContent).not.toContain("On your computers");
    expect(screen.getAllByText(TEAM_SUBTITLE)).toHaveLength(1);
  });

  it("shows the subtitle once there are secrets", async () => {
    renderPanel([secret("OPENAI_API_KEY")], { current: null });

    await screen.findByText("OPENAI_API_KEY");
    expect(screen.getAllByText(TEAM_SUBTITLE)).toHaveLength(1);
    expect(screen.queryByTestId("secrets-empty")).toBeNull();
  });

  it("keeps the subtitle once, and shows no empty claim, when the first read of the list fails", async () => {
    renderPanel([], { current: new Error("down") });

    await screen.findByTestId("secrets-page-error");
    // No authoritative answer yet: not "no secrets", and the failure line
    // does not say the subtitle, so the header does.
    expect(screen.queryByTestId("secrets-empty")).toBeNull();
    expect(screen.getAllByText(TEAM_SUBTITLE)).toHaveLength(1);
  });

  it("keeps an empty answer it already had, and the subtitle once, when a later read of the list fails", async () => {
    const listError: { current: Error | null } = { current: null };
    const harness = renderPanel([], listError);
    await screen.findByTestId("secrets-empty");

    listError.current = new Error("down");
    await harness.queryClient.invalidateQueries();

    await screen.findByTestId("secrets-page-error");
    expect(screen.getByTestId("secrets-empty").textContent).toBe(TEAM_SUBTITLE);
    expect(screen.getAllByText(TEAM_SUBTITLE)).toHaveLength(1);
  });

  it("puts Details in the header beside the chip, not in the page body", async () => {
    renderPanel([secret("OPENAI_API_KEY")], { current: null });

    const page = await screen.findByTestId("secrets-page");
    const details = await screen.findByRole("button", { name: "Details" });
    const header = details.closest("header");
    if (header === null) throw new Error("Details is not inside a header");
    expect(within(header).getByTestId("page-chip")).toBeTruthy();
    expect(details.parentElement).toBe(
      within(header).getByTestId("page-chip").parentElement,
    );
    expect(within(page).queryByRole("button", { name: "Details" })).toBeNull();
  });
});
