import "../../../../../__tests__/test-browser-apis";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { EnvironmentMcpServerDeclaration } from "@traycer/protocol/host/environment/configuration-contracts";
import type { ProviderMcpServer } from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { EnvironmentMcpServersPage } from "@/components/settings/environment/environment-mcp-servers";
import type { HostRpcRegistry } from "@/lib/host";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import {
  declaredServer,
  hostMcpServer,
  negotiateMethods,
  providerState,
  reachableHost,
  teamEnvironments,
} from "./mcp-skills-test-support";
import {
  configurationItem,
  mountTeamPage,
  personalPoolSource,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "./team-configuration-test-support";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));
// The ambient host binding is what the viewing-host binding re-provides.
vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostClient: () => requireTeamHostClient(),
  useHostBinding: () => ({
    hostId: "host-local",
    hostClient: requireTeamHostClient(),
  }),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null ? null : requireTeamHostClient(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), message: vi.fn() },
}));

afterEach(() => {
  vi.mocked(toast.error).mockClear();
  cleanup();
  resetTeamPageHarness();
  resetNegotiatedManifests();
});

/** The MCP-capable providers of the viewing host, in rail order. */
const CAPABLE: readonly ProviderId[] = [
  "codex",
  "claude-code",
  "opencode",
  "traycer",
  "openrouter",
];

const ALL_METHODS = {
  "environment.configuration.mcpServers.list": { major: 1, minor: 0 },
  "environment.configuration.mcpServers.put": { major: 1, minor: 1 },
  "environment.configuration.mcpServers.delete": { major: 1, minor: 0 },
  "environment.configuration.mcpServers.setEnabled": { major: 1, minor: 0 },
  "environment.configuration.items.put": { major: 1, minor: 0 },
  "environment.configuration.items.delete": { major: 1, minor: 0 },
  "environment.configuration.items": { major: 1, minor: 0 },
} as const;

function handlers(options: {
  readonly servers: () => EnvironmentMcpServerDeclaration[];
  /** The servers the viewing host lists for any provider. */
  readonly hostServers: readonly ProviderMcpServer[];
}): MockHandlerMap<HostRpcRegistry> {
  return {
    "environment.configuration.mcpServers.list": () => ({
      servers: options.servers(),
    }),
    "environment.configuration.items.put": () => ({
      outcome: "saved" as const,
      revision: 5,
    }),
    "environment.configuration.items.delete": () => ({
      outcome: "saved" as const,
      revision: null,
    }),
    "environment.configuration.mcpServers.delete": () => ({
      outcome: "saved" as const,
      reason: null,
    }),
    "environment.configuration.mcpServers.setEnabled": () => ({
      outcome: "saved" as const,
      reason: null,
    }),
    "environment.host.list": () => ({ hosts: [reachableHost] }),
    "environment.list": () => teamEnvironments,
    "providers.list": (request) =>
      request.native === null
        ? {
            providers: CAPABLE.map((id) =>
              providerState(id, { mcp: true, skills: false }),
            ),
            native: null,
          }
        : {
            providers: [],
            native: {
              ok: true as const,
              kind: "mcp" as const,
              servers: [...options.hostServers],
            },
          },
  };
}

/** The Enabled switch writes the server alone: no item and no declaration. */
function expectNoItemOrDeclarationWrites(harness: TeamPageHarness): void {
  for (const method of [
    "environment.configuration.items.put",
    "environment.configuration.items.delete",
    "environment.configuration.mcpServers.put",
  ]) {
    expect(harness.paramsOf(method)).toHaveLength(0);
  }
}

function offFor(providers: readonly ProviderId[]): string[] {
  return providers.map((id) => providerIdToGuiHarnessId(id));
}

describe("The MCP servers page", () => {
  it.each([
    { off: [], phrase: "all providers" },
    { off: CAPABLE.slice(1), phrase: "Codex only" },
    { off: CAPABLE.slice(2), phrase: "Codex, Claude Code" },
    { off: CAPABLE.slice(3), phrase: "Codex, Claude Code and OpenCode" },
    { off: CAPABLE.slice(4), phrase: "Codex, Claude Code and 2 more" },
  ])(
    "reads a server's transport, tool count and providers as one line: $phrase",
    async ({ off, phrase }) => {
      negotiateMethods(ALL_METHODS);
      const harness = mountTeamPage(
        poolSource("editor"),
        handlers({
          servers: () => [
            declaredServer({
              serverId: "srv-1",
              name: "github",
              item: {
                key: "github",
                revision: 4,
                toolToggles: {},
                offFor: offFor(off),
              },
            }),
          ],
          hostServers: [hostMcpServer("github", ["search", "open"])],
        }),
      );
      render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

      expect(
        await screen.findByText(`http · 2 tools · ${phrase}`),
      ).toBeTruthy();
      expect(
        harness.paramsOf("environment.configuration.mcpServers.list"),
      ).toEqual([{ environmentId: "env-a" }]);
    },
  );

  it("says no provider uses a server every provider is off for, with no tool count", async () => {
    negotiateMethods(ALL_METHODS);
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({
        servers: () => [
          declaredServer({
            serverId: "srv-1",
            name: "github",
            item: {
              key: "github",
              revision: 4,
              toolToggles: {},
              offFor: offFor(CAPABLE),
            },
          }),
        ],
        hostServers: [hostMcpServer("github", ["search"])],
      }),
    );
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

    expect(await screen.findByText("http · no provider uses it")).toBeTruthy();
  });

  it("counts a single tool in the singular, and drops the count when the host does not list the server", async () => {
    negotiateMethods(ALL_METHODS);
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({
        servers: () => [
          declaredServer({ serverId: "srv-1", name: "github" }),
          declaredServer({ serverId: "srv-2", name: "docs" }),
        ],
        hostServers: [hostMcpServer("github", ["search"])],
      }),
    );
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

    expect(
      await screen.findByText("http · 1 tool · all providers"),
    ).toBeTruthy();
    expect(screen.getByText("http · all providers")).toBeTruthy();
  });

  it("reads a server with no item as disabled, and its switch turns it on with setEnabled alone", async () => {
    negotiateMethods(ALL_METHODS);
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({
        servers: () => [
          declaredServer({ serverId: "srv-1", name: "github", item: null }),
        ],
        hostServers: [],
      }),
    );
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

    expect(
      await screen.findByText("http · disabled · no provider uses it"),
    ).toBeTruthy();
    expect(screen.getByText("Disabled")).toBeTruthy();
    await userEvent.click(screen.getByRole("switch", { name: "github" }));

    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.mcpServers.setEnabled"),
      ).toEqual([{ environmentId: "env-a", serverId: "srv-1", enabled: true }]);
    });
    expectNoItemOrDeclarationWrites(harness);
  });

  it("turns an enabled server off with setEnabled alone", async () => {
    negotiateMethods(ALL_METHODS);
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({
        servers: () => [declaredServer({ serverId: "srv-1", name: "github" })],
        hostServers: [],
      }),
    );
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

    expect(await screen.findByText("Enabled")).toBeTruthy();
    await userEvent.click(screen.getByRole("switch", { name: "github" }));

    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.mcpServers.setEnabled"),
      ).toEqual([
        { environmentId: "env-a", serverId: "srv-1", enabled: false },
      ]);
    });
    expectNoItemOrDeclarationWrites(harness);
  });

  it.each([
    {
      item: null,
      message: "Couldn't turn github on. Try again.",
    },
    {
      item: { key: "github", revision: 4, toolToggles: {}, offFor: [] },
      message: "Couldn't turn github off. Try again.",
    },
  ])(
    "toasts $message when the switch cannot reach the host",
    async ({ item, message }) => {
      negotiateMethods(ALL_METHODS);
      const harness = mountTeamPage(poolSource("editor"), {
        ...handlers({
          servers: () => [
            declaredServer({ serverId: "srv-1", name: "github", item }),
          ],
          hostServers: [],
        }),
        "environment.configuration.mcpServers.setEnabled": () => {
          throw new Error("host unavailable");
        },
      });
      render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

      await userEvent.click(
        await screen.findByRole("switch", { name: "github" }),
      );

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalled();
      });
      expect(toast.error).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).toContain(
        message,
      );
    },
  );

  it.each([
    {
      reason: "name_taken",
      line: "Acme already has a server named github. Pick another name.",
    },
    {
      reason: "invalid_body",
      line: "Couldn't turn github on. Try again.",
    },
  ])(
    "says $line on the page when the host refuses the switch ($reason)",
    async ({ reason, line }) => {
      negotiateMethods(ALL_METHODS);
      const harness = mountTeamPage(poolSource("editor"), {
        ...handlers({
          servers: () => [
            declaredServer({ serverId: "srv-1", name: "github", item: null }),
          ],
          hostServers: [],
        }),
        "environment.configuration.mcpServers.setEnabled": () => ({
          outcome: "refused" as const,
          reason,
        }),
      });
      render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

      await userEvent.click(
        await screen.findByRole("switch", { name: "github" }),
      );

      expect((await screen.findByRole("status")).textContent).toBe(line);
      expect(toast.error).not.toHaveBeenCalled();
    },
  );

  it("keeps a tool's toggle through switching the server off and on again", async () => {
    negotiateMethods(ALL_METHODS);
    // Models the host's contract: setEnabled false takes the server out of
    // every provider but keeps its toggles; setEnabled true brings the item
    // back with them.
    const host = {
      enabled: true,
      toolToggles: { [providerIdToGuiHarnessId("codex")]: { search: false } },
    };
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers({
        servers: () => [
          declaredServer({
            serverId: "srv-1",
            name: "github",
            item: host.enabled
              ? {
                  key: "github",
                  revision: 4,
                  toolToggles: host.toolToggles,
                  offFor: [],
                }
              : null,
          }),
        ],
        hostServers: [hostMcpServer("github", ["search", "open"])],
      }),
      "environment.configuration.mcpServers.setEnabled": (request) => {
        host.enabled = request.enabled;
        return { outcome: "saved" as const, reason: null };
      },
    });
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

    await userEvent.click(
      await screen.findByRole("switch", { name: "github" }),
    );
    expect(await screen.findByText("Disabled")).toBeTruthy();
    await userEvent.click(screen.getByRole("switch", { name: "github" }));
    expect(await screen.findByText("Enabled")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Tools" }));

    expect(
      (
        await screen.findByRole("switch", { name: "github Codex search" })
      ).getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      screen
        .getByRole("switch", { name: "github Codex open" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      harness.paramsOf("environment.configuration.mcpServers.setEnabled"),
    ).toEqual([
      { environmentId: "env-a", serverId: "srv-1", enabled: false },
      { environmentId: "env-a", serverId: "srv-1", enabled: true },
    ]);
    expectNoItemOrDeclarationWrites(harness);
  });

  it.each([
    {
      configuration: "Personal",
      source: personalPoolSource(),
      credential: {
        kind: "secret" as const,
        secretId: "sec-1",
        secretName: "GitHub token",
        owned: true,
      },
      lines: [
        "This removes github from every provider on every computer and sandbox running Personal.",
        "Its secret, GitHub token, was added with this server and is deleted with it.",
      ],
    },
    {
      configuration: "Acme",
      source: poolSource("editor"),
      credential: {
        kind: "secret" as const,
        secretId: "sec-1",
        secretName: "GitHub token",
        owned: false,
      },
      lines: [
        "This removes github from every provider on every host running Acme.",
        "Its secret, GitHub token, stays on Secrets.",
      ],
    },
    {
      configuration: "Acme",
      source: poolSource("editor"),
      credential: {
        kind: "none" as const,
        secretId: null,
        secretName: null,
        owned: false,
      },
      lines: [
        "This removes github from every provider on every host running Acme.",
      ],
    },
  ])(
    "asks before removing a server from $configuration, naming its secret only when it has one",
    async ({ source, credential, lines }) => {
      negotiateMethods(ALL_METHODS);
      const harness = mountTeamPage(
        source,
        handlers({
          servers: () => [
            declaredServer({ serverId: "srv-1", name: "github", credential }),
          ],
          hostServers: [],
        }),
      );
      render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

      await userEvent.click(
        await screen.findByRole("button", { name: "Remove" }),
      );
      const dialog = await screen.findByRole("dialog");

      expect(within(dialog).getByText("Remove github?")).toBeTruthy();
      for (const line of lines) {
        expect(within(dialog).getByText(line)).toBeTruthy();
      }
      expect(within(dialog).queryByText(/Its secret/) === null).toBe(
        credential.kind === "none",
      );
      expect(
        harness.paramsOf("environment.configuration.mcpServers.delete"),
      ).toHaveLength(0);
    },
  );

  it("sends nothing when the removal is cancelled, and one delete by id when it is confirmed", async () => {
    negotiateMethods(ALL_METHODS);
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({
        servers: () => [declaredServer({ serverId: "srv-1", name: "github" })],
        hostServers: [],
      }),
    );
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

    await userEvent.click(
      await screen.findByRole("button", { name: "Remove" }),
    );
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(
      harness.paramsOf("environment.configuration.mcpServers.delete"),
    ).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Remove server",
      }),
    );

    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.mcpServers.delete"),
      ).toEqual([{ environmentId: "env-a", serverId: "srv-1" }]);
    });
  });

  it("gives a viewer the servers with no Add, Edit, Remove or switch", async () => {
    negotiateMethods(ALL_METHODS);
    const harness = mountTeamPage(
      poolSource("viewer"),
      handlers({
        servers: () => [declaredServer({ serverId: "srv-1", name: "github" })],
        hostServers: [],
      }),
    );
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

    expect(await screen.findByText("github")).toBeTruthy();
    for (const verb of ["Add a server", "Edit", "Remove"]) {
      expect(screen.queryByRole("button", { name: verb })).toBeNull();
    }
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("names Personal, not a team, on Personal's page", async () => {
    negotiateMethods(ALL_METHODS);
    const harness = mountTeamPage(
      personalPoolSource(),
      handlers({ servers: () => [], hostServers: [] }),
    );
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

    expect(
      await screen.findByText(
        "Tools agents can call. Personal's servers reach every provider on every computer and sandbox running Personal.",
      ),
    ).toBeTruthy();
    expect(
      harness.paramsOf("environment.configuration.mcpServers.list"),
    ).toEqual([{ environmentId: "env-personal" }]);
  });

  it("offers the first server on an empty page", async () => {
    negotiateMethods(ALL_METHODS);
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({ servers: () => [], hostServers: [] }),
    );
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

    expect(
      await screen.findByText("MCP servers give agents tools."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a server" })).toBeTruthy();
    expect(
      await screen.findByText(
        "Tools agents can call. Acme's servers reach every provider on every host running Acme.",
      ),
    ).toBeTruthy();
  });

  it("says the read failed, and Retry reads again", async () => {
    negotiateMethods(ALL_METHODS);
    let fail = true;
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers({ servers: () => [], hostServers: [] }),
      "environment.configuration.mcpServers.list": () => {
        if (fail) throw new Error("host unavailable");
        return {
          servers: [declaredServer({ serverId: "srv-1", name: "github" })],
        };
      },
    });
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

    const failure = await screen.findByText(
      "Couldn't read Acme's MCP servers.",
    );
    fail = false;
    await userEvent.click(
      failure.closest("p")?.querySelector("button") ?? failure,
    );

    expect(await screen.findByText("github")).toBeTruthy();
  });

  it("falls back to the items view on a host that has not negotiated the list", async () => {
    negotiateMethods({
      "environment.configuration.items": { major: 1, minor: 0 },
    });
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers({ servers: () => [], hostServers: [] }),
      "environment.configuration.items": () => ({
        items: [
          configurationItem({
            kind: "mcp_server",
            key: "legacy",
            value: { mcpServerId: "srv-9", toolToggles: {} },
          }),
        ],
      }),
    });
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

    expect(await screen.findByText("legacy")).toBeTruthy();
    expect(
      harness.paramsOf("environment.configuration.mcpServers.list"),
    ).toHaveLength(0);
  });
});
