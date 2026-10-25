// The Personal pages read through the window's own host. Mocked at the scope
// boundary, as the other Personal suites do, because they render bare, without
// the host runtime the real scope composes.
const scopeOverrides = vi.hoisted((): { current: Record<string, unknown> } => ({
  current: {},
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const useHostScope = () => hostScopeFixture(scopeOverrides.current);
  return { useHostScope, usePersonalHostScope: useHostScope };
});

// The app-wide host client and binding. The client is a REAL `HostClient` over
// an in-memory messenger (`buildEnvironmentClient`): only the host on the far
// side is faked. The binding carries the minter `useExecutableWriteGrant` reads.
const hostMock = vi.hoisted(
  (): { client: unknown; binding: { readonly auth: unknown } | null } => ({
    client: null,
    binding: null,
  }),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => hostMock.client,
    useHostBinding: () => hostMock.binding,
  };
});

// Which scope the MCP and Skills tabs draw. The tabs' own scope picker needs
// workspaces and worktrees, which this suite is not about.
const scopeMock = vi.hoisted((): { scope: "global" | "project" } => ({
  scope: "global",
}));
vi.mock("@/components/settings/panels/use-provider-native-scope", () => ({
  useProviderNativeScope: () => ({
    hostId: "host-a",
    targets: [],
    workspaceRoot: scopeMock.scope === "project" ? "/repo" : null,
    setWorkspaceRoot: (_path: string): void => undefined,
    browseForWorkspace: (): Promise<string | null> => Promise.resolve(null),
    browsePending: false,
    multiWorkspace: false,
    multiScope: false,
    effectiveScope: scopeMock.scope,
    setScope: (_scope: "global" | "project"): void => undefined,
    projectNeedsWorkspace: false,
    listWorkspaceRoot: scopeMock.scope === "project" ? "/repo" : null,
    listEnabled: true,
    workspacesLoading: false,
  }),
}));

// What each provider's native lists answer. The lists are the host's own
// config files; the suite says what is in them.
const listMock = vi.hoisted(
  (): {
    servers: ProviderMcpServer[];
    skills: ProviderSkill[];
  } => ({ servers: [], skills: [] }),
);
vi.mock("@/hooks/providers/use-providers-mcp-list-query", () => ({
  useProvidersMcpList: () => ({
    data: { servers: listMock.servers },
    isPending: false,
    isError: false,
    error: null,
    isFetching: false,
  }),
}));
vi.mock("@/hooks/providers/use-providers-skills-list-query", () => ({
  useProvidersSkillsList: () => ({
    data: { skills: listMock.skills },
    isLoading: false,
    isPending: false,
    isError: false,
    error: null,
  }),
}));

// The tabs' own row actions are not under test; inert so a stray call shows
// up as no request on the host.
vi.mock("@/hooks/providers/use-providers-mcp-mutate-mutation", () => ({
  useProvidersMcpMutate: () => ({
    mutate: () => undefined,
    mutateAsync: () => Promise.resolve(undefined),
    isPending: false,
  }),
  useProvidersMcpApplyRemedy: () => ({
    mutate: () => undefined,
    mutateAsync: () => Promise.resolve(undefined),
    isPending: false,
  }),
}));
vi.mock("@/hooks/providers/use-providers-mcp-discover-mutation", () => ({
  useProvidersMcpDiscover: () => ({
    mutate: () => undefined,
    isPending: false,
  }),
}));
vi.mock("@/hooks/providers/use-providers-mcp-auth-mutation", () => ({
  useProvidersMcpAuth: () => ({ mutate: () => undefined, isPending: false }),
}));
vi.mock("@/hooks/providers/use-providers-skills-mutate-mutation", () => ({
  useProvidersSkillsMutate: () => ({
    mutate: () => undefined,
    mutateAsync: () => Promise.resolve(undefined),
    isPending: false,
  }),
}));
vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => null,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), message: vi.fn() },
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => () => undefined,
}));
vi.mock("@/hooks/workspace/use-read-file-query", () => ({
  useWorkspaceReadFile: () => ({
    data: undefined,
    isPending: false,
    isError: false,
    error: null,
  }),
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { RequestOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { EnvironmentItemStatus } from "@traycer/protocol/host/environment-schemas";
import type {
  ProviderMcpCapabilities,
  ProviderMcpServer,
  ProviderSkill,
} from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { ProviderMcpTab } from "@/components/settings/panels/provider-mcp-tab";
import { ProviderSkillsTab } from "@/components/settings/panels/provider-skills-tab";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { PersonalPageFrame } from "@/components/settings/personal/personal-page-frame";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
  itemStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import type { SettingsSectionId } from "@/lib/settings-sections";

const HOST_ID = "host-a";
const HOST_NAME = "dev-box";
const MARK = "local-entry-mark";
const PERSONAL = "personal-entry-mark";

type NativeMutateRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.nativeMutate"
>;

afterEach(() => {
  useSettingsEnvironmentPickStore.setState({ pick: null });
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  hostMock.client = null;
  hostMock.binding = null;
  scopeMock.scope = "global";
  listMock.servers = [];
  listMock.skills = [];
  vi.mocked(toast.error).mockClear();
});

const GLOBAL_MCP_CAPS: ProviderMcpCapabilities = {
  transports: ["stdio", "http"],
  authTypes: ["none", "header", "oauth"],
  authActions: ["login", "logout"],
  actionScopes: {
    list: ["global", "project"],
    add: ["global", "project"],
    update: ["global", "project"],
    remove: ["global", "project"],
    toggleServer: ["global", "project"],
    toggleTool: ["global", "project"],
    discover: ["global", "project"],
    auth: ["global", "project"],
  },
  addServer: "cli",
  removeServer: "cli",
  updateServer: "patch",
  perToolBacking: "native",
  statusSource: "probe",
  toolsSource: "probe",
  schemasSource: "probe",
  instructionsSource: "probe",
  traycerSessionsOnlyEnforcement: false,
  stdioDegradeNotice: false,
  oauthDegradesToConfigOnly: true,
};

function mcpServer(name: string): ProviderMcpServer {
  return {
    name,
    enabled: true,
    transport: { type: "http", url: `https://${name}.invalid/mcp`, auth: null },
    status: "connected",
    statusSource: "probe",
    statusDetail: null,
    tools: [],
    discoveryPending: false,
    instructions: null,
    configOnly: false,
    stdioDegraded: false,
  };
}

function skill(name: string): ProviderSkill {
  return {
    name,
    description: `${name} skill`,
    path: `/Users/dev/.agents/skills/${name}`,
    source: "shared",
  };
}

function skillsState(): ProviderCliState {
  return {
    providerId: "claude-code",
    enabled: true,
    disabledBy: null,
    nativeCapabilities: {
      supportedTabs: ["skills"],
      mcp: null,
      plugins: null,
      skills: {
        actionScopes: {
          list: ["global", "project"],
          add: [],
          create: [],
          import: [],
          remove: [],
        },
      },
      modelProviders: null,
    },
    selected: { kind: "bundled" },
    candidates: [],
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles: [],
  };
}

interface HostOptions {
  /** `providers.nativeMutate` as the host negotiated it; `null` = not at all. */
  readonly nativeMutate: {
    readonly major: number;
    readonly minor: number;
  } | null;
  /** Items the host has already applied, before the page opens. */
  readonly applied: readonly EnvironmentItemStatus[];
  /** How the host answers an Add to Personal: it takes it, refuses it in words, or cannot be reached. */
  readonly promote: "ok" | "unreachable" | { readonly refusal: string };
}

interface Rig {
  /** Every `providers.nativeMutate` the host was sent, in order. */
  readonly sent: NativeMutateRequest[];
  /** What the host has applied as the person's items, as `environment.status` says. */
  readonly applied: EnvironmentItemStatus[];
  readonly mintedFor: string[];
}

const READY_HOST: HostOptions = {
  nativeMutate: { major: 1, minor: 3 },
  applied: [],
  promote: "ok",
};

/**
 * Renders `page` inside a real Personal frame over a fake host. The host
 * answers `environment.status` from `rig.applied` and answers a
 * `promoteToPersonal` by applying the entry as the person's item, which is
 * what the real host does once the environment accepts the upload.
 *
 * `appliedAs` is filled by the host's apply path; here the fake host sets it.
 */
function renderPage(
  section: SettingsSectionId,
  page: ReactNode,
  options: HostOptions,
): Rig {
  const rig: Rig = { sent: [], applied: [...options.applied], mintedFor: [] };
  const handlers: MockHandlerMap<HostRpcRegistry> = {
    "environment.status": () =>
      environmentStatusFixture({ items: [...rig.applied] }),
    "environment.localOverrides": () => ({ overrides: [] }),
    "providers.nativeMutate": (request) => {
      rig.sent.push(request);
      if (options.promote === "unreachable")
        return Promise.reject(new Error("host unavailable"));
      if (typeof options.promote === "object")
        return Promise.resolve({
          result: {
            ok: false,
            code: "environment_mismatch",
            detail: options.promote.refusal,
          },
        });
      if (request.mutation.kind === "promoteToPersonal") {
        rig.applied.push(
          itemStatusFixture({
            kind: request.mutation.entryKind === "mcp" ? "mcp_server" : "skill",
            key: request.mutation.name,
            appliedAs: {
              entryKind: request.mutation.entryKind,
              name: request.mutation.name,
            },
          }),
        );
      }
      return Promise.resolve({
        result: { ok: true, kind: "mcp", servers: [] },
      });
    },
  };
  const { client } = buildEnvironmentClient({ hostId: HOST_ID, handlers });
  const manifest: Record<string, { major: number; minor: number }> = {
    "environment.status": { major: 1, minor: 1 },
    "environment.localOverrides": { major: 1, minor: 0 },
  };
  if (options.nativeMutate !== null) {
    manifest["providers.nativeMutate"] = options.nativeMutate;
  }
  recordNegotiatedHostManifest(HOST_ID, manifest);
  hostMock.client = client;
  hostMock.binding = {
    auth: {
      mintExecutableWriteGrant: (hostId: string) => {
        rig.mintedFor.push(hostId);
        return Promise.resolve({
          kind: "ok" as const,
          grant: "grant-1",
          expiresInSeconds: 600,
        });
      },
      getCredentialGeneration: () => 0,
    },
  };
  // These cases are about a host's own pages, which a Local row reads.
  useSettingsEnvironmentPickStore.setState({
    pick: { kind: "local", hostId: HOST_ID, hostName: HOST_NAME },
  });
  scopeOverrides.current = {
    host: hostScopeOptionFixture({ hostId: HOST_ID, name: HOST_NAME }),
    hostId: HOST_ID,
    status: "ready",
    client,
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <PersonalPageFrame section={section}>{page}</PersonalPageFrame>
    </QueryClientProvider>,
  );
  return rig;
}

function mcpPage(): ReactNode {
  return (
    <ProviderMcpTab
      providerId="claude-code"
      capabilities={GLOBAL_MCP_CAPS}
      providerLabel="Claude Code"
      cliBinaryResolved
    />
  );
}

function skillsPage(): ReactNode {
  return <ProviderSkillsTab state={skillsState()} />;
}

/** The MCP row for `name`: the list item around its expand button, once the page has mounted. */
async function mcpRow(name: string): Promise<HTMLElement> {
  const row = (
    await screen.findByRole("button", { name: `Expand ${name}` })
  ).closest("li");
  if (row === null) throw new Error(`no row for ${name}`);
  return row;
}

/** The skill row for `name`: the list item around its open button. */
async function skillRow(name: string): Promise<HTMLElement> {
  const row = (
    await screen.findByRole("button", { name: new RegExp(`^Open ${name} `) })
  ).closest("li");
  if (row === null) throw new Error(`no row for ${name}`);
  return row;
}

/**
 * Lets everything a NEGATIVE assertion depends on happen first. `waitFor`
 * cannot carry one: it passes on its first check, before the status read or a
 * stray request could have landed.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  });
}

describe("A `claude mcp add` entry on a provider's MCP tab", () => {
  it("shows as local and becomes Personal only on the click", async () => {
    listMock.servers = [mcpServer("github")];
    const rig = renderPage("providers", mcpPage(), READY_HOST);

    // The host has applied none of the person's items as `github`, so the
    // entry is only on this host - and the button is the one way to change it.
    const row = await mcpRow("github");
    const mark = await within(row).findByTestId(MARK);
    expect(mark.textContent).toContain(`On ${HOST_NAME} only`);
    const add = within(mark).getByRole("button", { name: "Add to Personal" });
    expect(within(row).queryByTestId(PERSONAL)).toBeNull();

    // Seeing the entry, polling the status and settling uploads nothing.
    await settle();
    expect(rig.sent).toEqual([]);

    fireEvent.click(add);
    await within(row).findByTestId(PERSONAL);

    // Exactly one request, for exactly this entry, at global scope.
    expect(rig.sent).toHaveLength(1);
    expect(rig.sent[0]).toMatchObject({
      providerId: "claude-code",
      mutation: {
        kind: "promoteToPersonal",
        entryKind: "mcp",
        scope: "global",
        workspaceRoot: null,
        name: "github",
      },
    });
    // What it uploads can run on every host, so it carries the grant the
    // person's own session minted for THIS host.
    expect(rig.sent[0]?.executableWriteGrant).toBe("grant-1");
    expect(rig.mintedFor).toEqual([HOST_ID]);

    // Now the host's status says the person's item applied as `github`: the
    // row says Personal, with no local line and no button left to click.
    expect(within(row).getByTestId(PERSONAL).textContent).toBe("Personal");
    expect(within(row).queryByTestId(MARK)).toBeNull();
    expect(
      within(row).queryByRole("button", { name: "Add to Personal" }),
    ).toBeNull();
    await settle();
    expect(rig.sent).toHaveLength(1);
  });

  it("control: an MCP server row on the same ready host keeps its Add to Personal button", async () => {
    listMock.servers = [mcpServer("github")];
    renderPage("providers", mcpPage(), READY_HOST);

    const mark = await within(await mcpRow("github")).findByTestId(MARK);
    expect(mark.textContent).toContain(`On ${HOST_NAME} only`);
    expect(
      within(mark).getByRole("button", { name: "Add to Personal" }),
    ).toBeTruthy();
  });

  it("shows the host's words beside Add to Personal when it refuses, and raises no toast", async () => {
    listMock.servers = [mcpServer("github")];
    const rig = renderPage("providers", mcpPage(), {
      ...READY_HOST,
      promote: { refusal: "Personal already has a server called github." },
    });

    const row = await mcpRow("github");
    fireEvent.click(
      await within(row).findByRole("button", { name: "Add to Personal" }),
    );

    expect(
      await within(row).findByText(
        "Personal already has a server called github.",
      ),
    ).toBeTruthy();
    expect(rig.sent).toHaveLength(1);
    expect(within(row).queryByTestId(PERSONAL)).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("still toasts when Add to Personal cannot reach the host", async () => {
    listMock.servers = [mcpServer("github")];
    renderPage("providers", mcpPage(), {
      ...READY_HOST,
      promote: "unreachable",
    });

    fireEvent.click(
      await within(await mcpRow("github")).findByRole("button", {
        name: "Add to Personal",
      }),
    );

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).toContain(
      "Couldn't add it to Personal.",
    );
  });

  it("marks only the entries the host applied, matched on kind and name", async () => {
    listMock.servers = [mcpServer("github"), mcpServer("linear")];
    // `github` applied as an MCP server; a SKILL called `linear` applied too,
    // which must not mark the MCP server of the same name.
    renderPage("providers", mcpPage(), {
      ...READY_HOST,
      applied: [
        itemStatusFixture({
          kind: "mcp_server",
          key: "github",
          appliedAs: { entryKind: "mcp", name: "github" },
        }),
        itemStatusFixture({
          kind: "skill",
          key: "linear-skill-key",
          appliedAs: { entryKind: "skills", name: "linear" },
        }),
      ],
    });

    expect(
      await within(await mcpRow("github")).findByTestId(PERSONAL),
    ).toBeTruthy();
    const linear = await mcpRow("linear");
    expect((await within(linear).findByTestId(MARK)).textContent).toContain(
      `On ${HOST_NAME} only`,
    );
    expect(within(linear).queryByTestId(PERSONAL)).toBeNull();
  });

  it("says where the entry is, with no button, on a host at nativeMutate 1.0", async () => {
    listMock.servers = [mcpServer("github")];
    const rig = renderPage("providers", mcpPage(), {
      ...READY_HOST,
      nativeMutate: { major: 1, minor: 0 },
    });

    const mark = await within(await mcpRow("github")).findByTestId(MARK);
    expect(mark.textContent).toContain(`On ${HOST_NAME} only`);
    expect(
      within(mark).queryByRole("button", { name: "Add to Personal" }),
    ).toBeNull();
    await settle();
    expect(rig.sent).toEqual([]);
  });

  // 1.2 is the line below `promoteToPersonal`, which refuses it.
  it("says where the entry is, with no button, on a host at nativeMutate 1.2", async () => {
    listMock.servers = [mcpServer("github")];
    const rig = renderPage("providers", mcpPage(), {
      ...READY_HOST,
      nativeMutate: { major: 1, minor: 2 },
    });

    const mark = await within(await mcpRow("github")).findByTestId(MARK);
    expect(mark.textContent).toContain(`On ${HOST_NAME} only`);
    expect(
      within(mark).queryByRole("button", { name: "Add to Personal" }),
    ).toBeNull();
    await settle();
    expect(rig.sent).toEqual([]);
  });

  it("offers no button on a host that does not negotiate providers.nativeMutate", async () => {
    listMock.servers = [mcpServer("github")];
    renderPage("providers", mcpPage(), {
      ...READY_HOST,
      nativeMutate: null,
    });

    const mark = await within(await mcpRow("github")).findByTestId(MARK);
    expect(
      within(mark).queryByRole("button", { name: "Add to Personal" }),
    ).toBeNull();
  });

  it("shows no mark on a project-scope row, which stays with its project", async () => {
    scopeMock.scope = "project";
    listMock.servers = [mcpServer("github")];
    const rig = renderPage("providers", mcpPage(), READY_HOST);

    const row = await mcpRow("github");
    // The status has been read and the row is drawn; neither mark appears.
    await settle();
    expect(within(row).queryByTestId(MARK)).toBeNull();
    expect(within(row).queryByTestId(PERSONAL)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Add to Personal" }),
    ).toBeNull();
    expect(rig.sent).toEqual([]);
  });

  it("shows no mark outside a Personal page", async () => {
    listMock.servers = [mcpServer("github")];
    const queryClient = new QueryClient();
    const { client } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {},
    });
    hostMock.client = client;
    render(
      <QueryClientProvider client={queryClient}>
        {mcpPage()}
      </QueryClientProvider>,
    );

    const row = await mcpRow("github");
    await settle();
    expect(within(row).queryByTestId(MARK)).toBeNull();
    expect(within(row).queryByTestId(PERSONAL)).toBeNull();
  });
});

describe("A skill on a provider's Skills tab", () => {
  it("says where the skill is, and becomes Personal only on the Add to Personal click", async () => {
    listMock.skills = [skill("deploy")];
    const rig = renderPage("providers", skillsPage(), READY_HOST);

    const row = await skillRow("deploy");
    const mark = await within(row).findByTestId(MARK);
    expect(mark.textContent).toContain(`On ${HOST_NAME} only`);
    const add = within(mark).getByRole("button", { name: "Add to Personal" });
    expect(within(row).queryByTestId(PERSONAL)).toBeNull();

    await settle();
    expect(rig.sent).toEqual([]);

    fireEvent.click(add);
    await within(row).findByTestId(PERSONAL);

    expect(rig.sent).toHaveLength(1);
    expect(rig.sent[0]).toMatchObject({
      providerId: "claude-code",
      mutation: {
        kind: "promoteToPersonal",
        entryKind: "skills",
        scope: "global",
        name: "deploy",
      },
    });
  });

  it("reads a built-in skill as Built-in alone, while a shared skill beside it still says where it is", async () => {
    listMock.skills = [
      { ...skill("review"), source: "managed" },
      skill("deploy"),
    ];
    renderPage("providers", skillsPage(), READY_HOST);

    const shared = await within(await skillRow("deploy")).findByTestId(MARK);
    expect(shared.textContent).toContain(`On ${HOST_NAME} only`);
    const builtIn = await skillRow("review");
    expect(within(builtIn).getByText("Built-in")).toBeTruthy();
    expect(within(builtIn).queryByTestId(MARK)).toBeNull();
    expect(builtIn.textContent).not.toContain("only");
  });

  it("sits beside the open button, not inside it", async () => {
    listMock.skills = [skill("deploy")];
    renderPage("providers", skillsPage(), READY_HOST);

    const row = await skillRow("deploy");
    const mark = await within(row).findByTestId(MARK);
    const open = within(row).getByRole("button", { name: /^Open deploy / });
    // A button inside a button is invalid; the mark's own button must not be
    // a descendant of the row's open button.
    expect(open.contains(mark)).toBe(false);
  });

  it("says where the skill is, with no button, on a host at nativeMutate 1.0", async () => {
    listMock.skills = [skill("deploy")];
    const rig = renderPage("providers", skillsPage(), {
      ...READY_HOST,
      nativeMutate: { major: 1, minor: 0 },
    });

    const mark = await within(await skillRow("deploy")).findByTestId(MARK);
    expect(mark.textContent).toContain(`On ${HOST_NAME} only`);
    expect(
      within(mark).queryByRole("button", { name: "Add to Personal" }),
    ).toBeNull();
    await settle();
    expect(rig.sent).toEqual([]);
  });

  it("shows no mark on a project-scope skill", async () => {
    scopeMock.scope = "project";
    listMock.skills = [skill("deploy")];
    const rig = renderPage("providers", skillsPage(), READY_HOST);

    const row = await skillRow("deploy");
    await settle();
    expect(within(row).queryByTestId(MARK)).toBeNull();
    expect(within(row).queryByTestId(PERSONAL)).toBeNull();
    expect(rig.sent).toEqual([]);
  });

  it("marks a skill Personal only when the host applied a skill of that name", async () => {
    listMock.skills = [skill("deploy")];
    // An MCP server called `deploy` applied; the skill of that name is not it.
    renderPage("providers", skillsPage(), {
      ...READY_HOST,
      applied: [
        itemStatusFixture({
          kind: "mcp_server",
          key: "deploy",
          appliedAs: { entryKind: "mcp", name: "deploy" },
        }),
      ],
    });

    const row = await skillRow("deploy");
    expect((await within(row).findByTestId(MARK)).textContent).toContain(
      `On ${HOST_NAME} only`,
    );
    expect(within(row).queryByTestId(PERSONAL)).toBeNull();
  });
});
