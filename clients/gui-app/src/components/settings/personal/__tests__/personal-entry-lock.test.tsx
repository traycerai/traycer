// A Personal MCP server or skill is one of the person's settings: the host
// forwards only Remove and an MCP server's tool switches for it, and refuses
// the rest with "Change this in the dashboard." The rows say so up front and
// hold those controls off. Rendered inside a real Personal page frame over a
// fake host whose `environment.status` carries the items with `appliedAs`.

// The Personal pages read through the window's own host. Mocked at the scope
// boundary, as the other Personal suites do.
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
// an in-memory messenger: only the host on the far side is faked. The MCP and
// skills mutation hooks are NOT mocked, so a click that sends a request shows
// up as `providers.nativeMutate` at the host.
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

// Which scope the MCP and Skills tabs draw.
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

// What each provider's native lists answer, and what SKILL.md holds.
const listMock = vi.hoisted(
  (): {
    servers: ProviderMcpServer[];
    skills: ProviderSkill[];
    skillFile: string | null;
  } => ({ servers: [], skills: [], skillFile: null }),
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
vi.mock("@/hooks/workspace/use-read-file-query", () => ({
  useWorkspaceReadFile: () => ({
    data:
      listMock.skillFile === null
        ? undefined
        : { content: listMock.skillFile, truncated: false, error: null },
    isPending: false,
    isError: false,
    error: null,
  }),
}));

// Not under test: discover and sign-in, links, credential refusal.
vi.mock("@/hooks/providers/use-providers-mcp-discover-mutation", () => ({
  useProvidersMcpDiscover: () => ({
    mutate: () => undefined,
    isPending: false,
  }),
}));
vi.mock("@/hooks/providers/use-providers-mcp-auth-mutation", () => ({
  useProvidersMcpAuth: () => ({ mutate: () => undefined, isPending: false }),
}));
vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => null,
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => () => undefined,
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
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { RequestOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { EnvironmentItemStatus } from "@traycer/protocol/host/environment-schemas";
import type {
  ProviderMcpCapabilities,
  ProviderMcpServer,
  ProviderMcpTool,
  ProviderSkill,
} from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { ProviderMcpTab } from "@/components/settings/panels/provider-mcp-tab";
import { ProviderSkillsTab } from "@/components/settings/panels/provider-skills-tab";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { PersonalPageFrame } from "@/components/settings/personal/personal-page-frame";
import { PERSONAL_ENTRY_LOCKED_TEXT } from "@/components/settings/personal/personal-page-context";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
  itemStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import type { SettingsSectionId } from "@/lib/settings-sections";

// These cases are about the environments-on behaviour.
vi.mock("@/hooks/auth/use-preview-feature", () => ({
  usePreviewFeature: () => "on" as const,
}));

const HOST_ID = "host-a";
const HOST_NAME = "dev-box";
const LOCKED_TESTID = "mcp-server-toggle-locked";
const SKILL_NOTE = "skill-detail-locked-note";

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
  listMock.skillFile = null;
});

const MCP_CAPS: ProviderMcpCapabilities = {
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

function tool(name: string): ProviderMcpTool {
  return {
    name,
    description: null,
    inputSchema: null,
    enabled: true,
    readOnly: false,
    denySources: [],
  };
}

function mcpServer(name: string): ProviderMcpServer {
  return {
    name,
    enabled: true,
    transport: { type: "http", url: `https://${name}.invalid/mcp`, auth: null },
    status: "connected",
    statusSource: "probe",
    statusDetail: null,
    tools: [tool("search")],
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
    origin: "owner/repo",
  };
}

function skillMarkdown(name: string): string {
  return `---\nname: ${name}\ndescription: "${name} skill"\n---\n\n# When to use\n\nAsk for it.\n`;
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
          remove: ["global", "project"],
          edit: ["global", "project"],
          update: ["global", "project"],
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

interface Rig {
  /** Every `providers.nativeMutate` the host was sent, in order. */
  readonly sent: NativeMutateRequest[];
}

/** Applied items that are the person's own MCP servers / skills. */
function appliedMcp(name: string): EnvironmentItemStatus {
  return itemStatusFixture({
    kind: "mcp_server",
    key: name,
    appliedAs: { entryKind: "mcp", name },
  });
}

function appliedSkill(name: string): EnvironmentItemStatus {
  return itemStatusFixture({
    kind: "skill",
    key: name,
    appliedAs: { entryKind: "skills", name },
  });
}

/**
 * Renders `page` inside a real Personal frame over a fake host whose status
 * carries `applied` as the person's items. The host answers every
 * `providers.nativeMutate` with an empty list of the right kind and records it.
 */
function renderPage(
  section: SettingsSectionId,
  page: ReactNode,
  applied: readonly EnvironmentItemStatus[],
): Rig {
  const rig: Rig = { sent: [] };
  const handlers: MockHandlerMap<HostRpcRegistry> = {
    "environment.status": () =>
      environmentStatusFixture({ items: [...applied] }),
    "environment.localOverrides": () => ({ overrides: [] }),
    "providers.nativeMutate": (request) => {
      rig.sent.push(request);
      return Promise.resolve({
        result:
          request.mutation.kind === "skills"
            ? { ok: true, kind: "skills", skills: [] }
            : { ok: true, kind: "mcp", servers: [] },
      });
    },
  };
  const { client } = buildEnvironmentClient({ hostId: HOST_ID, handlers });
  recordNegotiatedHostManifest(HOST_ID, {
    "environment.status": { major: 1, minor: 1 },
    "environment.localOverrides": { major: 1, minor: 0 },
    "providers.nativeMutate": { major: 1, minor: 1 },
  });
  hostMock.client = client;
  hostMock.binding = null;
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
      capabilities={MCP_CAPS}
      providerLabel="Claude Code"
      cliBinaryResolved
    />
  );
}

function skillsPage(): ReactNode {
  return <ProviderSkillsTab state={skillsState()} />;
}

/** The MCP row for `name`: the list item around its expand button. */
async function mcpRow(name: string): Promise<HTMLElement> {
  const row = (
    await screen.findByRole("button", { name: `Expand ${name}` })
  ).closest("li");
  if (row === null) throw new Error(`no row for ${name}`);
  return row;
}

/**
 * Lets everything a NEGATIVE assertion depends on happen first. `waitFor`
 * cannot carry one: it passes on its first check.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  });
}

/** Waits for the page to have read the status, so a mark or lock is decided. */
async function statusRead(): Promise<void> {
  await settle();
}

describe("A Personal MCP server row", () => {
  it("holds the server switch off with the sentence, and sends nothing when it is clicked", async () => {
    listMock.servers = [mcpServer("github")];
    const rig = renderPage("providers", mcpPage(), [appliedMcp("github")]);

    const row = await mcpRow("github");
    const locked = await within(row).findByTestId(LOCKED_TESTID);
    expect(PERSONAL_ENTRY_LOCKED_TEXT).toBe("Change this in the dashboard.");
    const toggle = within(locked).getByRole("switch", {
      name: "github: Change this in the dashboard.",
    });
    expect(toggle.hasAttribute("disabled")).toBe(true);
    // It still shows the server's state.
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    // The live switch is gone: nothing else toggles the server.
    expect(
      within(row).queryByRole("switch", { name: "Disable github" }),
    ).toBeNull();

    fireEvent.click(toggle);
    await settle();
    expect(rig.sent).toEqual([]);
  });

  it("says the sentence in a tooltip on the held switch", async () => {
    listMock.servers = [mcpServer("github")];
    renderPage("providers", mcpPage(), [appliedMcp("github")]);

    const locked = await within(await mcpRow("github")).findByTestId(
      LOCKED_TESTID,
    );
    const user = userEvent.setup();
    await user.hover(locked);

    const tooltip = await screen.findByRole("tooltip", undefined, {
      timeout: 3000,
    });
    expect(tooltip.textContent).toContain("Change this in the dashboard.");
  });

  it("still toggles a tool, with a request for exactly that tool", async () => {
    listMock.servers = [mcpServer("github")];
    const rig = renderPage("providers", mcpPage(), [appliedMcp("github")]);

    const row = await mcpRow("github");
    await within(row).findByTestId(LOCKED_TESTID);
    fireEvent.click(screen.getByRole("button", { name: "Expand github" }));
    fireEvent.click(
      await within(row).findByRole("button", { name: "Disable tool search" }),
    );

    await waitFor(() => {
      expect(rig.sent).toHaveLength(1);
    });
    expect(rig.sent[0]).toMatchObject({
      providerId: "claude-code",
      mutation: {
        kind: "mcp",
        scope: "global",
        workspaceRoot: null,
        mutation: {
          action: "toggleTool",
          serverName: "github",
          toolName: "search",
          enabled: false,
        },
      },
    });
  });

  it("still reaches the remove confirmation, and Remove sends the remove request", async () => {
    listMock.servers = [mcpServer("github")];
    const rig = renderPage("providers", mcpPage(), [appliedMcp("github")]);

    const row = await mcpRow("github");
    await within(row).findByTestId(LOCKED_TESTID);
    fireEvent.click(within(row).getByRole("button", { name: "Delete github" }));

    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(rig.sent).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(rig.sent).toHaveLength(1);
    });
    expect(rig.sent[0]).toMatchObject({
      mutation: {
        kind: "mcp",
        scope: "global",
        mutation: { action: "remove", name: "github" },
      },
    });
  });

  it("the remove confirmation names every provider on every host", async () => {
    listMock.servers = [mcpServer("github")];
    renderPage("providers", mcpPage(), [appliedMcp("github")]);

    const row = await mcpRow("github");
    await within(row).findByTestId(LOCKED_TESTID);
    fireEvent.click(within(row).getByRole("button", { name: "Delete github" }));

    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(dialog.textContent).toContain(
      "Remove “github” from every provider on every host?",
    );
    expect(dialog.textContent).not.toContain("this provider's");
  });
});

describe("A local MCP server row", () => {
  it("keeps a live server switch that sends toggleServer", async () => {
    listMock.servers = [mcpServer("linear")];
    // The host applied the person's `github`; `linear` is only on this host.
    const rig = renderPage("providers", mcpPage(), [appliedMcp("github")]);

    const row = await mcpRow("linear");
    const toggle = await within(row).findByRole("switch", {
      name: "Disable linear",
    });
    expect(toggle.hasAttribute("disabled")).toBe(false);
    expect(within(row).queryByTestId(LOCKED_TESTID)).toBeNull();

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(rig.sent).toHaveLength(1);
    });
    expect(rig.sent[0]).toMatchObject({
      mutation: {
        kind: "mcp",
        scope: "global",
        mutation: { action: "toggleServer", name: "linear", enabled: false },
      },
    });
  });

  it("the remove confirmation keeps this provider's config", async () => {
    listMock.servers = [mcpServer("linear")];
    renderPage("providers", mcpPage(), [appliedMcp("github")]);

    const row = await mcpRow("linear");
    await within(row).findByRole("switch", { name: "Disable linear" });
    fireEvent.click(within(row).getByRole("button", { name: "Delete linear" }));

    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(dialog.textContent).toContain(
      "Remove “linear” from this provider's global config?",
    );
  });

  it("is not held off by a skill of the same name", async () => {
    listMock.servers = [mcpServer("deploy")];
    renderPage("providers", mcpPage(), [appliedSkill("deploy")]);

    const row = await mcpRow("deploy");
    await statusRead();
    expect(
      within(row).getByRole("switch", { name: "Disable deploy" }),
    ).toBeTruthy();
    expect(within(row).queryByTestId(LOCKED_TESTID)).toBeNull();
  });

  it("is not held off when the host applied none of the person's items", async () => {
    listMock.servers = [mcpServer("github")];
    const rig = renderPage("providers", mcpPage(), []);

    const row = await mcpRow("github");
    await statusRead();
    expect(within(row).queryByTestId(LOCKED_TESTID)).toBeNull();
    fireEvent.click(
      within(row).getByRole("switch", { name: "Disable github" }),
    );
    await waitFor(() => {
      expect(rig.sent).toHaveLength(1);
    });
  });
});

describe("A project-scope MCP server with a Personal server's name", () => {
  it("is not locked, because Personal settings are global", async () => {
    scopeMock.scope = "project";
    listMock.servers = [mcpServer("github")];
    const rig = renderPage("providers", mcpPage(), [appliedMcp("github")]);

    const row = await mcpRow("github");
    await statusRead();
    expect(within(row).queryByTestId(LOCKED_TESTID)).toBeNull();
    const toggle = within(row).getByRole("switch", { name: "Disable github" });
    expect(toggle.hasAttribute("disabled")).toBe(false);

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(rig.sent).toHaveLength(1);
    });
    expect(rig.sent[0]).toMatchObject({
      mutation: {
        kind: "mcp",
        scope: "project",
        workspaceRoot: "/repo",
        mutation: { action: "toggleServer", name: "github", enabled: false },
      },
    });
  });
});

describe("A Personal skill", () => {
  it("opens with the sentence, no edit or update control, and Remove still offered", async () => {
    listMock.skills = [skill("deploy")];
    // SKILL.md is readable and the origin is known, so a local skill WOULD be
    // editable and updatable here: their absence is the lock's doing.
    listMock.skillFile = skillMarkdown("deploy");
    const rig = renderPage("providers", skillsPage(), [appliedSkill("deploy")]);

    fireEvent.click(
      await screen.findByRole("button", { name: /^Open deploy / }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId(SKILL_NOTE).textContent).toBe(
      "Change this in the dashboard.",
    );
    expect(within(dialog).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(
      within(dialog).queryByRole("button", { name: "Update from source" }),
    ).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(rig.sent).toEqual([]);
  });

  it("Remove still reaches the confirmation and sends the remove request", async () => {
    listMock.skills = [skill("deploy")];
    listMock.skillFile = skillMarkdown("deploy");
    const rig = renderPage("providers", skillsPage(), [appliedSkill("deploy")]);

    fireEvent.click(
      await screen.findByRole("button", { name: /^Open deploy / }),
    );
    const skillDialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(skillDialog).getByRole("button", { name: "Remove" }),
    );

    const confirm = await screen.findByTestId("confirm-destructive-dialog");
    expect(rig.sent).toEqual([]);
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(rig.sent).toHaveLength(1);
    });
    expect(rig.sent[0]).toMatchObject({
      mutation: {
        kind: "skills",
        scope: "global",
        mutation: { action: "remove" },
      },
    });
  });

  it("the remove confirmation names every provider on every host", async () => {
    listMock.skills = [skill("deploy")];
    listMock.skillFile = skillMarkdown("deploy");
    renderPage("providers", skillsPage(), [appliedSkill("deploy")]);

    fireEvent.click(
      await screen.findByRole("button", { name: /^Open deploy / }),
    );
    const skillDialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(skillDialog).getByRole("button", { name: "Remove" }),
    );

    const confirm = await screen.findByTestId("confirm-destructive-dialog");
    expect(confirm.textContent).toContain(
      "Remove “deploy” from every provider on every host?",
    );
    expect(confirm.textContent).not.toContain("from disk");
  });
});

describe("A local skill", () => {
  it("opens with Edit and Update from source where advertised, and no note", async () => {
    listMock.skills = [skill("deploy")];
    listMock.skillFile = skillMarkdown("deploy");
    // The host applied a DIFFERENT skill of the person's.
    renderPage("providers", skillsPage(), [appliedSkill("other")]);

    fireEvent.click(
      await screen.findByRole("button", { name: /^Open deploy / }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByRole("button", { name: "Edit" }),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Update from source" }),
    ).toBeTruthy();
    expect(within(dialog).queryByTestId(SKILL_NOTE)).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  it("is not locked by an MCP server of the same name", async () => {
    listMock.skills = [skill("deploy")];
    listMock.skillFile = skillMarkdown("deploy");
    renderPage("providers", skillsPage(), [appliedMcp("deploy")]);

    fireEvent.click(
      await screen.findByRole("button", { name: /^Open deploy / }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByRole("button", { name: "Edit" }),
    ).toBeTruthy();
    expect(within(dialog).queryByTestId(SKILL_NOTE)).toBeNull();
  });

  it("the remove confirmation keeps the disk text", async () => {
    listMock.skills = [skill("deploy")];
    listMock.skillFile = skillMarkdown("deploy");
    renderPage("providers", skillsPage(), [appliedSkill("other")]);

    fireEvent.click(
      await screen.findByRole("button", { name: /^Open deploy / }),
    );
    const skillDialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(skillDialog).getByRole("button", { name: "Remove" }),
    );

    const confirm = await screen.findByTestId("confirm-destructive-dialog");
    expect(confirm.textContent).toContain("Delete “deploy” from disk?");
  });
});
