// Without the environments preview feature (read off, unread, or a record that
// carries no verdict) the Personal pages are the window host's own: the verdict
// is read through the real `usePreviewFeature` from what `useAuthUser` returns,
// and the host is a real client over a recording messenger whose negotiated
// manifest advertises no `environment.*` method, as a tip host with the
// verdict off does.
const authUser = vi.hoisted(
  (): { current: { readonly data: unknown } } => ({
    current: { data: undefined },
  }),
);
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({
    data: authUser.current.data,
    isPending: authUser.current.data === undefined,
    isError: false,
    isFetching: false,
    refetch: () => Promise.resolve({}),
  }),
}));
const scopeOverrides = vi.hoisted((): { current: Record<string, unknown> } => ({
  current: {},
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const useHostScope = () => hostScopeFixture(scopeOverrides.current);
  return { useHostScope, usePersonalHostScope: useHostScope };
});
const windowHost = vi.hoisted(
  (): { client: HostClient<HostRpcRegistry> | null } => ({ client: null }),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => {
      if (windowHost.client === null) throw new Error("no window host");
      return windowHost.client;
    },
    useHostBinding: () => ({ hostClient: windowHost.client }),
  };
});
vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => null,
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => windowHost.client,
}));
// The Providers rail reads a provider list this suite has no host method for;
// the tabs under test are the real bodies, only their leaf pages are named.
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({
    data: { providers: [providerFixture()] },
    isPending: false,
    isLoading: false,
    isError: false,
    error: null,
    refetch: () => Promise.resolve({}),
  }),
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [
      {
        hostId: "host-a",
        kind: "local",
        label: "dev-box",
        transportDialability: "dialable",
        websocketUrl: "ws://127.0.0.1:0",
      },
    ],
  }),
}));
// The guide editor reads and writes the host's guide; the panel above it, which
// owns the tabs under test, stays real.
vi.mock("@/components/settings/panels/agent-selection-guide-section", () => ({
  AgentSelectionGuideSection: () => <p>host selection guide</p>,
}));
vi.mock("@/components/settings/panels/provider-mcp-tab", () => ({
  ProviderMcpTab: () => <p>host MCP tab</p>,
}));
vi.mock("@/components/settings/panels/provider-skills-tab", () => ({
  ProviderSkillsTab: () => <p>host Skills tab</p>,
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  MockHostMessenger,
  type MockHandlerMap,
} from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import {
  PersonalPageFrame,
  PersonalPageHeaderStatus,
} from "@/components/settings/personal/personal-page-frame";
import { UPDATE_HOST_TEXT } from "@/components/settings/personal/personal-page-status";
import { AgentsSettingsPanel } from "@/components/settings/panels/agents-settings-panel";
import { ShellSettingsPanel } from "@/components/settings/panels/shell-settings-panel";
import {
  McpServersSettingsPanel,
  ProvidersSettingsPanel,
  SkillsSettingsPanel,
} from "@/components/settings/panels/providers-settings-panel";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { hostEntryFixture } from "@/lib/environment/__tests__/environment-test-support";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

const HOST_ID = "host-a";
/** A tip host with the verdict off: no `environment.*` method at all. */
const OLD_HOST_METHODS = [
  "providers.list",
  "config.shell.get",
  "config.shell.set",
  "config.shell.reset",
  "config.shell.add",
  "config.shell.remove",
  "config.shell.revertArgs",
  "config.shell.listDetected",
  "config.shell.probe",
  "config.env.list",
  "config.env.set",
  "config.env.delete",
];

function providerFixture(): ProviderCliState {
  return {
    providerId: "claude",
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    nativeCapabilities: {
      ...DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
      supportedTabs: ["general", "mcp", "skills"],
      mcp: {
        transports: ["stdio"],
        authTypes: ["none"],
        authActions: [],
        actionScopes: {
          list: ["global"],
          add: ["global"],
          update: ["global"],
          remove: ["global"],
          toggleServer: ["global"],
          toggleTool: ["global"],
          discover: ["global"],
          auth: [],
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
      },
      skills: {
        actionScopes: {
          list: ["global"],
          add: ["global"],
          create: ["global"],
          import: [],
          remove: ["global"],
        },
      },
    },
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles: [],
  };
}

/** A user record the way authn answers it today: no verdict field at all. */
const RECORD_WITHOUT_VERDICT = { userId: "user-me", email: "me@example.com" };
const RECORD_WITH_ENVIRONMENTS = {
  ...RECORD_WITHOUT_VERDICT,
  previewFeatures: { environments: true, sandboxes: false, bots: true },
};
const RECORD_WITH_ENVIRONMENTS_OFF = {
  ...RECORD_WITHOUT_VERDICT,
  previewFeatures: { environments: false, sandboxes: false, bots: false },
};

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  windowHost.client = null;
  authUser.current = { data: undefined };
  useAuthStore.setState({ status: "signed-out" });
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

interface Mounted {
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
  readonly environmentRequests: () => string[];
}

function mountSection(options: {
  readonly section: SettingsSectionId;
  readonly page: ReactNode;
  readonly user: unknown;
}): Mounted {
  authUser.current = { data: options.user };
  const handlers: MockHandlerMap<HostRpcRegistry> = {
    "config.shell.get": () => ({
      path: "/bin/zsh",
      args: [],
      synthesised: false,
    }),
    "config.shell.listDetected": () => ({ shells: [] }),
    "config.env.list": () => ({ entries: [] }),
  };
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-off",
    handlers,
  });
  const entry = hostEntryFixture(HOST_ID);
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) => (hostId === entry.hostId ? entry : null),
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(entry);
  windowHost.client = client;
  recordNegotiatedHostManifest(
    HOST_ID,
    Object.fromEntries(
      OLD_HOST_METHODS.map((method) => [method, { major: 1, minor: 0 }]),
    ),
  );
  scopeOverrides.current = {
    host: hostScopeOptionFixture({ hostId: HOST_ID, name: "dev-box" }),
    hostId: HOST_ID,
    status: "ready",
    client,
  };
  useAuthStore.setState({ status: "signed-in" });
  useSettingsEnvironmentPickStore.setState({ pick: { kind: "personal" } });
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <PersonalPageFrame section={options.section}>
          <PersonalPageHeaderStatus />
          {options.page}
        </PersonalPageFrame>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return {
    messenger,
    environmentRequests: () =>
      messenger.calls
        .map((call) => call.method)
        .filter((method) => method.startsWith("environment.")),
  };
}

function expectHostNativePage(): void {
  expect(screen.queryByText("Couldn't read these settings.")).toBeNull();
  expect(screen.queryByText(UPDATE_HOST_TEXT)).toBeNull();
  expect(document.querySelector("[inert]")).toBeNull();
  expect(screen.queryByTestId("personal-source-loading")).toBeNull();
  expect(screen.queryByTestId("personal-page-status")).toBeNull();
}

const OFF_READINGS = [
  { reading: "an unread user record", user: undefined },
  { reading: "a record without a verdict", user: RECORD_WITHOUT_VERDICT },
  { reading: "a record with environments off", user: RECORD_WITH_ENVIRONMENTS_OFF },
] as const;

describe("the Personal pages without environments", () => {
  describe.each(OFF_READINGS)("with $reading", ({ user }) => {
    it("shows the shell page from the host, with no chip, banner or read-only region", async () => {
      mountSection({
        section: "shell",
        page: <ShellSettingsPanel />,
        user,
      });

      expect(await screen.findByText("Startup flags for zsh")).toBeTruthy();
      expectHostNativePage();
    });

    it.each([
      { section: "providers" as const, page: <ProvidersSettingsPanel /> },
      { section: "mcp-servers" as const, page: <McpServersSettingsPanel /> },
      { section: "skills" as const, page: <SkillsSettingsPanel /> },
    ])("renders the $section page from the host", async ({ section, page }) => {
      mountSection({ section, page, user });

      await waitFor(() => {
        expect(screen.getAllByRole("heading").length).toBeGreaterThan(0);
      });
      expectHostNativePage();
    });

    it.each([
      { section: "shell" as const, page: <ShellSettingsPanel />, ready: "Startup flags for zsh" },
      { section: "providers" as const, page: <ProvidersSettingsPanel />, ready: "Providers" },
      { section: "mcp-servers" as const, page: <McpServersSettingsPanel />, ready: "host MCP tab" },
      { section: "skills" as const, page: <SkillsSettingsPanel />, ready: "host Skills tab" },
      { section: "agents" as const, page: <AgentsSettingsPanel />, ready: "host selection guide" },
    ])("sends no environment request from the $section page", async ({ section, page, ready }) => {
      const mounted = mountSection({ section, page, user });

      expect((await screen.findAllByText(ready)).length).toBeGreaterThan(0);
      expect(mounted.environmentRequests()).toEqual([]);
    });

    it.each([
      {
        section: "shell" as const,
        page: <ShellSettingsPanel />,
        copy: [
          "How Traycer launches terminals, the host, and provider harnesses. New terminals pick up shell changes immediately; variable changes apply on restart.",
          "Variables are plain values every host gets.",
        ],
      },
      {
        section: "providers" as const,
        page: <ProvidersSettingsPanel />,
        copy: ["Sign-ins, keys and tools for each coding agent on this host."],
      },
      {
        section: "mcp-servers" as const,
        page: <McpServersSettingsPanel />,
        copy: ["The MCP servers each coding agent can use on this host."],
      },
      {
        section: "skills" as const,
        page: <SkillsSettingsPanel />,
        copy: ["The skills each coding agent can use on this host."],
      },
    ])("speaks for this host only on the $section page", async ({ section, page, copy }) => {
      mountSection({ section, page, user });

      for (const text of copy) {
        expect(await screen.findByText(text)).toBeTruthy();
      }
      expect(screen.queryByText(/every computer and sandbox/)).toBeNull();
      expect(screen.queryByText(/running Personal/)).toBeNull();
    });

    it("shows the Agents page as the selection guide alone, with no Definitions tab or read", async () => {
      const mounted = mountSection({
        section: "agents",
        page: <AgentsSettingsPanel />,
        user,
      });

      expect(await screen.findByText("host selection guide")).toBeTruthy();
      expect(screen.getByTestId("agents-guide-caption")).toBeTruthy();
      expect(screen.queryByTestId("agents-tab-definitions")).toBeNull();
      expect(screen.queryByText("Couldn't read these agent definitions.")).toBeNull();
      expectHostNativePage();
      expect(mounted.messenger.calls.map((call) => call.method)).not.toContain(
        "environment.agentDefinitions.list",
      );
    });

    it.each([
      { section: "mcp-servers" as const, page: <McpServersSettingsPanel />, tab: "host MCP tab" },
      { section: "skills" as const, page: <SkillsSettingsPanel />, tab: "host Skills tab" },
    ])("takes the host tab for the $section tab body, not the cloud boundary", async ({ section, page, tab }) => {
      mountSection({ section, page, user });

      expect(await screen.findByText(tab)).toBeTruthy();
      expect(screen.queryByText("Couldn't read these settings.")).toBeNull();
    });
  });

  it("reaches the cloud path with environments on, over the same old host", async () => {
    mountSection({
      section: "mcp-servers",
      page: <McpServersSettingsPanel />,
      user: RECORD_WITH_ENVIRONMENTS,
    });

    expect(await screen.findByText("Couldn't read these settings.")).toBeTruthy();
    expect(screen.queryByText("host MCP tab")).toBeNull();
  });

  it("shows both Agents tabs with environments on", async () => {
    // A non-environment section keeps the cloud frame out of the way, so the
    // panel's own verdict is what is read.
    mountSection({
      section: "general",
      page: <AgentsSettingsPanel />,
      user: RECORD_WITH_ENVIRONMENTS,
    });

    expect(await screen.findByTestId("agents-tab-guide")).toBeTruthy();
    expect(screen.getByTestId("agents-tab-definitions")).toBeTruthy();
  });

  it.each([
    {
      page: <ShellSettingsPanel />,
      copy: [
        "Plain values every computer and sandbox running Personal gets, and the shell agents run in.",
        "Variables are plain values every computer and sandbox running Personal gets.",
      ],
    },
    {
      page: <ProvidersSettingsPanel />,
      copy: [
        "Sign-ins, keys and tools for each coding agent, on every computer and sandbox running Personal.",
      ],
    },
  ])("keeps the Personal sentences with environments on", async ({ page, copy }) => {
    // A non-environment section keeps the cloud frame out of the way, so the
    // panel's own verdict is what is read.
    mountSection({ section: "general", page, user: RECORD_WITH_ENVIRONMENTS });

    for (const text of copy) {
      expect(await screen.findByText(text)).toBeTruthy();
    }
  });
});
