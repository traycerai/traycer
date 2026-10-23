import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentSecret } from "@traycer/protocol/host/environment-schemas";
import type { EnvironmentMembersResponseV11 } from "@traycer/protocol/host/environment/contracts";
import { TeamPermissions } from "@/components/settings/environment/team-permissions";
import { SecretsPage } from "@/components/settings/secrets/secrets-page";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import {
  configurationItem,
  mountTeamPage,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "./team-configuration-test-support";

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

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

function secret(name: string, revoked: boolean): EnvironmentSecret {
  return {
    secretId: `sec-${name}`,
    name,
    kind: "api_key",
    protocol: null,
    destinations: ["api.example.com"],
    mode: "brokered",
    state: "live",
    currentVersionId: "ver-1",
    revoked,
    updatedAt: 1,
  };
}

const environments = {
  environments: [
    {
      environmentId: "env-personal",
      ownerKind: "user" as const,
      ownerId: "user-me",
      roomId: "room-personal",
      label: "Personal",
      effectiveRole: "owner" as const,
      kind: "personal" as const,
      hostCount: 1,
      providerHandle: null,
    },
  ],
};

function renderSecrets(harness: TeamPageHarness): void {
  const client = requireTeamHostClient();
  render(
    <SecretsPage
      client={client}
      hostId={client.getActiveHostId()}
      hostName={(hostId) => hostId}
    />,
    { wrapper: harness.Wrapper },
  );
}

describe("SecretsPage on a team", () => {
  function teamHandlers() {
    return {
      "environment.secrets.list": () => ({
        secrets: [secret("OPENAI_API_KEY", false), secret("OLD_TOKEN", true)],
        removed: [],
      }),
      "environment.list": () => environments,
    } as const;
  }

  it("reads the team's secret names by environment id behind the 1.1 floor", async () => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "team", environmentId: "env-a" },
    });
    const harness = mountTeamPage(poolSource("viewer"), teamHandlers());
    renderSecrets(harness);

    expect(await screen.findByText("OPENAI_API_KEY")).toBeTruthy();
    expect(harness.paramsOf("environment.secrets.list")).toEqual([
      { environmentId: "env-a" },
    ]);
    const call = harness.messenger.calls.find(
      (entry) => entry.method === "environment.secrets.list",
    );
    expect(call?.requiredHostMethodVersion).toEqual({
      method: "environment.secrets.list",
      version: { major: 1, minor: 1 },
    });
  });

  it("gives a viewer the names and header Details but no secret verbs or credential fields", async () => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "team", environmentId: "env-a" },
    });
    const harness = mountTeamPage(poolSource("viewer"), teamHandlers());
    renderSecrets(harness);

    expect(await screen.findByText("OPENAI_API_KEY")).toBeTruthy();
    expect(screen.getByText("Access revoked")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Details" })).toBeTruthy();
    for (const verb of ["Add a secret", "Verify", "Replace value", "Remove"]) {
      expect(screen.queryByRole("button", { name: verb })).toBeNull();
    }
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryByTestId("secrets-add")).toBeNull();
  });

  it("gives an editor the secret verbs", async () => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "team", environmentId: "env-a" },
    });
    const harness = mountTeamPage(poolSource("editor"), teamHandlers());
    renderSecrets(harness);

    const list = await screen.findByTestId("secrets-list");
    expect(within(list).getByText("OPENAI_API_KEY")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a secret" })).toBeTruthy();
    expect(
      within(list).getAllByRole("button", { name: "Verify" }).length,
    ).toBeGreaterThan(0);
  });

  it("keeps the host path unchanged: no environment id and no floor", async () => {
    const harness = mountTeamPage({ kind: "host" }, teamHandlers());
    renderSecrets(harness);

    expect(await screen.findByTestId("secrets-list")).toBeTruthy();
    expect(harness.paramsOf("environment.secrets.list")).toEqual([
      { environmentId: null },
    ]);
    const call = harness.messenger.calls.find(
      (entry) => entry.method === "environment.secrets.list",
    );
    expect(call?.requiredHostMethodVersion).toBeNull();
  });
});

describe("TeamPermissions", () => {
  const policy = (revision: number, body: string) =>
    configurationItem({
      kind: "auto_policy",
      key: "policy",
      value: { body },
      revision,
    });
  const members: EnvironmentMembersResponseV11 = {
    members: [
      {
        userId: "u-1",
        displayName: "Ada",
        avatarUrl: null,
        effectiveRole: "admin",
        linkedPlan: false,
        inviteState: "accepted",
        invitedAddress: null,
      },
    ],
    nextCursor: null,
    legacyRoleNoticeSeenAt: null,
    legacyMembers: [],
  };

  it("shows an editor the policy read-only and names the admins who change it", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({
        items: [policy(3, "Allow reads")],
      }),
      "environment.members": () => members,
    });
    render(<TeamPermissions />, { wrapper: harness.Wrapper });

    expect(await screen.findByText("Admins change this: Ada.")).toBeTruthy();
    expect(
      screen.getByRole("textbox", { name: "Approval policy" }).textContent,
    ).toContain("Allow reads");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Reset to default" }),
    ).toBeNull();
    expect(harness.paramsOf("environment.configuration.items")[0]).toEqual({
      environmentId: "env-a",
    });
  });

  it("still shows the policy when the member roster fails to load", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({
        items: [policy(3, "Allow reads")],
      }),
      "environment.members": () => Promise.reject(new Error("roster down")),
    });
    render(<TeamPermissions />, { wrapper: harness.Wrapper });

    expect(await screen.findByText("Admins change this.")).toBeTruthy();
    expect(
      screen.getByRole("textbox", { name: "Approval policy" }).textContent,
    ).toContain("Allow reads");
  });

  it("quotes the displayed policy version, and a stale refusal rereads the current policy", async () => {
    let current = policy(3, "Allow reads");
    const harness = mountTeamPage(poolSource("admin"), {
      "environment.configuration.items": () => ({ items: [current] }),
      "environment.members": () => members,
      "environment.configuration.policy.put": () => {
        current = policy(4, "Ask before writes");
        return { outcome: "refused", reason: "policy_stale" };
      },
    });
    render(<TeamPermissions />, { wrapper: harness.Wrapper });

    await userEvent.click(
      await screen.findByRole("button", { name: "Reset to default" }),
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Reset to default" }),
    );

    expect(harness.paramsOf("environment.configuration.policy.put")).toEqual([
      { environmentId: "env-a", body: "", policyVersion: "3" },
    ]);
    expect(
      await screen.findByText("Changed by another member a moment ago"),
    ).toBeTruthy();
    await waitFor(() => {
      expect(
        screen.getByRole("textbox", { name: "Approval policy" }).textContent,
      ).toContain("Ask before writes");
    });
  });
});
