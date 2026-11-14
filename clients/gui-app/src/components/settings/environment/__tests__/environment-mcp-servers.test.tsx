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
import type { EnvironmentSecretV12 } from "@traycer/protocol/host/environment-schemas";
import {
  RETIRED_PROVIDER_VARIABLES,
  RETIRED_SECRET_ROW_FIELDS,
} from "@traycer/protocol/host/released-wire-rows";
import type { ProviderMcpServer } from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { EnvironmentMcpServersPage } from "@/components/settings/environment/environment-mcp-servers";
import type { HostRpcRegistry } from "@/lib/host";
import {
  providerDisplayName,
  providerIdToGuiHarnessId,
} from "@/lib/provider-ordering";
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
  requireTeamEnvironmentAuthnBinding,
  requireTeamHostClient,
  windowHostBoundary,
  resetTeamPageHarness,
  windowHostScopeMock,
  type TeamPageHarness,
} from "./team-configuration-test-support";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
  useHostBinding: () => requireTeamEnvironmentAuthnBinding(),
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

vi.mock(
  "@/components/settings/host-scope/use-host-scope",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/settings/host-scope/use-host-scope")
    >()),
    usePersonalHostScope: () => windowHostScopeMock(),
  }),
);

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

const SWITCH_FAILURE_CASES = [
  {
    item: null,
    message: "Couldn't turn github on. Try again.",
  },
  {
    item: { key: "github", revision: 4, toolToggles: {}, offFor: [] },
    message: "Couldn't turn github off. Try again.",
  },
];

const OWNED_MCP_SECRET: EnvironmentSecretV12 = {
  secretId: "sec-1",
  name: "MCP_SRV1_GitHub token",
  kind: "mcp_credential",
  protocol: "http",
  destinations: [],
  ...RETIRED_SECRET_ROW_FIELDS,
  currentVersionId: "version-1",
  revoked: false,
  updatedAt: 1,
  variables: [],
  providerVariables: [...RETIRED_PROVIDER_VARIABLES],
};

const EXTERNAL_MCP_SECRET: EnvironmentSecretV12 = {
  ...OWNED_MCP_SECRET,
  name: "GitHub token",
  kind: "secret",
};

function handlers(options: {
  readonly servers: () => EnvironmentMcpServerDeclaration[];
  /** The servers the viewing host lists for any provider. */
  readonly hostServers: readonly ProviderMcpServer[];
  /** Provider-specific native inventories for tools that are not shared. */
  readonly hostServersByProvider?: Partial<
    Record<ProviderId, readonly ProviderMcpServer[]>
  >;
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
              servers: [
                ...(options.hostServersByProvider?.[
                  request.native.providerId
                ] ?? options.hostServers),
              ],
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

function pageDescription(): HTMLElement {
  const heading = screen.getByRole("heading", { level: 1 });
  const header = heading.closest("header");
  if (header === null) throw new Error("page heading has no header");
  const paragraph = Array.from(header.querySelectorAll("p")).find(
    (node) => node.dataset.testid !== "settings-phone-scope-line",
  );
  if (paragraph === undefined) {
    throw new Error("page header has no description");
  }
  return paragraph;
}

async function expectIntroduction(
  text: string,
  name: string,
  split: boolean,
): Promise<void> {
  await waitFor(() => {
    expect(pageDescription().textContent).toBe(text);
  });
  if (!split) return;
  const nameNode = within(pageDescription()).getByText(name);
  expect(nameNode.tagName).toBe("SPAN");
  expect(nameNode.className).toContain("truncate");
}

function serverRow(name: string): HTMLElement {
  const row = screen
    .getAllByRole("listitem")
    .find((item) => within(item).queryByText(name) !== null);
  if (row === undefined) throw new Error(`No row for ${name}.`);
  return row;
}

async function openServerCard(name: string): Promise<void> {
  await userEvent.click(
    within(serverRow(name)).getByRole("button", { expanded: false }),
  );
}

function expectAddBesideConnectedServers(): void {
  const add = screen.getByRole("button", { name: "Add a server" });
  const connected = screen.getByRole("heading", {
    name: "Connected servers",
    level: 2,
  });
  expect(add.parentElement).toBe(connected.parentElement);
  const pageHeader = screen
    .getByRole("heading", { level: 1 })
    .closest("header");
  if (pageHeader === null) throw new Error("page heading has no header");
  expect(pageHeader.contains(add)).toBe(false);
}

function openDetailsLine(
  phrase: string,
  tools: string | null,
  off: readonly ProviderId[],
): string {
  const using = CAPABLE.filter((id) => !off.includes(id));
  const names = using.map((id) => providerDisplayName(id));
  const parts = ["http"];
  if (tools !== null) parts.push(tools);
  parts.push(phrase);
  if (phrase === "all providers" && names.length > 0) {
    parts.push(names.join(", "));
  }
  return parts.join(" · ");
}

async function openRemoveForGithub(): Promise<void> {
  await userEvent.click(
    await screen.findByRole("button", { name: "Remove github" }),
  );
}

describe("The MCP servers page", () => {
  it("keeps Add a server beside Connected servers, and Remove on each row", async () => {
    negotiateMethods(ALL_METHODS);
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({
        servers: () => [
          declaredServer({ serverId: "srv-1", name: "github" }),
          declaredServer({ serverId: "srv-2", name: "docs", item: null }),
        ],
        hostServers: [],
      }),
    );
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

    expect(
      await screen.findByRole("button", { name: "Add a server" }),
    ).toBeTruthy();
    expectAddBesideConnectedServers();
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(within(row).queryByRole("button", { name: "Edit" })).toBeNull();
      expect(within(row).queryByRole("button", { name: "Tools" })).toBeNull();
      expect(within(row).getByRole("button", { expanded: false })).toBeTruthy();
      expect(
        within(row).queryByRole("button", { name: /^More for / }),
      ).toBeNull();
    }
    expect(
      within(serverRow("github")).getByRole("button", {
        name: "Remove github",
      }),
    ).toBeTruthy();
    expect(
      within(serverRow("docs")).getByRole("button", { name: "Remove docs" }),
    ).toBeTruthy();
  });

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
        await screen.findByText(`Enabled · http · ${phrase}`),
      ).toBeTruthy();
      await openServerCard("github");
      expect(
        await screen.findByText(openDetailsLine(phrase, "2 tools", off)),
      ).toBeTruthy();
      expect(screen.getByLabelText("Endpoint URL for github")).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Save changes" }),
      ).toHaveProperty("disabled", true);
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

    expect(
      await screen.findByText("Enabled · http · no provider uses it"),
    ).toBeTruthy();
    await openServerCard("github");
    expect(await screen.findByText("http · no provider uses it")).toBeTruthy();
    expect(screen.queryByText(/\d+ tools?/)).toBeNull();
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
      await screen.findAllByText("Enabled · http · all providers"),
    ).toHaveLength(2);
    await openServerCard("github");
    expect(
      await screen.findByText(openDetailsLine("all providers", "1 tool", [])),
    ).toBeTruthy();
    await openServerCard("docs");
    expect(
      await screen.findByText(openDetailsLine("all providers", null, [])),
    ).toBeTruthy();
  });

  it("labels a stdio server's command when its card is open", async () => {
    negotiateMethods(ALL_METHODS);
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({
        servers: () => [
          declaredServer({
            serverId: "srv-1",
            name: "local",
            transport: "stdio",
            command: "npx serve",
            url: null,
          }),
        ],
        hostServers: [],
      }),
    );
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

    expect(
      await screen.findByText("Enabled · stdio · all providers"),
    ).toBeTruthy();
    await openServerCard("local");
    expect(screen.getByText("Command")).toBeTruthy();
    expect(screen.getByLabelText("Command for local")).toHaveProperty(
      "value",
      "npx serve",
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty(
      "disabled",
      true,
    );
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
    expect(screen.queryByText("Disabled")).toBeNull();
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

    expect(
      await screen.findByText("Enabled · http · all providers"),
    ).toBeTruthy();
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

  it.each(SWITCH_FAILURE_CASES)(
    "shows the inline refusal line when authn answers 5xx: $message",
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

      expect(await screen.findByText(message)).toBeTruthy();
      expect(toast.error).not.toHaveBeenCalled();
    },
  );

  it.each(SWITCH_FAILURE_CASES)(
    "toasts $message when the authn transport rejects without an answer",
    async ({ item, message }) => {
      negotiateMethods(ALL_METHODS);
      const harness = mountTeamPage(poolSource("editor"), {
        ...handlers({
          servers: () => [
            declaredServer({ serverId: "srv-1", name: "github", item }),
          ],
          hostServers: [],
        }),
      });
      render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

      const toggle = await screen.findByRole("switch", { name: "github" });
      vi.mocked(globalThis.fetch).mockRejectedValueOnce(
        new Error("The transport did not answer."),
      );
      await userEvent.click(toggle);

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledTimes(1);
      });
      expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).toContain(
        message,
      );
      expect(
        harness.paramsOf("environment.configuration.mcpServers.setEnabled"),
      ).toHaveLength(0);
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

  it("shows a mixed tool off on one switch, and the header switch still writes setEnabled", async () => {
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
    expect(
      await screen.findByText("http · disabled · no provider uses it"),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("switch", { name: "github" }));
    expect(
      await screen.findByText("Enabled · http · all providers"),
    ).toBeTruthy();
    await openServerCard("github");

    const sharedSearch = await screen.findByRole("switch", {
      name: "github search",
    });
    expect(sharedSearch.getAttribute("aria-checked")).toBe("false");
    const searchName = screen.getByText("search");
    expect(searchName.tagName).toBe("SPAN");
    expect(searchName.className).toContain("truncate");
    expect(
      screen.queryByRole("switch", { name: /github .+ search/ }),
    ).toBeNull();
    const ordinaryOpen = screen.getByRole("switch", { name: "github open" });
    expect(ordinaryOpen.getAttribute("aria-checked")).toBe("true");
    expect(screen.getAllByRole("switch", { name: "github open" })).toHaveLength(
      1,
    );
    expect(screen.getByRole("button", { name: "Enable all" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disable all" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      harness.paramsOf("environment.configuration.mcpServers.setEnabled"),
    ).toEqual([
      { environmentId: "env-a", serverId: "srv-1", enabled: false },
      { environmentId: "env-a", serverId: "srv-1", enabled: true },
    ]);
    expectNoItemOrDeclarationWrites(harness);
  });

  it("shows one mixed shared tool switch and saves its state across providers once", async () => {
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
              toolToggles: { claude: { search: false } },
              offFor: [],
            },
          }),
        ],
        hostServers: [hostMcpServer("github", ["search"])],
      }),
    );
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

    await screen.findByText("github");
    await openServerCard("github");
    const sharedSwitch = await screen.findByRole("switch", {
      name: "github search",
    });
    expect(sharedSwitch.getAttribute("aria-checked")).toBe("false");
    expect(
      screen.getAllByRole("switch", { name: "github search" }),
    ).toHaveLength(1);
    expect(
      screen.queryByRole("switch", { name: /github .+ search/ }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toHaveLength(0);

    await userEvent.click(sharedSwitch);
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty(
      "disabled",
      false,
    );
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      const writes = harness.paramsOf("environment.configuration.items.put");
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        environmentId: "env-a",
        kind: "mcp_server",
        key: "github",
        value: {
          mcpServerId: "srv-1",
          toolToggles: Object.fromEntries(
            CAPABLE.map((providerId) => [
              providerIdToGuiHarnessId(providerId),
              { search: true },
            ]),
          ),
        },
        revision: 4,
      });
    });
    expect(
      harness.paramsOf("environment.configuration.mcpServers.put"),
    ).toHaveLength(0);
  });

  it("turns a mixed tool off for the provider that had it on when Disable all saves", async () => {
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
              toolToggles: {
                [providerIdToGuiHarnessId("claude-code")]: { search: false },
              },
              offFor: [],
            },
          }),
        ],
        hostServers: [],
        hostServersByProvider: {
          codex: [hostMcpServer("github", ["search", "open"])],
          "claude-code": [hostMcpServer("github", ["search", "open"])],
        },
      }),
    );
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

    await screen.findByText("github");
    await openServerCard("github");
    const search = await screen.findByRole("switch", {
      name: "github search",
    });
    expect(search.getAttribute("aria-checked")).toBe("false");
    expect(
      screen
        .getByRole("switch", { name: "github open" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty(
      "disabled",
      true,
    );

    await userEvent.click(screen.getByRole("button", { name: "Disable all" }));
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const writes = harness.paramsOf("environment.configuration.items.put");
      expect(writes).toHaveLength(1);
      expect(writes[0]).toHaveProperty("value.toolToggles", {
        [providerIdToGuiHarnessId("claude-code")]: {
          search: false,
          open: false,
        },
        [providerIdToGuiHarnessId("codex")]: { search: false, open: false },
      });
    });
  });

  it("enables Disable all for a mixed tool that is the only one on anywhere, and saves that provider off", async () => {
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
              toolToggles: {
                [providerIdToGuiHarnessId("claude-code")]: { search: false },
              },
              offFor: [],
            },
          }),
        ],
        hostServers: [],
        hostServersByProvider: {
          codex: [hostMcpServer("github", ["search"])],
          "claude-code": [hostMcpServer("github", ["search"])],
        },
      }),
    );
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

    await screen.findByText("github");
    await openServerCard("github");
    const search = await screen.findByRole("switch", {
      name: "github search",
    });
    expect(search.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("button", { name: "Disable all" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty(
      "disabled",
      true,
    );

    await userEvent.click(screen.getByRole("button", { name: "Disable all" }));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const writes = harness.paramsOf("environment.configuration.items.put");
      expect(writes).toHaveLength(1);
      expect(writes[0]).toHaveProperty("value.toolToggles", {
        [providerIdToGuiHarnessId("claude-code")]: { search: false },
        [providerIdToGuiHarnessId("codex")]: { search: false },
      });
    });
  });

  it("leaves a mixed tool's providers as stored when another tool is the one saved", async () => {
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
              toolToggles: {
                [providerIdToGuiHarnessId("codex")]: { search: true },
                [providerIdToGuiHarnessId("claude-code")]: { search: false },
              },
              offFor: [],
            },
          }),
        ],
        hostServers: [],
        hostServersByProvider: {
          codex: [hostMcpServer("github", ["search", "open"])],
          "claude-code": [hostMcpServer("github", ["search", "open"])],
        },
      }),
    );
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

    await screen.findByText("github");
    await openServerCard("github");
    expect(
      (
        await screen.findByRole("switch", { name: "github search" })
      ).getAttribute("aria-checked"),
    ).toBe("false");
    const open = screen.getByRole("switch", { name: "github open" });
    expect(open.getAttribute("aria-checked")).toBe("true");

    await userEvent.click(open);
    expect(
      screen
        .getByRole("switch", { name: "github search" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const writes = harness.paramsOf("environment.configuration.items.put");
      expect(writes).toHaveLength(1);
      expect(writes[0]).toHaveProperty("value.toolToggles", {
        [providerIdToGuiHarnessId("codex")]: { search: true, open: false },
        [providerIdToGuiHarnessId("claude-code")]: {
          search: false,
          open: false,
        },
      });
    });
  });

  it("saves an endpoint and its tool switches in one authn server write", async () => {
    negotiateMethods(ALL_METHODS);
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers({
        servers: () => [
          declaredServer({
            serverId: "srv-1",
            name: "github",
            item: {
              key: "github",
              revision: 4,
              toolToggles: {},
              offFor: [],
            },
          }),
        ],
        hostServers: [],
        hostServersByProvider: {
          codex: [hostMcpServer("github", ["search"])],
        },
      }),
      "environment.configuration.items": () => ({
        items: [
          configurationItem({
            kind: "mcp_server",
            key: "github",
            value: {
              mcpServerId: "srv-1",
              toolToggles: {},
              offFor: [],
            },
            revision: 4,
          }),
        ],
      }),
    });
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

    await screen.findByText("github");
    await openServerCard("github");
    const endpoint = await screen.findByLabelText("Endpoint URL for github");
    expect(endpoint).toHaveProperty("value", "https://github.invalid/mcp");
    const fetchStart = vi.mocked(globalThis.fetch).mock.calls.length;
    await userEvent.type(endpoint, "x");
    await userEvent.click(
      await screen.findByRole("switch", { name: "github search" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.mcpServers.put"),
      ).toHaveLength(1);
      expect(
        harness.paramsOf("environment.configuration.items.put"),
      ).toHaveLength(0);
    });
    expect(
      harness.paramsOf("environment.configuration.mcpServers.put")[0],
    ).toMatchObject({
      environmentId: "env-a",
      serverId: "srv-1",
      name: "github",
      url: "https://github.invalid/mcpx",
      toolToggles: { codex: { search: false } },
      offFor: [],
    });
    const writes: {
      readonly method: string;
      readonly path: string;
      readonly body: unknown;
    }[] = vi
      .mocked(globalThis.fetch)
      .mock.calls.slice(fetchStart)
      .flatMap(([input, init]) => {
        const method = init?.method;
        if (method === undefined || method === "GET") return [];
        let url: string;
        if (typeof input === "string") {
          url = input;
        } else if (input instanceof URL) {
          url = input.href;
        } else {
          url = input.url;
        }
        let body: unknown = null;
        if (typeof init?.body === "string") body = JSON.parse(init.body);
        return [
          {
            method,
            path: new URL(url).pathname,
            body,
          },
        ];
      });
    expect(writes).toHaveLength(1);
    const [write] = writes;
    expect(write.method).toBe("PATCH");
    expect(write.path).toBe("/api/v3/environments/env-a/mcp-servers/srv-1");
    expect(write.body).toMatchObject({
      url: "https://github.invalid/mcpx",
      item: {
        key: "github",
        value: {
          mcpServerId: "srv-1",
          toolToggles: { codex: { search: false } },
        },
        revision: 4,
        retire: null,
      },
    });
  });

  it("writes a shared tool setting only to providers that listed it", async () => {
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
              toolToggles: {
                claude: { search: false },
                opencode: { open: false },
              },
              offFor: [],
            },
          }),
        ],
        hostServers: [],
        hostServersByProvider: {
          codex: [hostMcpServer("github", ["search"])],
        },
      }),
    );
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

    await screen.findByText("github");
    await openServerCard("github");
    const search = await screen.findByRole("switch", { name: "github search" });
    expect(search.getAttribute("aria-checked")).toBe("true");
    expect(
      screen.queryByRole("switch", { name: "github Codex search" }),
    ).toBeNull();
    expect(screen.queryByText("Claude Code · Not listed")).toBeNull();
    expect(
      await screen.findByText(
        "Claude Code hasn't listed this server's tools yet.",
      ),
    ).toBeTruthy();
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toHaveLength(0);

    await userEvent.click(search);
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const writes = harness.paramsOf("environment.configuration.items.put");
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        environmentId: "env-a",
        kind: "mcp_server",
        key: "github",
        revision: 4,
      });
      expect(writes[0]).toHaveProperty("value.mcpServerId", "srv-1");
      expect(writes[0]).toHaveProperty("value.toolToggles", {
        codex: { search: false },
        claude: { search: false },
        opencode: { open: false },
      });
    });
  });

  describe("a server's Tools that cannot be shown", () => {
    /** One server only Claude Code serves, so its Tools section is one provider's. */
    function claudeOnly(): EnvironmentMcpServerDeclaration {
      return declaredServer({
        serverId: "srv-1",
        name: "github",
        item: {
          key: "github",
          revision: 4,
          toolToggles: {},
          offFor: offFor(CAPABLE.filter((id) => id !== "claude-code")),
        },
      });
    }

    it("says the provider's tools could not be read when the read fails, and Retry shows them", async () => {
      negotiateMethods(ALL_METHODS);
      let failing = true;
      const base = handlers({
        servers: () => [claudeOnly()],
        hostServers: [hostMcpServer("github", ["search"])],
      });
      const providersList = base["providers.list"];
      if (providersList === undefined)
        throw new Error("The harness serves providers.list.");
      const harness = mountTeamPage(poolSource("editor"), {
        ...base,
        "providers.list": (request) => {
          if (failing && request.native !== null) {
            throw new Error("host unavailable");
          }
          return providersList(request);
        },
      });
      render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

      await screen.findByText("github");
      await openServerCard("github");

      expect((await screen.findByRole("status")).textContent).toBe(
        "Couldn't read Claude Code's tools for this server.Retry",
      );

      failing = false;
      await userEvent.click(screen.getByRole("button", { name: "Retry" }));

      expect(
        await screen.findByRole("switch", {
          name: "github search",
        }),
      ).toBeTruthy();
    });

    it("says the provider has not listed the server's tools yet when the read answers without it", async () => {
      negotiateMethods(ALL_METHODS);
      const harness = mountTeamPage(
        poolSource("editor"),
        handlers({
          servers: () => [claudeOnly()],
          hostServers: [hostMcpServer("other", ["search"])],
        }),
      );
      render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

      await screen.findByText("github");
      await openServerCard("github");

      expect((await screen.findByRole("status")).textContent).toContain(
        "Claude Code hasn't listed this server's tools yet.",
      );
    });
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
      secrets: [OWNED_MCP_SECRET],
      lines: [
        "This removes github from every provider on every computer and sandbox running Personal.",
        "Its secret, MCP_SRV1_GitHub token, was added with this server and is deleted with it.",
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
      secrets: [EXTERNAL_MCP_SECRET],
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
      secrets: [],
      lines: [
        "This removes github from every provider on every host running Acme.",
      ],
    },
  ])(
    "asks before removing a server from $configuration, naming its secret only when it has one",
    async ({ source, credential, secrets, lines }) => {
      negotiateMethods(ALL_METHODS);
      const harness = mountTeamPage(source, {
        ...handlers({
          servers: () => [
            declaredServer({ serverId: "srv-1", name: "github", credential }),
          ],
          hostServers: [],
        }),
        "environment.secrets.list": () => ({ secrets, removed: [] }),
      });
      render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

      await openRemoveForGithub();
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

  it("removes an owned credential with its server id and no separate secret delete", async () => {
    negotiateMethods(ALL_METHODS);
    const harness = mountTeamPage(personalPoolSource(), {
      ...handlers({
        servers: () => [
          declaredServer({
            serverId: "srv-1",
            name: "github",
            credential: {
              kind: "secret",
              secretId: "sec-1",
              secretName: "MCP_SRV1_GitHub token",
              owned: true,
            },
          }),
        ],
        hostServers: [],
      }),
      "environment.secrets.list": () => ({
        secrets: [OWNED_MCP_SECRET],
        removed: [],
      }),
    });
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

    await openRemoveForGithub();
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        "Its secret, MCP_SRV1_GitHub token, was added with this server and is deleted with it.",
      ),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Remove server" }),
    );

    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.mcpServers.delete"),
      ).toEqual([{ environmentId: "env-personal", serverId: "srv-1" }]);
    });
    expect(harness.paramsOf("environment.secrets.destroy")).toHaveLength(0);
  });

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

    await openRemoveForGithub();
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

    await openRemoveForGithub();
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

  it.each([
    {
      outcome: "forbidden" as const,
      line: "You no longer have access to change these settings.",
    },
    { outcome: "refused" as const, line: "Couldn't remove this server." },
  ])(
    "says $line on the page when the host answers a removal $outcome, keeping the server listed",
    async ({ outcome, line }) => {
      negotiateMethods(ALL_METHODS);
      const harness = mountTeamPage(poolSource("editor"), {
        ...handlers({
          servers: () => [
            declaredServer({ serverId: "srv-1", name: "github" }),
          ],
          hostServers: [],
        }),
        "environment.configuration.mcpServers.delete": () => ({
          outcome,
          reason: null,
        }),
      });
      render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

      await openRemoveForGithub();
      await userEvent.click(
        within(await screen.findByRole("dialog")).getByRole("button", {
          name: "Remove server",
        }),
      );

      expect((await screen.findByRole("status")).textContent).toBe(line);
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      expect(screen.getByText("github")).toBeTruthy();
    },
  );

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
    for (const verb of ["Add a server", "Edit", "Remove github"]) {
      expect(screen.queryByRole("button", { name: verb })).toBeNull();
    }
    expect(screen.queryByRole("button", { name: /^More for / })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(
      within(screen.getByRole("listitem")).getByRole("button", {
        expanded: false,
      }),
    ).toBeTruthy();
  });

  it("names Personal, not a team, on Personal's page", async () => {
    negotiateMethods(ALL_METHODS);
    const harness = mountTeamPage(
      personalPoolSource(),
      handlers({ servers: () => [], hostServers: [] }),
    );
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

    await expectIntroduction(
      "Tools agents can call. Personal's servers reach every provider on every computer and sandbox running Personal.",
      "Personal",
      false,
    );
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
    expectAddBesideConnectedServers();
    await expectIntroduction(
      "Tools agents can call. Acme's servers reach every provider on its hosts.",
      "Acme",
      true,
    );
  });

  it.each([
    {
      held: [hostMcpServer("github", [])],
      line: "1 server on this computer only, not in Acme",
      link: "See it on Codex ▸ MCP",
    },
    {
      held: [hostMcpServer("github", []), hostMcpServer("linear", [])],
      line: "2 servers on this computer only, not in Acme",
      link: "See them on Codex ▸ MCP",
    },
  ])(
    "says $line on an empty page, linking to the provider's MCP tab",
    async ({ held, line, link }) => {
      negotiateMethods(ALL_METHODS);
      windowHostBoundary.hostId = reachableHost.hostId;
      const harness = mountTeamPage(
        poolSource("editor"),
        handlers({ servers: () => [], hostServers: held }),
      );
      render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

      expect(
        await screen.findByText(
          (_content, element) => element?.textContent === `${line} · ${link}`,
        ),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: link })).toBeTruthy();
    },
  );

  it("says nothing about servers on this computer when the viewing host is another computer", async () => {
    negotiateMethods(ALL_METHODS);
    windowHostBoundary.hostId = "host-elsewhere";
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({
        servers: () => [],
        hostServers: [hostMcpServer("github", [])],
      }),
    );
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

    await screen.findByText("MCP servers give agents tools.");
    await waitFor(() => {
      expect(harness.paramsOf("providers.list").length).toBeGreaterThan(1);
    });
    expect(screen.queryByText(/on this computer only/)).toBeNull();
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
});
