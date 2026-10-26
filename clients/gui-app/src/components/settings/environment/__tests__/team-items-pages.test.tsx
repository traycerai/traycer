import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentConfigurationItem } from "@traycer/protocol/host/environment/configuration-contracts";
import { TeamProviders } from "@/components/settings/environment/team-providers";
import { TeamSkillsPage } from "@/components/settings/environment/team-skills";
import { TeamPermissions } from "@/components/settings/environment/team-permissions";
import { BrowserAgentAccessGroup } from "@/components/settings/panels/browser-agent-access-group";
import { TeamMcpServers } from "@/components/settings/environment/team-mcp-servers";
import { TeamVariablesAndShells } from "@/components/settings/environment/team-variables-and-shells";
import {
  configurationItem,
  mountTeamPage,
  personalPoolSource,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "./team-configuration-test-support";

// These cases are about the preview features' on behaviour.
vi.mock("@/hooks/auth/use-preview-feature", () => ({
  usePreviewFeature: () => "on" as const,
}));

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

// Resolving a client for another host needs the app's host directory; the
// viewing-host logic above it stays real.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null ? null : requireTeamHostClient(),
}));

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
});

const variable = (
  key: string,
  value: string,
  revision: number,
): EnvironmentConfigurationItem =>
  configurationItem({
    kind: "variable",
    key,
    os: "any",
    value: { value },
    revision,
  });

describe("TeamVariablesAndShells", () => {
  it("reads the team's items by environment id, never the host's own config", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({
        items: [variable("NODE_ENV", "production", 3)],
      }),
      "environment.host.list": () => ({ hosts: [] }),
    });
    render(<TeamVariablesAndShells />, { wrapper: harness.Wrapper });

    expect(await screen.findByLabelText("NODE_ENV value")).toHaveProperty(
      "value",
      "production",
    );
    expect(harness.paramsOf("environment.configuration.items")[0]).toEqual({
      environmentId: "env-a",
    });
    expect(harness.paramsOf("config.env.list")).toHaveLength(0);
    expect(harness.paramsOf("config.shell.get")).toHaveLength(0);
  });

  it("names the team in the subtitle, and a failed read shows one line whose Retry reads again", async () => {
    let fail = true;
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => {
        if (fail) throw new Error("host unavailable");
        return { items: [variable("NODE_ENV", "production", 3)] };
      },
      "environment.host.list": () => ({ hosts: [] }),
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
    render(<TeamVariablesAndShells />, { wrapper: harness.Wrapper });

    const failure = await screen.findByText(
      "Couldn't read Acme's variables and shells.",
    );
    expect(
      await screen.findByText(
        "Plain values every host running Acme gets, and the shell agents run in.",
      ),
    ).toBeTruthy();
    const reads = harness.paramsOf("environment.configuration.items").length;

    fail = false;
    await userEvent.click(
      within(failure.closest("p") ?? failure).getByRole("button", {
        name: "Retry",
      }),
    );

    expect(await screen.findByLabelText("NODE_ENV value")).toBeTruthy();
    expect(
      harness.paramsOf("environment.configuration.items").length,
    ).toBeGreaterThan(reads);
  });

  it("gives a viewer the values with no Save, Delete or new-variable verbs", async () => {
    const harness = mountTeamPage(poolSource("viewer"), {
      "environment.configuration.items": () => ({
        items: [variable("NODE_ENV", "production", 3)],
      }),
      "environment.host.list": () => ({ hosts: [] }),
    });
    render(<TeamVariablesAndShells />, { wrapper: harness.Wrapper });

    expect(await screen.findByText("production")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    for (const verb of ["Save", "Delete", "Add a variable", "Remove"]) {
      expect(screen.queryByRole("button", { name: verb })).toBeNull();
    }
  });

  it("quotes the displayed revision, and on a conflict rereads the current value beside the changed-by line", async () => {
    let current = variable("NODE_ENV", "production", 3);
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items: [current] }),
      "environment.configuration.items.put": () => {
        // Someone else saved first; their row is what the reread returns.
        current = variable("NODE_ENV", "staging", 4);
        return {
          outcome: "conflict",
          current: { revision: 4, changedBy: "Grace", changedAt: 2 },
        };
      },
      "environment.host.list": () => ({ hosts: [] }),
    });
    render(<TeamVariablesAndShells />, { wrapper: harness.Wrapper });

    const field = await screen.findByLabelText("NODE_ENV value");
    await userEvent.clear(field);
    await userEvent.type(field, "development");
    const row = (): HTMLElement =>
      screen.getByRole("region", { name: "NODE_ENV" });
    await userEvent.click(within(row()).getByRole("button", { name: "Save" }));

    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
      {
        environmentId: "env-a",
        kind: "variable",
        key: "NODE_ENV",
        os: "any",
        value: { value: "development" },
        revision: 3,
      },
    ]);
    expect(
      await screen.findByText("Changed by Grace a moment ago"),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByLabelText("NODE_ENV value")).toHaveProperty(
        "value",
        "staging",
      );
    });

    // The next save quotes the reread revision, not the stale one.
    await userEvent.type(screen.getByLabelText("NODE_ENV value"), "!");
    await userEvent.click(within(row()).getByRole("button", { name: "Save" }));
    expect(
      harness.paramsOf("environment.configuration.items.put")[1],
    ).toMatchObject({ revision: 4 });
  });

  it("shows and saves each operating system's own value when two share a key and revision", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({
        items: [
          variable("NODE_ENV", "production", 3),
          configurationItem({
            kind: "variable",
            key: "NODE_ENV",
            os: "linux",
            value: { value: "linux-value" },
            revision: 3,
          }),
        ],
      }),
      "environment.configuration.items.put": () => ({
        outcome: "saved",
        revision: 4,
      }),
      "environment.host.list": () => ({ hosts: [] }),
    });
    const user = userEvent.setup();
    render(<TeamVariablesAndShells />, { wrapper: harness.Wrapper });

    expect(await screen.findByLabelText("NODE_ENV value")).toHaveProperty(
      "value",
      "production",
    );
    await user.click(
      screen.getByRole("combobox", { name: "Operating system" }),
    );
    await user.click(await screen.findByRole("option", { name: "Linux" }));
    const field = screen.getByLabelText("NODE_ENV value");
    expect(field).toHaveProperty("value", "linux-value");

    await user.type(field, "!");
    await user.click(
      within(screen.getByRole("region", { name: "NODE_ENV" })).getByRole(
        "button",
        { name: "Save" },
      ),
    );
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
      {
        environmentId: "env-a",
        kind: "variable",
        key: "NODE_ENV",
        os: "linux",
        value: { value: "linux-value!" },
        revision: 3,
      },
    ]);
  });

  it("lists every operating system's variables under All, labels the ones scoped to one, and saves each under its own", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({
        items: [
          configurationItem({
            kind: "variable",
            key: "API_URL",
            os: "macos",
            value: { value: "mac-value" },
            revision: 2,
          }),
        ],
      }),
      "environment.configuration.items.put": () => ({
        outcome: "saved",
        revision: 3,
      }),
      "environment.host.list": () => ({ hosts: [] }),
    });
    const user = userEvent.setup();
    render(<TeamVariablesAndShells />, { wrapper: harness.Wrapper });

    const row = await screen.findByRole("region", { name: "API_URL · macOS" });
    expect(within(row).getByText("macOS")).toBeTruthy();
    expect(screen.queryByText("No variables yet.")).toBeNull();
    const field = within(row).getByLabelText("API_URL · macOS value");
    expect(field).toHaveProperty("value", "mac-value");

    await user.type(field, "!");
    await user.click(within(row).getByRole("button", { name: "Save" }));
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
      {
        environmentId: "env-a",
        kind: "variable",
        key: "API_URL",
        os: "macos",
        value: { value: "mac-value!" },
        revision: 2,
      },
    ]);

    await user.click(
      screen.getByRole("combobox", { name: "Operating system" }),
    );
    await user.click(await screen.findByRole("option", { name: "Linux" }));
    expect(screen.queryByRole("region", { name: /API_URL/ })).toBeNull();
    expect(screen.getByText("No variables yet.")).toBeTruthy();
  });

  it("says live values need a host while the team has none", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items: [] }),
      "environment.host.list": () => ({ hosts: [] }),
    });
    render(<TeamVariablesAndShells />, { wrapper: harness.Wrapper });

    expect(
      await screen.findByText(/Live values need a host running/),
    ).toBeTruthy();
    expect(harness.paramsOf("config.shell.get")).toHaveLength(0);
  });
});

describe("TeamMcpServers", () => {
  const server = (
    revision: number,
    enabled: boolean,
  ): EnvironmentConfigurationItem =>
    configurationItem({
      kind: "mcp_server",
      key: "github",
      value: {
        mcpServerId: "srv-1",
        toolToggles: { claude: { search: enabled } },
      },
      revision,
    });

  it("names the team in the subtitle", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items: [] }),
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
    render(<TeamMcpServers />, { wrapper: harness.Wrapper });

    expect(
      await screen.findByText(
        "Tools agents can call. Acme's servers reach every provider on every host running Acme.",
      ),
    ).toBeTruthy();
  });

  it("toggles a tool against the displayed revision for an editor", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items: [server(5, true)] }),
      "environment.configuration.items.put": () => ({
        outcome: "saved",
        revision: 6,
      }),
    });
    render(<TeamMcpServers />, { wrapper: harness.Wrapper });

    await userEvent.click(
      await screen.findByRole("switch", { name: "github claude search" }),
    );
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
      {
        environmentId: "env-a",
        kind: "mcp_server",
        key: "github",
        os: null,
        value: {
          mcpServerId: "srv-1",
          toolToggles: { claude: { search: false } },
        },
        revision: 5,
      },
    ]);
  });

  it("shows a viewer On/Off with no switches", async () => {
    const harness = mountTeamPage(poolSource("viewer"), {
      "environment.configuration.items": () => ({ items: [server(5, true)] }),
    });
    render(<TeamMcpServers />, { wrapper: harness.Wrapper });

    expect(await screen.findByText("On")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("rereads the current toggle and shows who changed it after a conflict", async () => {
    let current = server(5, true);
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items: [current] }),
      "environment.configuration.items.put": () => {
        current = server(6, false);
        return {
          outcome: "conflict",
          current: { revision: 6, changedBy: "Grace", changedAt: 2 },
        };
      },
    });
    render(<TeamMcpServers />, { wrapper: harness.Wrapper });

    await userEvent.click(
      await screen.findByRole("switch", { name: "github claude search" }),
    );
    expect(
      await screen.findByText("Changed by Grace a moment ago"),
    ).toBeTruthy();
    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: "github claude search" }),
      ).toHaveProperty("ariaChecked", "false");
    });
  });
});

describe("Environment page subtitles", () => {
  const environments = {
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
  const handlers = {
    "environment.list": () => environments,
    "environment.configuration.items": () => ({ items: [] }),
    "environment.host.list": () => ({ hosts: [] }),
    "environment.plans.list": () => ({ plans: [] }),
    "environment.members": () => ({
      members: [],
      nextCursor: null,
      legacyRoleNoticeSeenAt: null,
      legacyMembers: [],
    }),
  } as const;

  it.each([
    [
      "Providers",
      <TeamProviders key="p" />,
      "Plans, keys and settings for each coding agent, on every host running Acme.",
      "Sign-ins, keys and tools for each coding agent, on every computer and sandbox running Personal.",
    ],
    [
      "MCP servers",
      <TeamMcpServers key="m" />,
      "Tools agents can call. Acme's servers reach every provider on every host running Acme.",
      "Tools agents can call. Personal's servers reach every provider on every computer and sandbox running Personal.",
    ],
    [
      "Skills",
      <TeamSkillsPage key="s" />,
      null,
      "Instructions agents follow for a kind of task. Personal's skills reach every provider on every computer and sandbox running Personal.",
    ],
    [
      "Permissions",
      <TeamPermissions key="x">{null}</TeamPermissions>,
      "What Acme's agents may do without asking, on every host running Acme.",
      "What your agents may do without asking, on every computer and sandbox running Personal.",
    ],
    [
      "Variables & shells",
      <TeamVariablesAndShells key="v" />,
      "Plain values every host running Acme gets, and the shell agents run in.",
      "Plain values every computer and sandbox running Personal gets, and the shell agents run in.",
    ],
  ])("%s names its configuration", async (_page, page, team, personal) => {
    if (team !== null) {
      const harness = mountTeamPage(poolSource("editor"), handlers);
      render(page, { wrapper: harness.Wrapper });
      expect(await screen.findByText(team)).toBeTruthy();
      cleanup();
      resetTeamPageHarness();
    }
    const harness = mountTeamPage(personalPoolSource(), handlers);
    render(page, { wrapper: harness.Wrapper });
    expect(await screen.findByText(personal)).toBeTruthy();
  });
});

describe("A cloud page's failed read", () => {
  const environments = {
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
  };
  const failingHandlers = {
    "environment.list": () => environments,
    "environment.configuration.items": () => {
      throw new Error("host unavailable");
    },
    "environment.host.list": () => ({ hosts: [] }),
    "environment.plans.list": () => ({ plans: [] }),
    "environment.members": () => ({
      members: [],
      nextCursor: null,
      legacyRoleNoticeSeenAt: null,
      legacyMembers: [],
    }),
  } as const;

  it.each([
    ["a team", poolSource("editor"), "Acme"],
    ["Personal", personalPoolSource(), "Personal"],
  ])(
    "names %s and the page, and Retry reads again",
    async (_name, source, who) => {
      const harness = mountTeamPage(source, failingHandlers);
      render(<TeamProviders />, { wrapper: harness.Wrapper });

      const failure = await screen.findByText(
        `Couldn't read ${who}'s providers.`,
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
    },
  );

  it("names the team on the Browser agent access row, and Retry reads again", async () => {
    const harness = mountTeamPage(poolSource("editor"), failingHandlers);
    render(<BrowserAgentAccessGroup />, { wrapper: harness.Wrapper });

    const failure = await screen.findByText(
      "Couldn't read Acme's browser agent access.",
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
});
