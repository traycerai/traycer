import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentSecretV12,
  EnvironmentSecretsListResponseV12,
} from "@traycer/protocol/host/environment-schemas";
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

/**
 * The team's page as `role` reads it. A team's own roles are admin, editor and
 * viewer: `owner` is the role of a user-owned configuration, and the boundary
 * reads an organization descriptor claiming it as a viewer
 * (`configurationRoleOf`), so a case about an editor must name one.
 */
function renderPanel(options: {
  readonly secrets: readonly EnvironmentSecretV12[];
  readonly listError: { current: Error | null };
  readonly role: "admin" | "viewer";
  readonly removed: EnvironmentSecretsListResponseV12["removed"];
}): TeamPageHarness {
  const { secrets, listError, role, removed } = options;
  useSettingsEnvironmentPickStore.setState({
    pick: { kind: "team", environmentId: "env-a" },
  });
  const harness = mountTeamPage(poolSource(role), {
    "environment.secrets.list": () => {
      if (listError.current !== null) throw listError.current;
      return { secrets: [...secrets], removed: [...removed] };
    },
    "environment.list": () => ({
      environments: [
        {
          environmentId: "env-a",
          ownerKind: "organization" as const,
          ownerId: "team-a",
          roomId: "room-a",
          label: "Acme",
          effectiveRole: role,
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
    renderPanel({
      secrets: [],
      listError: { current: null },
      role: "admin",
      removed: [],
    });

    const empty = await screen.findByTestId("secrets-empty");
    expect(empty.textContent).toBe(TEAM_SUBTITLE);
    expect(empty.textContent).not.toContain("On your computers");
    expect(screen.getAllByText(TEAM_SUBTITLE)).toHaveLength(1);
  });

  it("shows the subtitle once there are secrets", async () => {
    renderPanel({
      secrets: [secret("OPENAI_API_KEY")],
      listError: { current: null },
      role: "admin",
      removed: [],
    });

    await screen.findByText("OPENAI_API_KEY");
    expect(screen.getAllByText(TEAM_SUBTITLE)).toHaveLength(1);
    expect(screen.queryByTestId("secrets-empty")).toBeNull();
  });

  it("keeps the subtitle once, and shows no empty claim, when the first read of the list fails", async () => {
    renderPanel({
      secrets: [],
      listError: { current: new Error("down") },
      role: "admin",
      removed: [],
    });

    await screen.findByTestId("secrets-page-error");
    // No authoritative answer yet: not "no secrets", and the failure line
    // does not say the subtitle, so the header does.
    expect(screen.queryByTestId("secrets-empty")).toBeNull();
    expect(screen.getAllByText(TEAM_SUBTITLE)).toHaveLength(1);
  });

  it("keeps an empty answer it already had, and the subtitle once, when a later read of the list fails", async () => {
    const listError: { current: Error | null } = { current: null };
    const harness = renderPanel({
      secrets: [],
      listError,
      role: "admin",
      removed: [],
    });
    await screen.findByTestId("secrets-empty");

    listError.current = new Error("down");
    await harness.queryClient.invalidateQueries();

    await screen.findByTestId("secrets-page-error");
    expect(screen.getByTestId("secrets-empty").textContent).toBe(TEAM_SUBTITLE);
    expect(screen.getAllByText(TEAM_SUBTITLE)).toHaveLength(1);
  });

  // NEW-154-24: a viewer read "Read-only" top right with the subtitle twice,
  // and a heading over no list. K1-a: a remote error body never reaches the
  // person.
  it("gives a viewer the standing line instead of a Read-only tag", async () => {
    renderPanel({
      secrets: [secret("OPENAI_API_KEY")],
      listError: { current: null },
      role: "viewer",
      removed: [],
    });

    await screen.findByText("OPENAI_API_KEY");
    expect(screen.queryByText("Read-only")).toBeNull();
    expect(screen.queryByText("Editors can replace these")).toBeNull();
    expect(
      screen.getAllByText("You can see Acme's settings but not change them."),
    ).toHaveLength(1);
    expect(screen.getAllByText(TEAM_SUBTITLE)).toHaveLength(1);
  });

  it("lists a viewer's secrets and their states, and says None rather than the subtitle", async () => {
    renderPanel({
      secrets: [],
      listError: { current: null },
      role: "viewer",
      removed: [],
    });

    expect(await screen.findByText("No secrets.")).toBeTruthy();
    expect(screen.queryByTestId("secrets-empty")).toBeNull();
    expect(screen.getAllByText(TEAM_SUBTITLE)).toHaveLength(1);
  });

  it("shows a viewer a removal that is still waiting", async () => {
    renderPanel({
      secrets: [],
      listError: { current: null },
      role: "viewer",
      removed: [
        {
          id: "sec-OLD_TOKEN",
          name: "OLD_TOKEN",
          removal: {
            outcome: "cleanup_requested",
            revokedAt: 1,
            destroyedAt: null,
            targets: [],
          },
        },
      ],
    });

    expect(await screen.findByText("OLD_TOKEN")).toBeTruthy();
    expect(screen.queryByText("No secrets.")).toBeNull();
  });

  it("keeps the ruled failure line whatever the remote body says", async () => {
    renderPanel({
      secrets: [],
      listError: {
        current: new Error("the destination api.example.com does not resolve"),
      },
      role: "admin",
      removed: [],
    });

    const failure = await screen.findByTestId("secrets-page-error");
    expect(failure.textContent).toContain("Couldn't read Acme's secrets.");
    expect(document.body.textContent).not.toContain("api.example.com");
    expect(document.body.textContent).not.toContain("does not resolve");
  });

  it("puts Details in the header beside the chip, not in the page body", async () => {
    renderPanel({
      secrets: [secret("OPENAI_API_KEY")],
      listError: { current: null },
      role: "admin",
      removed: [],
    });

    const page = await screen.findByTestId("secrets-page");
    const details = await screen.findByRole("button", { name: "Details" });
    const header = details.closest("header");
    if (header === null) throw new Error("Details is not inside a header");
    expect(within(header).getByTestId("page-chip")).toBeTruthy();
    expect(details.parentElement).toBe(
      within(header).getByTestId("page-chip").parentElement,
    );
    // Each secret row carries its own Details; what the body must not repeat
    // is the page's own, which belongs to the header.
    expect(
      within(page)
        .queryAllByRole("button", { name: "Details" })
        .filter((button) => button.closest("li") === null),
    ).toEqual([]);
  });
});
