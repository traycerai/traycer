// Which source a Personal-group page reads is `PersonalPageFrame`'s rule, one
// per pick. The page is the real Variables page; the window's host is a real
// client over a recording messenger, so the reads it sends are what is asserted.
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
// The configuration status chip reads the host runtime this suite does not mount.
vi.mock("@/components/settings/personal/page-chip", () => ({
  PageChip: () => null,
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  MockHostMessenger,
  type MockHandlerMap,
} from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { PersonalPageFrame } from "@/components/settings/personal/personal-page-frame";
import { ShellSettingsPanel } from "@/components/settings/panels/shell-settings-panel";
import { EnvironmentMcpServersPage } from "@/components/settings/environment/environment-mcp-servers";
import { EnvironmentSkillsPage } from "@/components/settings/environment/environment-skills";
import type { SettingsSectionId } from "@/lib/settings-sections";
import {
  environmentStatusFixture,
  hostEntryFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import type { EnvironmentPick } from "@/lib/settings-environment-pages";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

// These cases are about the environments-on behaviour.
vi.mock("@/hooks/auth/use-preview-feature", () => ({
  usePreviewFeature: () => "on" as const,
}));

const HOST_ID = "host-a";
/** The window host's scope status; a case sets it before it mounts. */
let windowScopeStatus: "ready" | "unreachable" | "vanished" = "ready";
const WINDOW_METHODS = [
  "environment.status",
  "environment.configuration.mcpServers.list",
  "environment.configuration.skills.list",
  "environment.localOverrides",
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

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  windowScopeStatus = "ready";
  windowHost.client = null;
  useAuthStore.setState({ status: "signed-out" });
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

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
    {
      environmentId: "env-team",
      ownerKind: "organization" as const,
      ownerId: "team-a",
      roomId: "room-team",
      label: "Acme",
      effectiveRole: "admin" as const,
      kind: "team" as const,
      hostCount: 1,
      providerHandle: "handle-a",
    },
  ],
};

const HOST_READS = ["config.shell.get", "environment.localOverrides"];

interface Mounted {
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
  readonly sent: (method: string) => unknown[];
}

function mountPage(options: {
  readonly pick: EnvironmentPick;
  readonly methods: readonly string[] | null;
  readonly status: () =>
    EnvironmentStatusResponseV11 | Promise<EnvironmentStatusResponseV11>;
}): Mounted {
  return mountSection({
    ...options,
    section: "shell",
    page: <ShellSettingsPanel />,
  });
}

function mountSection(options: {
  readonly section: SettingsSectionId;
  readonly page: ReactNode;
  readonly pick: EnvironmentPick;
  /** `null` records nothing: no handshake has completed yet. */
  readonly methods: readonly string[] | null;
  readonly status: () =>
    EnvironmentStatusResponseV11 | Promise<EnvironmentStatusResponseV11>;
}): Mounted {
  const handlers: MockHandlerMap<HostRpcRegistry> = {
    "environment.status": options.status,
    "environment.localOverrides": () => ({ overrides: [] }),
    "environment.list": () => environments,
    "environment.configuration.items": () => ({ items: [] }),
    "environment.configuration.mcpServers.list": () => ({ servers: [] }),
    "environment.configuration.skills.list": () => ({
      outcome: "listed" as const,
      revision: null,
      skills: [],
    }),
    "environment.host.list": () => ({ hosts: [] }),
    "environment.members": () => ({
      members: [],
      nextCursor: null,
      legacyRoleNoticeSeenAt: null,
      legacyMembers: [],
    }),
  };
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-source",
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
  if (options.methods !== null) {
    recordNegotiatedHostManifest(
      HOST_ID,
      Object.fromEntries(
        options.methods.map((method) => [
          method,
          { major: 1, minor: method === "environment.status" ? 1 : 0 },
        ]),
      ),
    );
  }
  scopeOverrides.current = {
    host: hostScopeOptionFixture({ hostId: HOST_ID, name: "dev-box" }),
    hostId: HOST_ID,
    status: windowScopeStatus,
    client,
  };
  useAuthStore.setState({ status: "signed-in" });
  useSettingsEnvironmentPickStore.setState({ pick: options.pick });
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
          {options.page}
        </PersonalPageFrame>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return {
    messenger,
    sent: (method) =>
      messenger.calls
        .filter((call) => call.method === method)
        .map((call) => call.params),
  };
}

function expectNoHostReads(mounted: Mounted): void {
  for (const method of HOST_READS) {
    expect(mounted.sent(method)).toHaveLength(0);
  }
}

describe("PersonalPageFrame's source, one per pick", () => {
  it("reads a team pick from the cloud by the team's environment id, never the host's pages", async () => {
    const mounted = mountPage({
      pick: { kind: "team", environmentId: "env-team" },
      methods: WINDOW_METHODS,
      status: () => environmentStatusFixture({}),
    });

    await waitFor(() => {
      expect(mounted.sent("environment.configuration.items")).toEqual([
        { environmentId: "env-team" },
      ]);
    });
    expectNoHostReads(mounted);
  });

  it("reads Personal from the cloud by Personal's environment id when the window's host does not run it", async () => {
    const mounted = mountPage({
      pick: { kind: "personal" },
      methods: WINDOW_METHODS,
      status: () => environmentStatusFixture({ principal: null }),
    });

    await waitFor(() => {
      expect(mounted.sent("environment.configuration.items")).toEqual([
        { environmentId: "env-personal" },
      ]);
    });
    expect(
      screen.getByText(
        "Plain values every computer and sandbox running Personal gets, and the shell agents run in.",
      ),
    ).toBeTruthy();
    expectNoHostReads(mounted);
  });

  it("reads a Local row from that computer's own pages and sends no cloud configuration read", async () => {
    const mounted = mountPage({
      pick: { kind: "local", hostId: HOST_ID, hostName: "dev-box" },
      methods: WINDOW_METHODS,
      status: () => environmentStatusFixture({}),
    });

    await waitFor(() => {
      expect(mounted.sent("config.shell.get").length).toBeGreaterThan(0);
    });
    expect(mounted.sent("environment.configuration.items")).toHaveLength(0);
  });

  it("keeps the host's pages for Personal when the window's host runs Personal", async () => {
    const mounted = mountPage({
      pick: { kind: "personal" },
      methods: WINDOW_METHODS,
      status: () =>
        environmentStatusFixture({ principal: { kind: "personal" } }),
    });

    await waitFor(() => {
      expect(mounted.sent("config.shell.get").length).toBeGreaterThan(0);
    });
    expect(mounted.sent("environment.configuration.items")).toHaveLength(0);
  });

  it("shows a spinner and sends neither source's reads until the host's status answers, then mounts the right one", async () => {
    let answer: (status: EnvironmentStatusResponseV11) => void = () =>
      undefined;
    const mounted = mountPage({
      pick: { kind: "personal" },
      methods: WINDOW_METHODS,
      status: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });

    await waitFor(() => {
      expect(mounted.sent("environment.status").length).toBeGreaterThan(0);
    });
    expect(screen.getByTestId("personal-source-loading")).toBeTruthy();
    expectNoHostReads(mounted);
    expect(mounted.sent("environment.configuration.items")).toHaveLength(0);

    act(() => {
      answer(environmentStatusFixture({ principal: null }));
    });

    await waitFor(() => {
      expect(mounted.sent("environment.configuration.items")).toEqual([
        { environmentId: "env-personal" },
      ]);
    });
    expect(screen.queryByTestId("personal-source-loading")).toBeNull();
    expectNoHostReads(mounted);
  });

  it("shows the spinner and reads nothing before the window's host has handshaked", () => {
    const mounted = mountPage({
      pick: { kind: "personal" },
      methods: null,
      status: () => environmentStatusFixture({}),
    });

    expect(screen.getByTestId("personal-source-loading")).toBeTruthy();
    expectNoHostReads(mounted);
    expect(mounted.sent("environment.configuration.items")).toHaveLength(0);
  });

  it.each(["unreachable", "vanished"] as const)(
    "reads Personal from the cloud, not a spinner, when the window's host is %s",
    async (status) => {
      windowScopeStatus = status;
      const mounted = mountPage({
        pick: { kind: "personal" },
        methods: null,
        status: () => environmentStatusFixture({ principal: null }),
      });

      await waitFor(() => {
        expect(mounted.sent("environment.configuration.items")).toEqual([
          { environmentId: "env-personal" },
        ]);
      });
      expect(screen.queryByTestId("personal-source-loading")).toBeNull();
      expectNoHostReads(mounted);
    },
  );

  it.each([
    { section: "mcp-servers" as const, page: <EnvironmentMcpServersPage /> },
    { section: "skills" as const, page: <EnvironmentSkillsPage /> },
  ])(
    "reads the $section page from the cloud for Personal even when the window's host runs Personal",
    async ({ section, page }) => {
      const mounted = mountSection({
        section,
        page,
        pick: { kind: "personal" },
        methods: WINDOW_METHODS,
        status: () =>
          environmentStatusFixture({ principal: { kind: "personal" } }),
      });

      await waitFor(() => {
        expect(mounted.sent("environment.list").length).toBeGreaterThan(0);
      });
      expect(screen.queryByTestId("personal-source-loading")).toBeNull();
      expectNoHostReads(mounted);
      // MCP servers lists the configuration; Skills looks for its viewing host.
      const read =
        section === "mcp-servers"
          ? "environment.configuration.mcpServers.list"
          : "environment.host.list";
      await waitFor(() => {
        expect(mounted.sent(read)).toEqual([{ environmentId: "env-personal" }]);
      });
    },
  );
});
