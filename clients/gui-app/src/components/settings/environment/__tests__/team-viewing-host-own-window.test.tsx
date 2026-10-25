import "../../../../../__tests__/test-browser-apis";
import { useContext } from "react";
import {
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type { EnvironmentHostRecordV11 } from "@traycer/protocol/host/environment/contracts";
import { TeamViewingHostPicker } from "@/components/settings/environment/team-viewing-host-picker";
import { useTeamViewingHost } from "@/hooks/environment/team/use-team-viewing-host";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { reachableHost, teamEnvironments } from "./mcp-skills-test-support";
import {
  mountTeamPage,
  poolSource,
  requireTeamHostClient,
  requireViewingHostClient,
  resetTeamPageHarness,
} from "./team-configuration-test-support";

// The window's host is the local one; the host list and the cloud identity are
// the boundaries, the hook, its query and the selection store are real.
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

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  useSelectionAuthorityStore.getState().reset();
});

/** A host whose cloud `reachable` flag has lapsed. */
function lapsed(hostId: string, hostLabel: string): EnvironmentHostRecordV11 {
  return { ...reachableHost, hostId, hostLabel, reachable: false };
}

function mountTeamHarness(hosts: readonly EnvironmentHostRecordV11[]) {
  useSelectionAuthorityStore.setState({
    effectiveHostId: mockLocalHostEntry.hostId,
  });
  const harness = mountTeamPage(poolSource("editor"), {
    "environment.host.list": () => ({ hosts: [...hosts] }),
    "environment.list": () => teamEnvironments,
  });
  return harness;
}

function mountHook(hosts: readonly EnvironmentHostRecordV11[]) {
  return renderHook(() => useTeamViewingHost(), {
    wrapper: mountTeamHarness(hosts).Wrapper,
  });
}

describe("useTeamViewingHost, the window's own host", () => {
  it("views the window's own host although the cloud's reachable flag has lapsed", async () => {
    const own = mockLocalHostEntry.hostId;
    const { result } = mountHook([lapsed(own, "Studio")]);

    await waitFor(() => {
      expect(result.current.viewingHost?.hostId).toBe(own);
    });
    expect(result.current.canSelectHost(own)).toBe(true);
  });

  it("keeps requiring a reachable flag from any other host", async () => {
    const remote = mockRemoteHostEntry.hostId;
    const { result } = mountHook([lapsed(remote, "Laptop")]);

    await waitFor(() => {
      expect(result.current.hosts.data?.hosts).toHaveLength(1);
    });
    expect(result.current.viewingHost).toBeNull();
    expect(result.current.canSelectHost(remote)).toBe(false);
  });

  it("names the own host as the viewed one and shows no host as offline", async () => {
    const harness = mountTeamHarness([
      lapsed(mockLocalHostEntry.hostId, "Studio"),
      lapsed(mockRemoteHostEntry.hostId, "Laptop"),
    ]);
    render(<TeamViewingHostPicker open onOpenChange={() => {}} />, {
      wrapper: harness.Wrapper,
    });

    expect(await screen.findByText("as reported by Studio")).toBeTruthy();
    expect(screen.queryByText(/offline/)).toBeNull();
  });
});
