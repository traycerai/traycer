import "../../../../../__tests__/test-browser-apis";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { EnvironmentSecret } from "@traycer/protocol/host/environment-schemas";
import type { EnvironmentMcpServerDeclaration } from "@traycer/protocol/host/environment/configuration-contracts";
import { EnvironmentMcpServersPage } from "@/components/settings/environment/environment-mcp-servers";
import type { HostRpcRegistry } from "@/lib/host";
import {
  declaredServer,
  negotiateMethods,
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

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  resetNegotiatedManifests();
});

const PUT_1_1 = { major: 1, minor: 1 };
const PUT_1_0 = { major: 1, minor: 0 };

function negotiate(put: { major: number; minor: number }): void {
  negotiateMethods({
    "environment.configuration.mcpServers.list": { major: 1, minor: 0 },
    "environment.configuration.mcpServers.put": put,
    "environment.configuration.mcpServers.delete": { major: 1, minor: 0 },
    "environment.secrets.list": { major: 1, minor: 1 },
  });
}

function secret(
  secretId: string,
  overrides: Partial<EnvironmentSecret>,
): EnvironmentSecret {
  return {
    secretId,
    name: secretId,
    kind: "api_key",
    protocol: null,
    destinations: ["api.acme.test:443"],
    mode: "brokered",
    state: "live",
    currentVersionId: "v1",
    revoked: false,
    updatedAt: 1,
    ...overrides,
  };
}

function handlers(options: {
  readonly servers: readonly EnvironmentMcpServerDeclaration[];
  readonly secrets: readonly EnvironmentSecret[];
  readonly answer: {
    readonly outcome: "saved" | "forbidden" | "refused";
    readonly reason: string | null;
  };
}): MockHandlerMap<HostRpcRegistry> {
  return {
    "environment.configuration.mcpServers.list": () => ({
      servers: [...options.servers],
    }),
    "environment.configuration.mcpServers.put": () => ({
      ...options.answer,
      serverId: null,
    }),
    "environment.secrets.list": () => ({
      secrets: [...options.secrets],
      removed: [],
    }),
    "environment.host.list": () => ({ hosts: [reachableHost] }),
    "environment.list": () => teamEnvironments,
    "providers.list": () => ({ providers: [], native: null }),
  };
}

const SAVED = { outcome: "saved" as const, reason: null };

async function openAdd(): Promise<HTMLElement> {
  await userEvent.click(
    await screen.findByRole("button", { name: "Add a server" }),
  );
  return screen.findByRole("dialog");
}

async function choose(
  dialog: HTMLElement,
  field: string,
  option: string,
): Promise<void> {
  await userEvent.click(within(dialog).getByRole("combobox", { name: field }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

describe("The MCP server dialog", () => {
  it.each([
    {
      configuration: "Personal",
      source: personalPoolSource(),
      reach:
        "It reaches every provider on every computer and sandbox running Personal.",
    },
    {
      configuration: "Acme",
      source: poolSource("editor"),
      reach: "It reaches every provider on every host running Acme.",
    },
  ])(
    "adds to $configuration with no scope picker",
    async ({ configuration, source, reach }) => {
      negotiate(PUT_1_1);
      const harness = mountTeamPage(
        source,
        handlers({ servers: [], secrets: [], answer: SAVED }),
      );
      render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

      const dialog = await openAdd();

      expect(
        within(dialog).getByText(`Add an MCP server to ${configuration}`),
      ).toBeTruthy();
      expect(within(dialog).getByText(reach)).toBeTruthy();
      expect(
        within(dialog)
          .getAllByRole("combobox")
          .map((box) => box.getAttribute("aria-label")),
      ).toEqual(["Server type", "Credential"]);
    },
  );

  it("sends a create with no sign-in for every provider", async () => {
    negotiate(PUT_1_1);
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({ servers: [], secrets: [], answer: SAVED }),
    );
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });
    const dialog = await openAdd();

    await userEvent.type(within(dialog).getByLabelText("Name"), " github ");
    await userEvent.type(
      within(dialog).getByLabelText("Web address"),
      "https://api.acme.test/mcp",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.mcpServers.put"),
      ).toEqual([
        {
          environmentId: "env-a",
          serverId: null,
          name: "github",
          transport: "http",
          url: "https://api.acme.test/mcp",
          command: null,
          args: [],
          env: [],
          toolToggles: {},
          offFor: [],
          credential: { kind: "none" },
        },
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("offers only the live, brokered, unrevoked secrets sent to the address, plus Add a secret, and binds the one picked", async () => {
    negotiate(PUT_1_1);
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({
        servers: [],
        secrets: [
          secret("acme-key", {}),
          secret("revoked-key", { revoked: true }),
          secret("pending-key", { state: "pending_review" }),
          secret("exposed-key", { mode: "exposed" }),
          secret("elsewhere-key", { destinations: ["other.test:443"] }),
        ],
        answer: SAVED,
      }),
    );
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });
    const dialog = await openAdd();

    await userEvent.type(within(dialog).getByLabelText("Name"), "github");
    await userEvent.type(
      within(dialog).getByLabelText("Web address"),
      "https://api.acme.test/mcp",
    );
    await choose(dialog, "Credential", "Secret");
    expect(
      within(dialog).getByText(
        "Pick or add a secret. It is sent only to this server's address.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        "Stored encrypted in Traycer's cloud. Acme's sandboxes and connected services use it without seeing it; no computer receives the value.",
      ),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("combobox", { name: "Secret" }),
    );
    expect(
      (await screen.findAllByRole("option")).map(
        (option) => option.textContent,
      ),
    ).toEqual(["acme-key", "Add a secret"]);
    await userEvent.click(screen.getByRole("option", { name: "acme-key" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.mcpServers.put"),
      ).toMatchObject([
        {
          serverId: null,
          credential: { kind: "secret", secretId: "acme-key" },
        },
      ]);
    });
  });

  it("takes only a typed value on a host at put 1.0, and sends it as the PAT", async () => {
    negotiate(PUT_1_0);
    const harness = mountTeamPage(
      personalPoolSource(),
      handlers({ servers: [], secrets: [], answer: SAVED }),
    );
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });
    const dialog = await openAdd();

    await userEvent.type(within(dialog).getByLabelText("Name"), "github");
    await userEvent.type(
      within(dialog).getByLabelText("Web address"),
      "https://api.acme.test/mcp",
    );
    await choose(dialog, "Credential", "Secret");

    expect(
      within(dialog).getByText(
        "Add a secret. It is sent only to this server's address.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        "Stored encrypted in Traycer's cloud. Computers running Personal receive the value, readable by their tools and agents; sandboxes use it without seeing it.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).queryByRole("combobox", { name: "Secret" }),
    ).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Add" })).toHaveProperty(
      "disabled",
      true,
    );
    await userEvent.type(
      within(dialog).getByLabelText("Secret value"),
      "tok-1",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.mcpServers.put"),
      ).toMatchObject([
        { serverId: null, credential: { kind: "pat", pat: "tok-1" } },
      ]);
    });
  });

  it.each([
    { variable: "GITHUB_TOKEN", field: "GITHUB_TOKEN" },
    { variable: "", field: "this server" },
  ])(
    "refuses a secret on a command server, naming $field, and keeps Add disabled",
    async ({ variable, field }) => {
      negotiate(PUT_1_1);
      const harness = mountTeamPage(
        poolSource("editor"),
        handlers({ servers: [], secrets: [], answer: SAVED }),
      );
      render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });
      const dialog = await openAdd();

      await choose(dialog, "Server type", "Command");
      await userEvent.type(within(dialog).getByLabelText("Name"), "local");
      await userEvent.type(within(dialog).getByLabelText("Command"), "npx");
      await choose(dialog, "Credential", "Secret");
      if (variable.length > 0) {
        await userEvent.type(
          within(dialog).getByLabelText("Environment variable name"),
          variable,
        );
      }

      expect(
        within(dialog).getByText(
          `A server that runs as a command can't use a secret for ${field}. Add the server without it, or choose Remote if the server has a web address.`,
        ),
      ).toBeTruthy();
      expect(
        within(dialog).getByRole("button", { name: "Add" }),
      ).toHaveProperty("disabled", true);
      expect(
        harness.paramsOf("environment.configuration.mcpServers.put"),
      ).toHaveLength(0);
    },
  );

  it("saves an edit that leaves the sign-in unchanged, keeping the item's toggles and providers", async () => {
    negotiate(PUT_1_1);
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({
        servers: [
          declaredServer({
            serverId: "srv-1",
            name: "github",
            env: ["GITHUB_TOKEN"],
            credential: {
              kind: "secret",
              secretId: "acme-key",
              secretName: "acme-key",
              owned: false,
            },
            item: {
              key: "github",
              revision: 4,
              toolToggles: { claude: { search: false } },
              offFor: ["codex"],
            },
          }),
        ],
        secrets: [],
        answer: SAVED,
      }),
    );
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Edit github")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.mcpServers.put"),
      ).toEqual([
        {
          environmentId: "env-a",
          serverId: "srv-1",
          name: "github",
          transport: "http",
          url: "https://github.invalid/mcp",
          command: null,
          args: [],
          env: ["GITHUB_TOKEN"],
          toolToggles: { claude: { search: false } },
          offFor: ["codex"],
          credential: { kind: "unchanged" },
        },
      ]);
    });
  });

  it("names the secret and every host it is sent to when the server's address is refused", async () => {
    negotiate(PUT_1_1);
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({
        servers: [],
        secrets: [
          secret("acme-key", {
            name: "Acme key",
            destinations: ["x.com:443", "y.com:443"],
          }),
        ],
        answer: { outcome: "refused", reason: "secret_destination_mismatch" },
      }),
    );
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });
    const dialog = await openAdd();

    await userEvent.type(within(dialog).getByLabelText("Name"), "github");
    await userEvent.type(
      within(dialog).getByLabelText("Web address"),
      "https://x.com/mcp",
    );
    await choose(dialog, "Credential", "Secret");
    await choose(dialog, "Secret", "Acme key");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    expect(
      await within(dialog).findByText(
        "Acme key is only ever sent to x.com and y.com, not to this server's address. Pick another secret, or add one for this address.",
      ),
    ).toBeTruthy();
  });

  it.each([
    {
      configuration: "Personal",
      source: personalPoolSource(),
      answer: { outcome: "refused" as const, reason: "name_taken" },
      line: "Personal already has a server named github. Pick another name.",
    },
    {
      configuration: "Acme",
      source: poolSource("editor"),
      answer: { outcome: "refused" as const, reason: "name_taken" },
      line: "Acme already has a server named github. Pick another name.",
    },
    {
      configuration: "Acme",
      source: poolSource("editor"),
      answer: { outcome: "forbidden" as const, reason: null },
      line: "You no longer have access to change these settings.",
    },
  ])(
    "keeps the dialog open and says why when $configuration's answer is $answer.outcome ($answer.reason)",
    async ({ source, answer, line }) => {
      negotiate(PUT_1_1);
      const harness = mountTeamPage(
        source,
        handlers({ servers: [], secrets: [], answer }),
      );
      render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });
      const dialog = await openAdd();

      await userEvent.type(within(dialog).getByLabelText("Name"), "github");
      await userEvent.type(
        within(dialog).getByLabelText("Web address"),
        "https://api.acme.test/mcp",
      );
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Add" }),
      );

      expect(await within(dialog).findByText(line)).toBeTruthy();
      expect(screen.getByRole("dialog")).toBe(dialog);
    },
  );
});
