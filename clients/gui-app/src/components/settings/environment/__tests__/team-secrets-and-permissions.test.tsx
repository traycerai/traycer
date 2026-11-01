import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentSecretV12 } from "@traycer/protocol/host/environment-schemas";
import type { EnvironmentMembersResponseV12 } from "@traycer/protocol/host/environment/contracts";
import { TeamPermissions } from "@/components/settings/environment/team-permissions";
import { TeamProviderKeys } from "@/components/settings/environment/team-provider-keys";
import { SecretsSettingsPanel } from "@/components/settings/panels/secrets-settings-panel";
import { SecretsPage } from "@/components/settings/secrets/secrets-page";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import {
  configurationItem,
  mountTeamPage,
  personalPoolSource,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "./team-configuration-test-support";
import { SECRETS_EMPTY_TEXT } from "@/lib/sandboxes/secrets-page-copy";

// The computers holding a copy are covered by `secret-remove-preview-computers`.
vi.mock(
  "@/components/settings/environment/use-hosts-running-configuration",
  () => ({
    useHostsRunningPersonal: () => ({
      hosts: [],
      state: "ready",
      collisions: [],
      retry: () => undefined,
    }),
  }),
);
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

// Resolving a client for the picked viewing host needs the app's host directory.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null ? null : requireTeamHostClient(),
}));

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

function secret(name: string, revoked: boolean): EnvironmentSecretV12 {
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
    variables: [],
    providerVariables: [],
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
      emptyText={SECRETS_EMPTY_TEXT}
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

  it("gives a viewer the names but no secret verbs or credential fields", async () => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "team", environmentId: "env-a" },
    });
    const harness = mountTeamPage(poolSource("viewer"), teamHandlers());
    renderSecrets(harness);

    expect(await screen.findByText("OPENAI_API_KEY")).toBeTruthy();
    expect(screen.getByText("Removing · no longer usable")).toBeTruthy();
    for (const verb of ["Add a secret", "Verify", "Replace", "Remove"]) {
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
    // Verify lives in a secret's Details, with Replace and Remove on the row.
    expect(
      within(list)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(expect.arrayContaining(["Replace", "Remove", "Details"]));
    expect(within(list).queryByRole("button", { name: "Verify" })).toBeNull();
  });

  it("names the team in the page description, and keeps Personal's shared one", async () => {
    const harness = mountTeamPage(poolSource("viewer"), {
      ...teamHandlers(),
      "environment.list": () => ({
        environments: [
          ...environments.environments,
          {
            environmentId: "env-a",
            ownerKind: "organization" as const,
            ownerId: "team-a",
            roomId: "room-a",
            label: "Acme",
            effectiveRole: "viewer" as const,
            kind: "team" as const,
            hostCount: 1,
            providerHandle: "handle-a",
          },
        ],
      }),
      "environment.host.list": () => ({ hosts: [] }),
    });
    render(<SecretsSettingsPanel />, { wrapper: harness.Wrapper });
    expect(
      await screen.findByText(
        "Values and logins Acme's agents use, on its sandboxes without being seen.",
      ),
    ).toBeTruthy();
    cleanup();
    resetTeamPageHarness();

    const personal = mountTeamPage(personalPoolSource(), {
      ...teamHandlers(),
      "environment.host.list": () => ({ hosts: [] }),
    });
    render(<SecretsSettingsPanel />, { wrapper: personal.Wrapper });
    await screen.findByTestId("secrets-list");
    expect(screen.getByText("Values and logins your agents use.")).toBeTruthy();
    expect(screen.queryByText(/Acme/)).toBeNull();
  });

  it("names Personal's own environment on the Personal pick, behind the 1.1 floor, and reads nothing before it is known", async () => {
    const harness = mountTeamPage({ kind: "host" }, teamHandlers());
    renderSecrets(harness);

    expect(await screen.findByTestId("secrets-list")).toBeTruthy();
    expect(harness.paramsOf("environment.secrets.list")).toEqual([
      { environmentId: "env-personal" },
    ]);
    const call = harness.messenger.calls.find(
      (entry) => entry.method === "environment.secrets.list",
    );
    expect(call?.requiredHostMethodVersion).toEqual({
      method: "environment.secrets.list",
      version: { major: 1, minor: 1 },
    });
  });

  it("keeps a Local pick on the host's own environment: no environment id and no floor", async () => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: "host-local", hostName: "dev-box" },
    });
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

describe("TeamProviderKeys", () => {
  it("opens an editor's Add a key straight on the provider key form, without the kind picker", async () => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "team", environmentId: "env-a" },
    });
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.secrets.list": () => ({ secrets: [], removed: [] }),
      "environment.list": () => environments,
    });
    render(<TeamProviderKeys />, { wrapper: harness.Wrapper });

    await userEvent.click(
      await screen.findByRole("button", { name: "Add a key" }),
    );

    expect(await screen.findByTestId("add-secret-dialog")).toBeTruthy();
    expect(await screen.findByTestId("secret-form-name")).toBeTruthy();
    expect(screen.queryByTestId("secret-kind-picker")).toBeNull();
    expect(screen.queryByTestId("secret-provider-keys-line")).toBeNull();
  });

  // "No secrets." is a claim about the configuration, and a read that failed
  // supports no claim about it. Worse, the page says on the same screen that
  // the keys could not be read, so the two lines would contradict each other.
  it("says nothing to a viewer about a list it could not read", async () => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "team", environmentId: "env-a" },
    });
    const harness = mountTeamPage(poolSource("viewer"), {
      "environment.secrets.list": () => {
        throw new Error("down");
      },
      "environment.list": () => environments,
    });
    render(<TeamProviderKeys />, { wrapper: harness.Wrapper });

    expect(await screen.findByText(/Couldn't read .*keys\./)).toBeTruthy();
    expect(screen.queryByTestId("secrets-none")).toBeNull();
  });

  // And it says nothing before the answer, either: an empty list and an
  // unanswered read look the same from here, and only one of them means there
  // are none.
  it("says nothing to a viewer until the read answers, then says there are none", async () => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "team", environmentId: "env-a" },
    });
    const answer = Promise.withResolvers<void>();
    const harness = mountTeamPage(poolSource("viewer"), {
      "environment.secrets.list": async () => {
        await answer.promise;
        return { secrets: [], removed: [] };
      },
      "environment.list": () => environments,
    });
    render(<TeamProviderKeys />, { wrapper: harness.Wrapper });

    expect(
      await screen.findByRole("heading", { name: "Model provider keys" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("secrets-none")).toBeNull();

    answer.resolve();

    expect(await screen.findByTestId("secrets-none")).toBeTruthy();
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
  const members: EnvironmentMembersResponseV12 = {
    members: [
      {
        userId: "u-1",
        displayName: "Ada",
        email: "ada@acme.test",
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
    render(<TeamPermissions>{null}</TeamPermissions>, {
      wrapper: harness.Wrapper,
    });

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

  it("draws the page's regions below the policy", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({
        items: [policy(3, "Allow reads")],
      }),
      "environment.members": () => members,
    });
    render(
      <TeamPermissions>
        <div data-testid="below-the-policy" />
      </TeamPermissions>,
      { wrapper: harness.Wrapper },
    );

    const policyBox = await screen.findByRole("textbox", {
      name: "Approval policy",
    });
    expect(
      policyBox.compareDocumentPosition(
        screen.getByTestId("below-the-policy"),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("names the team in the subtitle, and a failed policy read shows one line whose Retry reads again", async () => {
    let fail = true;
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => {
        if (fail) throw new Error("host unavailable");
        return { items: [policy(3, "Allow reads")] };
      },
      "environment.members": () => members,
      "environment.list": () => ({
        environments: [
          {
            environmentId: "env-a",
            ownerKind: "organization" as const,
            ownerId: "team-a",
            roomId: "room-a",
            label: "Acme",
            effectiveRole: "editor" as const,
            kind: "team" as const,
            hostCount: 1,
            providerHandle: "handle-a",
          },
        ],
      }),
    });
    render(<TeamPermissions>{null}</TeamPermissions>, {
      wrapper: harness.Wrapper,
    });

    const failure = await screen.findByText(
      "Couldn't read Acme's permissions.",
    );
    expect(
      await screen.findByText(
        "What Acme's agents may do without asking, on every host running Acme.",
      ),
    ).toBeTruthy();
    const reads = harness.paramsOf("environment.configuration.items").length;

    fail = false;
    await userEvent.click(
      within(failure.closest("p") ?? failure).getByRole("button", {
        name: "Retry",
      }),
    );

    expect(
      (await screen.findByRole("textbox", { name: "Approval policy" }))
        .textContent,
    ).toContain("Allow reads");
    expect(
      harness.paramsOf("environment.configuration.items").length,
    ).toBeGreaterThan(reads);
  });

  it.each([
    [
      "a team",
      poolSource("admin"),
      "This removes Acme's custom rules and goes back to the default approval policy for every member's agents.",
    ],
    [
      "Personal",
      personalPoolSource(),
      "This removes your custom rules and goes back to the default approval policy on every computer and sandbox running Personal.",
    ],
  ])(
    "confirms a reset for %s in that configuration's words",
    async (_name, source, sentence) => {
      const harness = mountTeamPage(source, {
        "environment.configuration.items": () => ({
          items: [policy(3, "Allow reads")],
        }),
        "environment.members": () => members,
        "environment.list": () => ({
          environments: [
            {
              environmentId: "env-a",
              ownerKind: "organization" as const,
              ownerId: "team-a",
              roomId: "room-a",
              label: "Acme",
              effectiveRole: "admin" as const,
              kind: "team" as const,
              hostCount: 1,
              providerHandle: "handle-a",
            },
            {
              environmentId: "env-personal",
              ownerKind: "user" as const,
              ownerId: "user-me",
              roomId: "room-personal",
              label: "Me",
              effectiveRole: "owner" as const,
              kind: "personal" as const,
              hostCount: 1,
              providerHandle: null,
            },
          ],
        }),
      });
      render(<TeamPermissions>{null}</TeamPermissions>, {
        wrapper: harness.Wrapper,
      });

      await userEvent.click(
        await screen.findByRole("button", { name: "Reset to default" }),
      );
      const dialog = await screen.findByRole("dialog");
      await waitFor(() => {
        expect(within(dialog).getByText(sentence)).toBeTruthy();
      });
      expect(
        within(dialog).getByRole("button", { name: "Cancel" }),
      ).toBeTruthy();
      expect(
        within(dialog).getByRole("button", { name: "Reset to default" }),
      ).toBeTruthy();
    },
  );

  it("names Personal when its policy cannot be read, and Retry reads again", async () => {
    const harness = mountTeamPage(personalPoolSource(), {
      "environment.configuration.items": () => {
        throw new Error("host unavailable");
      },
      "environment.members": () => members,
      "environment.list": () => ({
        environments: [
          {
            environmentId: "env-personal",
            ownerKind: "user" as const,
            ownerId: "user-me",
            roomId: "room-personal",
            label: "Me",
            effectiveRole: "owner" as const,
            kind: "personal" as const,
            hostCount: 1,
            providerHandle: null,
          },
        ],
      }),
    });
    render(<TeamPermissions>{null}</TeamPermissions>, {
      wrapper: harness.Wrapper,
    });

    const failure = await screen.findByText(
      "Couldn't read Personal's permissions.",
    );
    const reads = harness.paramsOf("environment.configuration.items").length;
    await userEvent.click(
      within(failure.closest("p") ?? failure).getByRole("button", {
        name: "Retry",
      }),
    );
    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items").length,
      ).toBeGreaterThan(reads);
    });
  });

  it("still shows the policy when the member roster fails to load", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({
        items: [policy(3, "Allow reads")],
      }),
      "environment.members": () => Promise.reject(new Error("roster down")),
    });
    render(<TeamPermissions>{null}</TeamPermissions>, {
      wrapper: harness.Wrapper,
    });

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
    render(<TeamPermissions>{null}</TeamPermissions>, {
      wrapper: harness.Wrapper,
    });

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
