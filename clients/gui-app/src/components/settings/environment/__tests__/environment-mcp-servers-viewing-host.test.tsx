import "../../../../../__tests__/test-browser-apis";
import { useContext } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { EnvironmentMcpServersPage } from "@/components/settings/environment/environment-mcp-servers";
import {
  declaredServer,
  hostMcpServer,
  negotiateMethods,
  providerState,
  teamEnvironments,
} from "./mcp-skills-test-support";
import {
  mountTeamPage,
  poolSource,
  requireTeamHostClient,
  requireViewingHostClient,
  resetTeamPageHarness,
} from "./team-configuration-test-support";

// The page's own host is the local one; the binding the viewing-host binding
// re-provides beneath it carries the viewing host's client.
vi.mock("@/lib/host/runtime", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/host/runtime")>();
  const useHostBinding = () => {
    const provided = useContext(original.HostRuntimeContext);
    return (
      provided ?? {
        hostId: "host-local",
        hostClient: requireTeamHostClient(),
      }
    );
  };
  return {
    ...original,
    useHostBinding,
    useHostClient: () => useHostBinding().hostClient,
  };
});
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: (await import("@/lib/host/runtime")).useHostClient,
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    if (hostId === null) return null;
    return hostId === mockRemoteHostEntry.hostId
      ? requireViewingHostClient()
      : requireTeamHostClient();
  },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), message: vi.fn() },
}));

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  resetNegotiatedManifests();
});

const CAPABLE: readonly ProviderId[] = ["codex"];

const METHODS = {
  "environment.configuration.mcpServers.list": { major: 1, minor: 0 },
  "environment.configuration.items.put": { major: 1, minor: 0 },
  "environment.configuration.items": { major: 1, minor: 0 },
} as const;

describe("The MCP servers page, viewing another host", () => {
  it("sends the revision the first tool switch saved with the next one", async () => {
    negotiateMethods(METHODS);
    const host = { revision: 4 };
    const sentRevisions: Array<number | null> = [];
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.mcpServers.list": () => ({
        servers: [
          declaredServer({
            serverId: "srv-1",
            name: "github",
            item: {
              key: "github",
              revision: host.revision,
              toolToggles: {},
              offFor: [],
            },
          }),
        ],
      }),
      "environment.configuration.items.put": (request) => {
        sentRevisions.push(request.revision);
        host.revision = 5;
        return { outcome: "saved" as const, revision: 5 };
      },
      "environment.host.list": () => ({
        hosts: [
          {
            hostId: mockRemoteHostEntry.hostId,
            hostLabel: "Studio",
            hostPlatform: "darwin",
            enrolledByUserId: "u-1",
            kind: "personal",
            boundAt: 1,
            reachable: true,
            lastReportedAt: 1,
            applied: [],
          },
        ],
      }),
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
                servers: [hostMcpServer("github", ["search", "open"])],
              },
            },
    });
    render(<EnvironmentMcpServersPage />, { wrapper: harness.Wrapper });

    await userEvent.click(await screen.findByRole("button", { name: "Tools" }));
    await userEvent.click(
      await screen.findByRole("switch", { name: "github Codex search" }),
    );
    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items.put"),
      ).toHaveLength(1);
    });
    await waitFor(() => {
      expect(
        screen
          .getByRole("switch", { name: "github Codex open" })
          .hasAttribute("disabled"),
      ).toBe(false);
    });
    await userEvent.click(
      screen.getByRole("switch", { name: "github Codex open" }),
    );

    await waitFor(() => {
      expect(sentRevisions).toHaveLength(2);
    });
    expect(sentRevisions).toEqual([4, 5]);
  });
});
