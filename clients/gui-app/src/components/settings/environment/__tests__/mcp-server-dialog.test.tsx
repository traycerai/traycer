import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { EnvironmentSecretV12 } from "@traycer/protocol/host/environment-schemas";
import type { EnvironmentMcpServerDeclaration } from "@traycer/protocol/host/environment/configuration-contracts";
import type { EnvironmentConfigurationMcpServerPutRequestV11 } from "@traycer/protocol/host/environment/configuration-contracts";
import { EnvironmentMcpServersPage } from "@/components/settings/environment/environment-mcp-servers";
import {
  initialMcpServerForm,
  mcpServerPutRequest,
} from "@/components/settings/environment/mcp-server-form";
import { useConfigurationMcpServerMutations } from "@/hooks/environment/team/use-mcp-servers";
import { useSubmittedSecretInput } from "@/hooks/use-submitted-secret-input";
import { createAppQueryClient } from "@/lib/query-client";
import { isRecord } from "@/lib/editor/prosemirror-json";
import { environmentMutationKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import { expectFocusRingInset } from "@/components/ui/__tests__/dialog-scroll-layout-assertions";
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
  type TeamPageHarness,
  windowHostScopeMock,
} from "./team-configuration-test-support";
import {
  RETIRED_PROVIDER_VARIABLES,
  RETIRED_SECRET_ROW_FIELDS,
} from "@traycer/protocol/host/released-wire-rows";

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

vi.mock(
  "@/components/settings/host-scope/use-host-scope",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/settings/host-scope/use-host-scope")
    >()),
    usePersonalHostScope: () => windowHostScopeMock(),
  }),
);

const appQueryClients: QueryClient[] = [];
const mutationCacheUnsubscribers: Array<() => void> = [];
const consoleSpyRestorers: Array<() => void> = [];

interface MutationObserverReference {
  readonly options: unknown;
}

function captureMutationObservers(
  queryClient: QueryClient,
): MutationObserverReference[] {
  const observers: MutationObserverReference[] = [];
  const unsubscribe = queryClient.getMutationCache().subscribe((event) => {
    if (event.type === "observerAdded") observers.push(event.observer);
  });
  mutationCacheUnsubscribers.push(unsubscribe);
  return observers;
}

function captureConsoleOutput(): unknown[][] {
  const output: unknown[][] = [];
  const debug = vi.spyOn(console, "debug").mockImplementation((...values) => {
    output.push(values);
  });
  const info = vi.spyOn(console, "info").mockImplementation((...values) => {
    output.push(values);
  });
  const log = vi.spyOn(console, "log").mockImplementation((...values) => {
    output.push(values);
  });
  const warn = vi.spyOn(console, "warn").mockImplementation((...values) => {
    output.push(values);
  });
  const error = vi.spyOn(console, "error").mockImplementation((...values) => {
    output.push(values);
  });
  consoleSpyRestorers.push(
    () => debug.mockRestore(),
    () => info.mockRestore(),
    () => log.mockRestore(),
    () => warn.mockRestore(),
    () => error.mockRestore(),
  );
  return output;
}

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  resetNegotiatedManifests();
  for (const unsubscribe of mutationCacheUnsubscribers.splice(0)) unsubscribe();
  for (const restore of consoleSpyRestorers.splice(0)) restore();
  for (const client of appQueryClients.splice(0)) client.clear();
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
  overrides: Partial<EnvironmentSecretV12>,
): EnvironmentSecretV12 {
  return {
    ...RETIRED_SECRET_ROW_FIELDS,
    providerVariables: [...RETIRED_PROVIDER_VARIABLES],
    secretId,
    name: secretId,
    kind: "api_key",
    protocol: null,
    destinations: ["api.acme.test:443"],
    currentVersionId: "v1",
    revoked: false,
    updatedAt: 1,
    variables: [],
    ...overrides,
  };
}

function handlers(options: {
  readonly servers: readonly EnvironmentMcpServerDeclaration[];
  readonly secrets: readonly EnvironmentSecretV12[];
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

async function openServerCard(name: string): Promise<void> {
  const row = (await screen.findAllByRole("listitem")).find(
    (item) => within(item).queryByText(name) !== null,
  );
  if (row === undefined) throw new Error(`No row for ${name}.`);
  await userEvent.click(within(row).getByRole("button", { expanded: false }));
}

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

async function fillPersonalPatTarget(dialog: HTMLElement): Promise<void> {
  await userEvent.type(within(dialog).getByLabelText("Name"), "github");
  await userEvent.type(
    within(dialog).getByLabelText("Web address"),
    "https://api.acme.test/mcp",
  );
  await choose(dialog, "Credential", "Secret");
}

async function submitPersonalPat(
  dialog: HTMLElement,
  secret: string,
): Promise<void> {
  await userEvent.type(within(dialog).getByLabelText("Secret value"), secret);
  await userEvent.click(within(dialog).getByRole("button", { name: "Add" }));
}

function withAppQueryClient(
  harness: TeamPageHarness,
  queryClient: QueryClient,
) {
  const TeamPageWrapper = harness.Wrapper;
  return function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <TeamPageWrapper>
        <QueryClientProvider client={queryClient}>
          {props.children}
        </QueryClientProvider>
      </TeamPageWrapper>
    );
  };
}

const FAKE_TEAM_MCP_PAT = "synthetic-team-mcp-pat";

function containsTeamPat(value: unknown): boolean {
  const seen = new WeakSet<object>();
  function contains(current: unknown): boolean {
    if (typeof current === "string") return current.includes(FAKE_TEAM_MCP_PAT);
    if (
      (typeof current !== "object" && typeof current !== "function") ||
      current === null
    ) {
      return false;
    }
    if (seen.has(current)) return false;
    seen.add(current);
    if (
      current instanceof Error &&
      (current.message.includes(FAKE_TEAM_MCP_PAT) || contains(current.cause))
    ) {
      return true;
    }
    return Object.values(current).some(contains);
  }
  return contains(value);
}

function mutationCacheContainsTeamPat(
  queryClient: QueryClient,
  observers: readonly MutationObserverReference[],
): boolean {
  return (
    queryClient
      .getMutationCache()
      .getAll()
      .some((mutation) =>
        containsTeamPat({
          variables: mutation.state.variables,
          context: mutation.state.context,
          data: mutation.state.data,
          error: mutation.state.error,
          meta: mutation.options.meta,
        }),
      ) || observers.some((observer) => containsTeamPat(observer.options))
  );
}

function requestContainsTeamPat(request: unknown): boolean {
  if (!isRecord(request) || !isRecord(request.credential)) return false;
  return (
    request.credential.kind === "pat" &&
    request.credential.pat === FAKE_TEAM_MCP_PAT
  );
}

function personalPatRequestMatches(request: unknown): boolean {
  return (
    isRecord(request) &&
    request.serverId === null &&
    requestContainsTeamPat(request)
  );
}

describe("The MCP server dialog", () => {
  it.each([
    {
      configuration: "Personal",
      source: personalPoolSource(),
      reach:
        "It reaches every provider on every host running this environment.",
    },
    {
      configuration: "Acme",
      source: poolSource("editor"),
      reach:
        "It reaches every provider on every host running this environment.",
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
      const scroller = dialog.querySelector("div.overflow-y-auto");
      if (scroller === null) throw new Error("expected the MCP form scroller");
      expectFocusRingInset(scroller, ["-m-1", "p-1"]);

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

  it("offers only the unrevoked secrets sent to the address, plus Add a secret, and binds the one picked", async () => {
    negotiate(PUT_1_1);
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({
        servers: [],
        secrets: [
          secret("acme-key", {}),
          secret("revoked-key", { revoked: true }),
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
        "Stored encrypted in Traycer's cloud. This environment's sandboxes and connected services use it without seeing it; no computer receives the value.",
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

  it("says the secrets could not be read to pick from, and Retry brings them into the select", async () => {
    negotiate(PUT_1_1);
    let failing = true;
    const harness = mountTeamPage(poolSource("editor"), {
      ...handlers({ servers: [], secrets: [], answer: SAVED }),
      "environment.secrets.list": () => {
        if (failing) throw new Error("host unavailable");
        return { secrets: [secret("acme-key", {})], removed: [] };
      },
    });
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });
    const dialog = await openAdd();

    await userEvent.type(
      within(dialog).getByLabelText("Web address"),
      "https://api.acme.test/mcp",
    );
    await choose(dialog, "Credential", "Secret");

    expect((await within(dialog).findByRole("status")).textContent).toBe(
      "Couldn't read the secrets to pick from.Retry",
    );

    failing = false;
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Retry" }),
    );
    await userEvent.click(
      within(dialog).getByRole("combobox", { name: "Secret" }),
    );

    expect(
      (await screen.findAllByRole("option")).map(
        (option) => option.textContent,
      ),
    ).toEqual(["acme-key", "Add a secret"]);
  });

  it("takes only a typed value on a host at put 1.0, and sends it as the PAT", async () => {
    negotiate(PUT_1_0);
    const harness = mountTeamPage(
      personalPoolSource(),
      handlers({ servers: [], secrets: [], answer: SAVED }),
    );
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });
    const dialog = await openAdd();

    await fillPersonalPatTarget(dialog);

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
    await submitPersonalPat(dialog, FAKE_TEAM_MCP_PAT);

    await waitFor(() => {
      const requests = harness.paramsOf(
        "environment.configuration.mcpServers.put",
      );
      expect(
        requests.length === 1 && personalPatRequestMatches(requests[0]),
      ).toBe(true);
    });
  });

  it("keeps the typed PAT in the form after a failed put", async () => {
    negotiate(PUT_1_0);
    const routes = handlers({ servers: [], secrets: [], answer: SAVED });
    const harness = mountTeamPage(personalPoolSource(), {
      ...routes,
      "environment.configuration.mcpServers.put": () => {
        throw new Error("Safe MCP write failure");
      },
    });
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });
    const dialog = await openAdd();
    await fillPersonalPatTarget(dialog);
    await submitPersonalPat(dialog, FAKE_TEAM_MCP_PAT);

    await waitFor(() =>
      expect(
        harness.queryClient
          .getMutationCache()
          .findAll({
            mutationKey: environmentMutationKeys.configurationMcpServersPut(),
          })
          .at(-1)?.state.status,
      ).toBe("error"),
    );
    const requests = harness.paramsOf(
      "environment.configuration.mcpServers.put",
    );
    const secretInput =
      within(dialog).getByLabelText<HTMLInputElement>("Secret value");
    expect({
      requestMatches:
        requests.length === 1 && personalPatRequestMatches(requests[0]),
      draftUnchanged: secretInput.value === FAKE_TEAM_MCP_PAT,
    }).toEqual({ requestMatches: true, draftUnchanged: true });
  });

  it.each([
    { settles: "successfully" as const, fail: false },
    { settles: "with an error" as const, fail: true },
  ])(
    "sends a typed PAT from the real mutation hook and retains none after it settles $settles",
    async ({ fail }) => {
      const consoleOutput = captureConsoleOutput();
      negotiate(PUT_1_0);
      const queryClient = createAppQueryClient();
      appQueryClients.push(queryClient);
      const observers = captureMutationObservers(queryClient);
      const routes = handlers({ servers: [], secrets: [], answer: SAVED });
      const harness = mountTeamPage(
        personalPoolSource(),
        fail
          ? {
              ...routes,
              "environment.configuration.mcpServers.put": () => {
                throw new Error("Safe MCP write failure");
              },
            }
          : routes,
      );
      await waitFor(() =>
        expect(useAuthStore.getState().status).toBe("signed-in"),
      );
      const { result, unmount } = renderHook(
        () => {
          const submitted =
            useSubmittedSecretInput<EnvironmentConfigurationMcpServerPutRequestV11>(
              "MCP server input is unavailable.",
            );
          return {
            input: submitted,
            mutation: useConfigurationMcpServerMutations(
              submitted.read,
              submitted.clear,
            ).put,
          };
        },
        { wrapper: withAppQueryClient(harness, queryClient) },
      );
      const request = mcpServerPutRequest(
        {
          ...initialMcpServerForm(null),
          name: "github",
          url: "https://api.acme.test/mcp",
        },
        null,
        "env-personal",
        { kind: "pat", pat: FAKE_TEAM_MCP_PAT },
      );
      const observations = { rejectionContainsPat: false };
      await act(async () => {
        result.current.input.set(request);
        try {
          await result.current.mutation.mutateAsync({
            environmentId: "env-personal",
            serverId: null,
          });
        } catch (error) {
          observations.rejectionContainsPat = containsTeamPat(error);
        }
      });
      await waitFor(() =>
        expect(result.current.mutation.status).toBe(fail ? "error" : "success"),
      );
      const retainedMutation = queryClient.getMutationCache().getAll().at(-1);
      if (retainedMutation === undefined)
        throw new Error("Team MCP mutation was not retained");
      const mutationFn = retainedMutation.options.mutationFn;
      if (mutationFn === undefined)
        throw new Error("Team MCP mutation has no mutation function");
      const putCallCount = harness.paramsOf(
        "environment.configuration.mcpServers.put",
      ).length;
      let replayRefused = false;
      let replayErrorContainsPat = false;
      try {
        await mutationFn(
          { environmentId: "env-personal", serverId: null },
          {
            client: queryClient,
            meta: retainedMutation.options.meta,
            mutationKey: retainedMutation.options.mutationKey ?? [],
          },
        );
      } catch (error) {
        replayRefused =
          error instanceof Error &&
          error.message === "MCP server input is unavailable.";
        replayErrorContainsPat = containsTeamPat(error);
      }
      const outgoingRequest = harness.paramsOf(
        "environment.configuration.mcpServers.put",
      )[0];
      expect(
        requestContainsTeamPat(outgoingRequest) &&
          retainedMutation.state.status === (fail ? "error" : "success") &&
          !mutationCacheContainsTeamPat(queryClient, observers) &&
          !containsTeamPat(consoleOutput) &&
          !containsTeamPat(result.current) &&
          !observations.rejectionContainsPat &&
          replayRefused &&
          !replayErrorContainsPat &&
          harness.paramsOf("environment.configuration.mcpServers.put")
            .length === putCallCount,
      ).toBe(true);
      unmount();
      expect({
        mutationCacheSecretFree: !mutationCacheContainsTeamPat(
          queryClient,
          observers,
        ),
        hookResultSecretFree: !containsTeamPat(result.current),
        logsSecretFree: !containsTeamPat(consoleOutput),
      }).toEqual({
        mutationCacheSecretFree: true,
        hookResultSecretFree: true,
        logsSecretFree: true,
      });
    },
  );

  it.each([
    { variable: "GITHUB_TOKEN", phrase: "a secret for GITHUB_TOKEN" },
    { variable: "", phrase: "a secret" },
  ])(
    "refuses a secret on a command server, saying $phrase, and keeps Add disabled",
    async ({ variable, phrase }) => {
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
          within(dialog).getByLabelText("Variable name"),
          variable,
        );
      }

      expect(
        within(dialog).getByText(
          `A server that runs as a command can't use ${phrase}. Add the server without it, or choose Remote if the server has a web address.`,
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

  it("keeps the arguments a command edit did not touch", async () => {
    negotiate(PUT_1_1);
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({
        servers: [
          declaredServer({
            serverId: "srv-2",
            name: "local",
            transport: "stdio",
            url: null,
            command: " /usr/bin/server ",
            args: ["--label", " padded ", ""],
          }),
        ],
        secrets: [],
        answer: SAVED,
      }),
    );
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

    await openServerCard("local");
    const command = screen.getByLabelText("Command for local");
    expect(command).toHaveProperty("value", " /usr/bin/server ");
    await userEvent.type(command, "x");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.mcpServers.put"),
      ).toHaveLength(1);
    });
    expect(
      harness.paramsOf("environment.configuration.mcpServers.put")[0],
    ).toMatchObject({
      serverId: "srv-2",
      name: "local",
      command: "/usr/bin/server x",
      args: ["--label", " padded ", ""],
    });
  });

  it("saves a disabled server's endpoint edit with its id and no toggles or providers, and never switches it on", async () => {
    negotiate(PUT_1_1);
    const harness = mountTeamPage(
      poolSource("editor"),
      handlers({
        servers: [
          declaredServer({ serverId: "srv-1", name: "github", item: null }),
        ],
        secrets: [],
        answer: SAVED,
      }),
    );
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

    await openServerCard("github");
    const endpoint = screen.getByLabelText("Endpoint URL for github");
    expect(endpoint).toHaveProperty("value", "https://github.invalid/mcp");
    await userEvent.type(endpoint, "x");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.mcpServers.put"),
      ).toHaveLength(1);
    });
    expect(
      harness.paramsOf("environment.configuration.mcpServers.put")[0],
    ).toMatchObject({
      serverId: "srv-1",
      name: "github",
      url: "https://github.invalid/mcpx",
      toolToggles: {},
      offFor: [],
    });
    expect(
      harness.paramsOf("environment.configuration.mcpServers.setEnabled"),
    ).toHaveLength(0);
  });

  it("saves an endpoint edit that leaves the sign-in unchanged, keeping the item's toggles and providers", async () => {
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

    await openServerCard("github");
    const endpoint = screen.getByLabelText("Endpoint URL for github");
    expect(endpoint).toHaveProperty("value", "https://github.invalid/mcp");
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty(
      "disabled",
      true,
    );
    await userEvent.type(endpoint, "x");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.mcpServers.put"),
      ).toEqual([
        {
          environmentId: "env-a",
          serverId: "srv-1",
          name: "github",
          transport: "http",
          url: "https://github.invalid/mcpx",
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
