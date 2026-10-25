import "../../../../../__tests__/test-browser-apis";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import type { EnvironmentConfigurationItem } from "@traycer/protocol/host/environment/configuration-contracts";
import { useConfigurationMcpServersQuery } from "@/hooks/environment/team/use-mcp-servers";
import { TeamMcpServers } from "@/components/settings/environment/team-mcp-servers";
import { PersonalPageFrame } from "@/components/settings/personal/personal-page-frame";
import type { EnvironmentPick } from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { negotiateMethods } from "./mcp-skills-test-support";
import {
  configurationItem,
  mountTeamPage,
  requireTeamHostClient,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "./team-configuration-test-support";

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

const server = (revision: number): EnvironmentConfigurationItem =>
  configurationItem({
    kind: "mcp_server",
    key: "github",
    value: {
      mcpServerId: "srv-1",
      toolToggles: { claude: { search: true } },
    },
    revision,
  });

/** A page child that only reads Personal's servers, as the MCP servers page does. */
function PersonalMcpServerReader(): ReactNode {
  useConfigurationMcpServersQuery();
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

/** The app's `refetchOnWindowFocus: false`, which the bare test client lacks. */
function mountTeamFrame(
  handlers: Parameters<typeof mountTeamPage>[1],
): TeamPageHarness {
  return mountFrame(
    { kind: "team", environmentId: "env-a" },
    handlers,
    <TeamMcpServers />,
  );
}

function mountFrame(
  pick: EnvironmentPick,
  handlers: Parameters<typeof mountTeamPage>[1],
  page: ReactNode,
): TeamPageHarness {
  act(() => {
    useSettingsEnvironmentPickStore.setState({ pick });
  });
  const harness = mountTeamPage({ kind: "host" }, handlers);
  harness.queryClient.setDefaultOptions({
    queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false },
    mutations: { retry: false },
  });
  render(<PersonalPageFrame section="mcp-servers">{page}</PersonalPageFrame>, {
    wrapper: harness.Wrapper,
  });
  return harness;
}

describe("a team page under PersonalPageFrame", () => {
  it("rereads after a save refused as stale, and the retry sends the fresh revision", async () => {
    let current = server(4);
    let puts = 0;
    const harness = mountTeamFrame({
      "environment.list": () => ({ environments: [acme] }),
      "environment.host.list": () => ({ hosts: [] }),
      "environment.configuration.items": () => ({ items: [current] }),
      "environment.configuration.items.put": () => {
        puts += 1;
        if (puts === 1) {
          // Someone else saved first; the read now answers their revision.
          current = server(5);
          throw HostRpcError.fromWireEnvelope(
            {
              code: "ENVIRONMENT_WRITE_STALE",
              message: "The setting changed since it was read.",
              staleWrite: {
                changedBy: { kind: "dashboard" },
                currentRevision: 5,
              },
            },
            "req-stale",
            "environment.configuration.items.put",
          );
        }
        return { outcome: "saved", revision: 6 };
      },
    });

    const toggle = await screen.findByRole("switch", {
      name: "github claude search",
    });
    await userEvent.click(toggle);
    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items.put"),
      ).toHaveLength(1);
    });
    // The refusal must reread the page's items, not leave revision 4 shown.
    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items").length,
      ).toBeGreaterThan(1);
    });

    await userEvent.click(
      await screen.findByRole("switch", { name: "github claude search" }),
    );
    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items.put"),
      ).toHaveLength(2);
    });
    expect(
      harness.paramsOf("environment.configuration.items.put")[1],
    ).toMatchObject({ revision: 5 });
  });

  it("rereads the team's items when the window regains focus", async () => {
    const harness = mountTeamFrame({
      "environment.list": () => ({ environments: [acme] }),
      "environment.host.list": () => ({ hosts: [] }),
      "environment.configuration.items": () => ({ items: [server(4)] }),
    });
    await screen.findByRole("switch", { name: "github claude search" });
    const before = harness.paramsOf("environment.configuration.items").length;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items").length,
      ).toBeGreaterThan(before);
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
      <PersonalMcpServerReader />,
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
});
