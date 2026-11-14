import "../../../../../__tests__/test-browser-apis";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useConfigurationMcpServersQuery } from "@/hooks/environment/team/use-mcp-servers";
import { useCanEditConfiguration } from "@/components/settings/environment/configuration-source";
import { PersonalPageFrame } from "@/components/settings/personal/personal-page-frame";
import type { EnvironmentPick } from "@/lib/settings-environment-pages";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { negotiateMethods } from "./mcp-skills-test-support";
import {
  mountTeamPage,
  requireTeamHostClient,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "./team-configuration-test-support";

// A team page reads its hosts from the host list; this window's own host
// scope has no hosts here.
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const WINDOW_HOST_SELECTION = {
    scopedHostId: null,
    setScopedHostId: () => undefined,
  };
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const scope = hostScopeFixture({ host: null });
  const useHostScope = () => scope;
  return { useHostScope, useHostScopeFor: useHostScope, WINDOW_HOST_SELECTION };
});
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
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null ? null : requireTeamHostClient(),
}));

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  resetNegotiatedManifests();
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

const acme: EnvironmentDescriptorV11 = {
  environmentId: "env-a",
  ownerKind: "organization",
  ownerId: "team-a",
  roomId: "room-a",
  label: "Acme",
  effectiveRole: "editor",
  kind: "team",
  hostCount: 1,
  providerHandle: "handle-a",
};

/** A page child that only reads Personal's servers, as the MCP servers page does. */
function PersonalMcpServerReader(): ReactNode {
  useConfigurationMcpServersQuery();
  return null;
}

/** Reads `config.env.list` the way the Shell panel's variables table does. */
function HostVariablesReader(): ReactNode {
  useHostQuery<HostRpcRegistry, "config.env.list">({
    cacheKeyIdentity: undefined,
    client: useHostClient(),
    method: "config.env.list",
    params: {},
    options: { enabled: true },
  });
  return null;
}

/** Whether the page may write, the way every cloud-read page decides it. */
function RoleProbe(): ReactNode {
  return (
    <p data-testid="role">
      {useCanEditConfiguration() ? "can edit" : "read only"}
    </p>
  );
}

/** A page's own read of the computer's shell, which no poll re-reads. */
function HostShellReader(): ReactNode {
  useHostQuery<HostRpcRegistry, "config.shell.get">({
    cacheKeyIdentity: undefined,
    client: useHostClient(),
    method: "config.shell.get",
    params: {},
    options: { enabled: true },
  });
  return null;
}

const personal: EnvironmentDescriptorV11 = {
  environmentId: "env-personal",
  ownerKind: "user",
  ownerId: "user-me",
  roomId: "room-personal",
  label: "Personal",
  effectiveRole: "owner",
  kind: "personal",
  hostCount: 1,
  providerHandle: null,
};

function mountFrame(
  pick: EnvironmentPick,
  handlers: Parameters<typeof mountTeamPage>[1],
  page: { readonly section: SettingsSectionId; readonly element: ReactNode },
): TeamPageHarness {
  act(() => {
    useSettingsEnvironmentPickStore.setState({ pick });
  });
  const harness = mountTeamPage({ kind: "host" }, handlers);
  harness.queryClient.setDefaultOptions({
    queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false },
    mutations: { retry: false },
  });
  render(
    <PersonalPageFrame section={page.section}>
      {page.element}
    </PersonalPageFrame>,
    { wrapper: harness.Wrapper },
  );
  return harness;
}

describe("a team page under PersonalPageFrame", () => {
  it("rereads the team's role with its items, so a demotion switches the page", async () => {
    const role: { current: EnvironmentDescriptorV11["effectiveRole"] } = {
      current: "editor",
    };
    const harness = mountFrame(
      { kind: "team", environmentId: "env-a" },
      {
        "environment.list": () => ({
          environments: [{ ...acme, effectiveRole: role.current }],
        }),
        "environment.host.list": () => ({ hosts: [] }),
      },
      { section: "mcp-servers", element: <RoleProbe /> },
    );
    expect((await screen.findByTestId("role")).textContent).toBe("can edit");
    const before = harness.paramsOf("environment.list").length;

    role.current = "viewer";
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => {
      expect(harness.paramsOf("environment.list").length).toBeGreaterThan(
        before,
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("role").textContent).toBe("read only");
    });
  });

  it("rereads Personal's MCP servers when the window regains focus, on a page the cloud always serves", async () => {
    negotiateMethods({
      "environment.configuration.mcpServers.list": { major: 1, minor: 0 },
    });
    const harness = mountFrame(
      { kind: "personal" },
      {
        "environment.list": () => ({ environments: [personal, acme] }),
        "environment.host.list": () => ({ hosts: [] }),
        "environment.configuration.mcpServers.list": () => ({ servers: [] }),
      },
      { section: "mcp-servers", element: <PersonalMcpServerReader /> },
    );
    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.mcpServers.list"),
      ).toEqual([{ environmentId: "env-personal" }]);
    });

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.mcpServers.list"),
      ).toHaveLength(2);
    });
  });

  it.each([
    { name: "a Local pick rereads", local: true, reads: 2 },
    { name: "a team pick does not reread", local: false, reads: 1 },
  ])(
    "the computer's own variables read on focus: $name",
    async ({ local, reads }) => {
      let served = 0;
      const harness = mountFrame(
        local
          ? {
              kind: "local",
              hostId: mockLocalHostEntry.hostId,
              hostName: "This Mac",
            }
          : { kind: "team", environmentId: "env-a" },
        {
          "environment.list": () => ({ environments: [personal, acme] }),
          "environment.host.list": () => ({ hosts: [] }),
          "config.env.list": () => {
            served += 1;
            return { entries: [] };
          },
        },
        { section: "secrets", element: <HostVariablesReader /> },
      );
      await waitFor(() => {
        expect(served).toBe(1);
      });

      act(() => {
        window.dispatchEvent(new Event("focus"));
      });

      await waitFor(() => {
        expect(served).toBe(reads);
      });
      expect(harness.paramsOf("config.env.list")).toHaveLength(reads);
    },
  );

  it("a Local pick rereads a read its page renders that no poll re-reads, beyond the delta-fed ones", async () => {
    let served = 0;
    mountFrame(
      {
        kind: "local",
        hostId: mockLocalHostEntry.hostId,
        hostName: "This Mac",
      },
      {
        "environment.list": () => ({ environments: [personal, acme] }),
        "environment.host.list": () => ({ hosts: [] }),
        "config.shell.get": () => {
          served += 1;
          return { path: "/bin/zsh", args: [], synthesised: false };
        },
      },
      { section: "secrets", element: <HostShellReader /> },
    );
    await waitFor(() => {
      expect(served).toBe(1);
    });

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => {
      expect(served).toBe(2);
    });
  });
});
