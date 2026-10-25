import "../../../../../__tests__/test-browser-apis";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { settleProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { EnvironmentMcpServersPage } from "@/components/settings/environment/environment-mcp-servers";
import { EnvironmentSkillsPage } from "@/components/settings/environment/environment-skills";
import {
  declaredServer,
  negotiateMethodsOn,
  reachableHost,
  teamEnvironments,
} from "./mcp-skills-test-support";
import {
  hostIdsOf,
  mountTeamPageOnPoolBuild,
  poolSource,
  requireTeamHostClient,
  requireViewingHostClient,
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
    hostId: mockLocalHostEntry.hostId,
    hostClient: requireTeamHostClient(),
  }),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));
// The viewing host is a second host, so a request's recorded host says which
// client sent it.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null ? null : requireViewingHostClient(),
}));

// The tier plan is frozen per process from the build; this file's build has a pool.
beforeAll(() => {
  settleProcessHostRpcTierPlan(poolEntry);
});

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  resetNegotiatedManifests();
});

const VIEWING_HOST = { ...reachableHost, hostId: "mock-remote" };
const V10 = { major: 1, minor: 0 };

const handlers = {
  "environment.configuration.mcpServers.list": () => ({
    servers: [declaredServer({ serverId: "srv-1", name: "github" })],
  }),
  "environment.configuration.mcpServers.delete": () => ({
    outcome: "saved" as const,
    reason: null,
  }),
  "environment.configuration.mcpServers.setEnabled": () => ({
    outcome: "saved" as const,
    reason: null,
  }),
  "environment.configuration.skills.list": () => ({
    outcome: "listed" as const,
    revision: null,
    skills: [
      {
        name: "review",
        description: null,
        origin: "room" as const,
        edited: false,
        offFor: [],
      },
    ],
  }),
  "environment.configuration.skills.remove": () => ({
    outcome: "removed" as const,
    reason: null,
  }),
  "environment.host.list": () => ({ hosts: [VIEWING_HOST] }),
  "environment.list": () => teamEnvironments,
  "providers.list": () => ({ providers: [], native: null }),
};

function negotiateEverywhere(): void {
  for (const hostId of [mockLocalHostEntry.hostId, VIEWING_HOST.hostId]) {
    negotiateMethodsOn(hostId, {
      "environment.configuration.mcpServers.list": V10,
      "environment.configuration.mcpServers.delete": V10,
      "environment.configuration.mcpServers.setEnabled": V10,
      "environment.configuration.skills.list": V10,
      "environment.configuration.skills.remove": V10,
    });
  }
}

describe("MCP servers and Skills on a build with a server pool", () => {
  it("reads and writes MCP servers through the window's own host", async () => {
    negotiateEverywhere();
    const harness = mountTeamPageOnPoolBuild(poolSource("editor"), handlers);
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

    await userEvent.click(
      await screen.findByRole("switch", { name: "github" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Remove" }),
    );
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Remove server",
      }),
    );

    await waitFor(() => {
      expect(
        hostIdsOf(harness, "environment.configuration.mcpServers.setEnabled"),
      ).toEqual([mockLocalHostEntry.hostId]);
    });
    await waitFor(() => {
      expect(
        hostIdsOf(harness, "environment.configuration.mcpServers.delete"),
      ).toEqual([mockLocalHostEntry.hostId]);
    });
    expect(
      new Set(hostIdsOf(harness, "environment.configuration.mcpServers.list")),
    ).toEqual(new Set([mockLocalHostEntry.hostId]));
  });

  it("reads and writes Skills through the viewing host", async () => {
    negotiateEverywhere();
    const harness = mountTeamPageOnPoolBuild(poolSource("editor"), handlers);
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    await userEvent.click(
      await screen.findByRole("button", { name: "Remove" }),
    );
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Remove skill",
      }),
    );

    await waitFor(() => {
      expect(
        hostIdsOf(harness, "environment.configuration.skills.remove"),
      ).toEqual([VIEWING_HOST.hostId]);
    });
    expect(
      new Set(hostIdsOf(harness, "environment.configuration.skills.list")),
    ).toEqual(new Set([VIEWING_HOST.hostId]));
  });
});
