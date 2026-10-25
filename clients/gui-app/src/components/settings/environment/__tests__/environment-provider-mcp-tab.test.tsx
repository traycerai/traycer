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
import type { ProvidersNativeMutateResponseV14 } from "@traycer/protocol/host/provider-schemas";
import { EnvironmentProviderMcpTab } from "@/components/settings/environment/environment-provider-mcp-tab";
import type { HostRpcRegistry } from "@/lib/host";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import {
  declaredServer,
  hostMcpServer,
  hostPlaceKey,
  nativeScopeTargets,
  projectScopedProviderState,
  negotiateMethods,
  providerState,
  reachableHost,
  teamEnvironments,
} from "./mcp-skills-test-support";
import {
  mountTeamPage,
  personalPoolSource,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "./team-configuration-test-support";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));
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
vi.mock("@/components/settings/panels/use-provider-native-scope", async () => {
  const support = await import("./mcp-skills-test-support");
  return { useProviderNativeScope: support.nativeScopeFor };
});
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), message: vi.fn() },
}));
const navigation = vi.hoisted(() => ({ opened: [] as string[] }));
vi.mock("@/lib/settings-navigation", () => ({
  navigateToSettingsSection: (section: string): void => {
    navigation.opened.push(section);
  },
}));

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  resetNegotiatedManifests();
  navigation.opened = [];
  nativeScopeTargets.current = [];
  vi.mocked(toast.error).mockClear();
});

const CLAUDE = providerIdToGuiHarnessId("claude-code");

function negotiate(): void {
  negotiateMethods({
    "environment.configuration.mcpServers.list": { major: 1, minor: 0 },
    "environment.configuration.items.put": { major: 1, minor: 0 },
    "providers.nativeMutate": { major: 1, minor: 3 },
  });
}

function handlers(options: {
  readonly servers: readonly EnvironmentMcpServerDeclaration[];
  /** What Claude Code holds in its global settings on the viewing host. */
  readonly hostServers: readonly ProviderMcpServer[];
  readonly promote: ProvidersNativeMutateResponseV14;
}): MockHandlerMap<HostRpcRegistry> {
  return {
    "environment.configuration.mcpServers.list": () => ({
      servers: [...options.servers],
    }),
    "environment.configuration.items.put": () => ({
      outcome: "saved" as const,
      revision: 5,
    }),
    "providers.nativeMutate": () => options.promote,
    "environment.host.list": () => ({ hosts: [reachableHost] }),
    "environment.list": () => teamEnvironments,
    "providers.list": (request) =>
      request.native === null
        ? {
            providers: [
              providerState("claude-code", { mcp: true, skills: false }),
            ],
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

const PROMOTED: ProvidersNativeMutateResponseV14 = {
  result: { ok: true, kind: "mcp", servers: [] },
};

describe("A provider's MCP tab on Personal or a team", () => {
  it("heads the card with the configuration and provider, lists its servers with tool counts, and links to Manage servers", async () => {
    negotiate();
    const harness = mountTeamPage(
      personalPoolSource(),
      handlers({
        servers: [declaredServer({ serverId: "srv-1", name: "github" })],
        hostServers: [hostMcpServer("github", ["search", "open"])],
        promote: PROMOTED,
      }),
    );
    render(<EnvironmentProviderMcpTab providerId="claude-code" />, {
      wrapper: harness.Wrapper,
    });

    expect(
      await screen.findByRole("heading", {
        name: "Personal's servers · for Claude Code",
      }),
    ).toBeTruthy();
    expect(await screen.findByText("http · 2 tools")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Manage servers" }),
    );
    expect(navigation.opened).toEqual(["mcp-servers"]);
  });

  it("says the configuration has no servers yet", async () => {
    negotiate();
    const harness = mountTeamPage(
      personalPoolSource(),
      handlers({ servers: [], hostServers: [], promote: PROMOTED }),
    );
    render(<EnvironmentProviderMcpTab providerId="claude-code" />, {
      wrapper: harness.Wrapper,
    });

    expect(
      await screen.findByText("Personal has no servers yet."),
    ).toBeTruthy();
  });

  it("switches the server off for this provider alone, keeping the providers already off", async () => {
    negotiate();
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({
        servers: [
          declaredServer({
            serverId: "srv-1",
            name: "github",
            item: {
              key: "github",
              revision: 4,
              toolToggles: { claude: { search: false } },
              offFor: ["codex"],
            },
          }),
        ],
        hostServers: [],
        promote: PROMOTED,
      }),
    );
    render(<EnvironmentProviderMcpTab providerId="claude-code" />, {
      wrapper: harness.Wrapper,
    });

    await userEvent.click(
      await screen.findByRole("switch", { name: "github for Claude Code" }),
    );

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        {
          environmentId: "env-a",
          kind: "mcp_server",
          key: "github",
          os: null,
          value: {
            mcpServerId: "srv-1",
            toolToggles: { claude: { search: false } },
            offFor: ["codex", CLAUDE],
          },
          revision: 4,
        },
      ]);
    });
  });

  it("turns the last provider back on with no offFor key, never an empty one", async () => {
    negotiate();
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({
        servers: [
          declaredServer({
            serverId: "srv-1",
            name: "github",
            item: {
              key: "github",
              revision: 4,
              toolToggles: {},
              offFor: [CLAUDE],
            },
          }),
        ],
        hostServers: [],
        promote: PROMOTED,
      }),
    );
    render(<EnvironmentProviderMcpTab providerId="claude-code" />, {
      wrapper: harness.Wrapper,
    });

    await userEvent.click(
      await screen.findByRole("switch", { name: "github for Claude Code" }),
    );

    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items.put"),
      ).toHaveLength(1);
    });
    expect(harness.paramsOf("environment.configuration.items.put")[0]).toEqual({
      environmentId: "env-a",
      kind: "mcp_server",
      key: "github",
      os: null,
      value: { mcpServerId: "srv-1", toolToggles: {} },
      revision: 4,
    });
  });

  it("writes a tool's switch under this provider's toggles", async () => {
    negotiate();
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({
        servers: [declaredServer({ serverId: "srv-1", name: "github" })],
        hostServers: [hostMcpServer("github", ["search", "open"])],
        promote: PROMOTED,
      }),
    );
    render(<EnvironmentProviderMcpTab providerId="claude-code" />, {
      wrapper: harness.Wrapper,
    });

    await userEvent.click(await screen.findByRole("button", { name: "Tools" }));
    await userEvent.click(
      await screen.findByRole("switch", { name: "github Claude Code search" }),
    );

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
        {
          environmentId: "env-a",
          kind: "mcp_server",
          key: "github",
          os: null,
          value: {
            mcpServerId: "srv-1",
            toolToggles: { [CLAUDE]: { search: false } },
          },
          revision: 4,
        },
      ]);
    });
  });

  it("lists what the provider holds on the viewing host by itself, and adds it to the configuration fenced to its id", async () => {
    negotiate();
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({
        servers: [declaredServer({ serverId: "srv-1", name: "github" })],
        hostServers: [
          hostMcpServer("github", ["search"]),
          hostMcpServer("scratch", []),
        ],
        promote: PROMOTED,
      }),
    );
    render(<EnvironmentProviderMcpTab providerId="claude-code" />, {
      wrapper: harness.Wrapper,
    });

    const card = await screen.findByRole("region", {
      name: "On Mac mini only · not shared",
    });
    expect(within(card).getByText("scratch")).toBeTruthy();
    expect(within(card).queryByText("github")).toBeNull();
    await userEvent.click(
      within(card).getByRole("button", { name: "Add to Acme" }),
    );

    await waitFor(() => {
      expect(harness.paramsOf("providers.nativeMutate")).toEqual([
        {
          providerId: "claude-code",
          mutation: {
            kind: "promoteToPersonal",
            entryKind: "mcp",
            scope: "global",
            workspaceRoot: null,
            name: "scratch",
          },
          executableWriteGrant: null,
          expectedEnvironmentId: "env-a",
        },
      ]);
    });
  });

  it("shows a refusal the host words beside the button, as it reads", async () => {
    negotiate();
    const harness = mountTeamPage(
      personalPoolSource(),
      handlers({
        servers: [],
        hostServers: [hostMcpServer("scratch", [])],
        promote: {
          result: {
            ok: false,
            code: "environment_mismatch",
            detail: "Personal already has a server called scratch.",
          },
        },
      }),
    );
    render(<EnvironmentProviderMcpTab providerId="claude-code" />, {
      wrapper: harness.Wrapper,
    });

    await userEvent.click(
      await screen.findByRole("button", { name: "Add to Personal" }),
    );

    expect(
      await screen.findByText("Personal already has a server called scratch."),
    ).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("still toasts when the add fails to reach the host", async () => {
    negotiate();
    const harness = mountTeamPage(personalPoolSource(), {
      ...handlers({
        servers: [],
        hostServers: [hostMcpServer("scratch", [])],
        promote: PROMOTED,
      }),
      "providers.nativeMutate": () => {
        throw new Error("host unavailable");
      },
    });
    render(<EnvironmentProviderMcpTab providerId="claude-code" />, {
      wrapper: harness.Wrapper,
    });

    await userEvent.click(
      await screen.findByRole("button", { name: "Add to Personal" }),
    );

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).toContain(
      "Couldn't add it to Personal.",
    );
  });

  it("says the read failed, naming the configuration", async () => {
    negotiate();
    const harness = mountTeamPage(personalPoolSource(), {
      ...handlers({ servers: [], hostServers: [], promote: PROMOTED }),
      "environment.configuration.mcpServers.list": () => {
        throw new Error("host unavailable");
      },
    });
    render(<EnvironmentProviderMcpTab providerId="claude-code" />, {
      wrapper: harness.Wrapper,
    });

    expect(
      await screen.findByText("Couldn't read Personal's MCP servers."),
    ).toBeTruthy();
  });

  it("names where each on-host server lives, and adds it at that scope and folder", async () => {
    negotiate();
    nativeScopeTargets.current = [
      { path: "/Users/dev/app", name: "app", branch: null, isWorktree: false },
      {
        path: "/Users/dev/app-wt",
        name: "app",
        branch: "feature",
        isWorktree: true,
      },
    ];
    const held: Record<string, readonly string[]> = {
      [hostPlaceKey("global", null)]: ["github", "scratch"],
      [hostPlaceKey("project", "/Users/dev/app")]: ["github", "proj-only"],
      [hostPlaceKey("project", "/Users/dev/app-wt")]: ["wt-only"],
    };
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers({
        servers: [declaredServer({ serverId: "srv-1", name: "github" })],
        hostServers: [],
        promote: PROMOTED,
      }),
      "providers.list": (request) =>
        request.native === null
          ? {
              providers: [projectScopedProviderState("claude-code")],
              native: null,
            }
          : {
              providers: [],
              native: {
                ok: true as const,
                kind: "mcp" as const,
                servers: (
                  held[
                    hostPlaceKey(
                      request.native.scope,
                      request.native.workspaceRoot,
                    )
                  ] ?? []
                ).map((name) => hostMcpServer(name, [])),
              },
            },
    });
    render(<EnvironmentProviderMcpTab providerId="claude-code" />, {
      wrapper: harness.Wrapper,
    });

    const card = await screen.findByRole("region", {
      name: "On Mac mini only · not shared",
    });
    await waitFor(() => {
      expect(within(card).getAllByRole("listitem")).toHaveLength(4);
    });
    // The configuration's own global copy is hidden; a project's is not.
    expect(
      within(card)
        .getAllByRole("listitem")
        .map((row) =>
          Array.from(row.querySelectorAll(":scope > div > div")).map(
            (cell) => cell.textContent,
          ),
        ),
    ).toEqual([
      ["scratch", "all projects"],
      ["github", "app"],
      ["proj-only", "app"],
      ["wt-only", "app · feature"],
    ]);
    const add = (entry: string): HTMLElement => {
      const row = within(card).getByText(entry).closest("li");
      if (row === null) throw new Error(`no row for ${entry}`);
      return within(row).getByRole("button", { name: "Add to Acme" });
    };
    await userEvent.click(add("scratch"));
    await userEvent.click(add("wt-only"));

    await waitFor(() => {
      expect(harness.paramsOf("providers.nativeMutate")).toMatchObject([
        { mutation: { scope: "global", workspaceRoot: null, name: "scratch" } },
        {
          mutation: {
            scope: "project",
            workspaceRoot: "/Users/dev/app-wt",
            name: "wt-only",
          },
        },
      ]);
    });
  });
});
