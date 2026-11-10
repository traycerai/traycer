import "../../../../../__tests__/test-browser-apis";
import { useContext } from "react";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { EnvironmentMcpServersPage } from "@/components/settings/environment/environment-mcp-servers";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
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

async function openServerCard(name: string): Promise<void> {
  const row = (await screen.findAllByRole("listitem")).find(
    (item) => within(item).queryByText(name) !== null,
  );
  if (row === undefined) throw new Error(`No row for ${name}.`);
  await userEvent.click(within(row).getByRole("button", { expanded: false }));
}

describe("The MCP servers page, viewing another host", () => {
  it("sends the revision the first save stored when the next staged tool change is saved", async () => {
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
            hasLocalRow: false,
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

    await openServerCard("github");
    const search = await screen.findByRole("switch", { name: "github search" });
    expect(screen.getByRole("switch", { name: "github open" })).toBeTruthy();
    const listsBeforeSave = harness.paramsOf(
      "environment.configuration.mcpServers.list",
    ).length;
    await userEvent.click(search);
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(sentRevisions).toEqual([4]);
    });
    expect(
      harness.paramsOf("environment.configuration.items.put")[0],
    ).toMatchObject({
      revision: 4,
      value: {
        toolToggles: {
          [providerIdToGuiHarnessId("codex")]: { search: false },
        },
      },
    });
    await waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.mcpServers.list").length,
      ).toBeGreaterThan(listsBeforeSave);
      expect(
        screen
          .getByRole("switch", { name: "github open" })
          .hasAttribute("disabled"),
      ).toBe(false);
    });
    await userEvent.click(screen.getByRole("switch", { name: "github open" }));
    expect(sentRevisions).toEqual([4]);
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(sentRevisions).toEqual([4, 5]);
    });
    expect(
      harness.paramsOf("environment.configuration.items.put")[1],
    ).toMatchObject({
      revision: 5,
      value: {
        toolToggles: {
          [providerIdToGuiHarnessId("codex")]: { open: false },
        },
      },
    });
  });
});
