import "../../../../../__tests__/test-browser-apis";
import { useContext } from "react";
import {
  act,
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
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { EnvironmentHostRecordV12 } from "@traycer/protocol/host/environment/contracts";
import type { RpcErrorCode } from "@traycer/protocol/framework/index";
import { TeamViewingHostPicker } from "@/components/settings/environment/team-viewing-host-picker";
import {
  canSwitchViewingHost,
  useTeamViewingHost,
} from "@/hooks/environment/team/use-team-viewing-host";
import { useAuthStore } from "@/stores/auth/auth-store";
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
function lapsed(hostId: string, hostLabel: string): EnvironmentHostRecordV12 {
  return { ...reachableHost, hostId, hostLabel, reachable: false };
}

function mountTeamHarness(hosts: readonly EnvironmentHostRecordV12[]) {
  useSelectionAuthorityStore.setState({
    effectiveHostId: mockLocalHostEntry.hostId,
  });
  const harness = mountTeamPage(poolSource("editor"), {
    "environment.host.list": () => ({ hosts: [...hosts] }),
    "environment.list": () => teamEnvironments,
  });
  return harness;
}

function rpcFailure(code: RpcErrorCode): HostRpcError {
  return new HostRpcError({
    code,
    message: "The team host list could not be read.",
    requestId: "req-team-host-list",
    method: "environment.host.list",
    fatalDetails: null,
  });
}

function mountMutableTeamHarness(
  hosts: readonly EnvironmentHostRecordV12[],
  environmentId: string,
  initialFailure: Error | null,
) {
  useSelectionAuthorityStore.setState({
    effectiveHostId: mockLocalHostEntry.hostId,
  });
  let failure = initialFailure;
  const source = poolSource("editor");
  if (source.kind !== "pool") {
    throw new Error("Expected a pool configuration source.");
  }
  const harness = mountTeamPage(
    { ...source, environmentId },
    {
      "environment.host.list": () => {
        if (failure !== null) throw failure;
        return { hosts: [...hosts] };
      },
      "environment.list": () => teamEnvironments,
    },
  );
  return {
    ...harness,
    setFailure: (next: Error | null): void => {
      failure = next;
    },
  };
}

function mountHook(hosts: readonly EnvironmentHostRecordV12[]) {
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

  it("names the own host as the viewed one and reads each row's availability", async () => {
    const harness = mountTeamHarness([
      lapsed(mockLocalHostEntry.hostId, "Studio"),
      lapsed(mockRemoteHostEntry.hostId, "Laptop"),
      { ...reachableHost, hostId: "host-third", hostLabel: "Desk" },
    ]);
    render(<TeamViewingHostPicker open onOpenChange={() => {}} />, {
      wrapper: harness.Wrapper,
    });

    expect(await screen.findByText("as reported by Studio")).toBeTruthy();
    const own = await screen.findByRole("option", { name: "Studio" });
    expect(own.getAttribute("aria-disabled")).not.toBe("true");
    const lapsedRow = screen.getByRole("option", { name: "Laptop · offline" });
    expect(lapsedRow.getAttribute("aria-disabled")).toBe("true");
    const reachable = screen.getByRole("option", { name: "Desk" });
    expect(reachable.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("keeps the selected host and switch choices through a host-list outage", async () => {
    const hosts = [
      lapsed(mockLocalHostEntry.hostId, "Studio"),
      {
        ...reachableHost,
        hostId: mockRemoteHostEntry.hostId,
        hostLabel: "Laptop",
      },
    ];
    const harness = mountMutableTeamHarness(
      hosts,
      "env-host-list-outage",
      null,
    );
    const { result } = renderHook(() => useTeamViewingHost(), {
      wrapper: harness.Wrapper,
    });

    await waitFor(() =>
      expect(result.current.viewingHost?.hostId).toBe(
        mockLocalHostEntry.hostId,
      ),
    );
    act(() => result.current.selectHost(mockRemoteHostEntry.hostId));
    render(<TeamViewingHostPicker open onOpenChange={() => {}} />, {
      wrapper: harness.Wrapper,
    });
    expect(await screen.findByText("as reported by Laptop")).toBeTruthy();

    harness.setFailure(new Error("network unavailable"));
    let refetchFailed = false;
    await act(async () => {
      refetchFailed = (await result.current.hosts.refetch()).isError;
    });

    expect(refetchFailed).toBe(true);
    await waitFor(() => expect(result.current.hosts.isError).toBe(true));
    expect(result.current.viewingHost?.hostId).toBe(mockRemoteHostEntry.hostId);
    expect(canSwitchViewingHost(result.current)).toBe(true);
    expect(screen.getByText("as reported by Laptop")).toBeTruthy();
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.getByRole("option", { name: "Studio" })).toBeTruthy();
  });

  it("drops cached hosts after an authority refusal", async () => {
    const hosts = [
      lapsed(mockLocalHostEntry.hostId, "Studio"),
      {
        ...reachableHost,
        hostId: mockRemoteHostEntry.hostId,
        hostLabel: "Laptop",
      },
    ];
    const harness = mountMutableTeamHarness(
      hosts,
      "env-host-list-forbidden",
      null,
    );
    const { result } = renderHook(() => useTeamViewingHost(), {
      wrapper: harness.Wrapper,
    });

    await waitFor(() =>
      expect(result.current.viewingHost?.hostId).toBe(
        mockLocalHostEntry.hostId,
      ),
    );
    act(() => result.current.selectHost(mockRemoteHostEntry.hostId));
    harness.setFailure(rpcFailure("FORBIDDEN"));
    let refetchFailed = false;
    await act(async () => {
      refetchFailed = (await result.current.hosts.refetch()).isError;
    });

    expect(refetchFailed).toBe(true);
    await waitFor(() => expect(result.current.hosts.isError).toBe(true));
    expect(result.current.viewingHost).toBeNull();
    expect(result.current.client).toBeNull();
    expect(result.current.canSelectHost(mockRemoteHostEntry.hostId)).toBe(
      false,
    );
    expect(canSwitchViewingHost(result.current)).toBe(false);
  });

  it("starts without selectable hosts when the first list read fails", async () => {
    const harness = mountMutableTeamHarness(
      [],
      "env-host-list-initial-failure",
      new Error("network unavailable"),
    );
    const { result } = renderHook(() => useTeamViewingHost(), {
      wrapper: harness.Wrapper,
    });

    await waitFor(() => expect(result.current.hosts.isError).toBe(true));
    expect(result.current.hosts.data).toBeUndefined();
    expect(result.current.viewingHost).toBeNull();
    expect(canSwitchViewingHost(result.current)).toBe(false);
  });

  it("clears the viewed host when cloud authorization is lost", async () => {
    const hosts = [
      lapsed(mockLocalHostEntry.hostId, "Studio"),
      {
        ...reachableHost,
        hostId: mockRemoteHostEntry.hostId,
        hostLabel: "Laptop",
      },
    ];
    const harness = mountMutableTeamHarness(
      hosts,
      "env-host-list-signed-out",
      null,
    );
    const { result } = renderHook(() => useTeamViewingHost(), {
      wrapper: harness.Wrapper,
    });

    await waitFor(() =>
      expect(result.current.viewingHost?.hostId).toBe(
        mockLocalHostEntry.hostId,
      ),
    );
    act(() => result.current.selectHost(mockRemoteHostEntry.hostId));
    await waitFor(() =>
      expect(result.current.viewingHost?.hostId).toBe(
        mockRemoteHostEntry.hostId,
      ),
    );

    useAuthStore.setState({ status: "signed-out" });

    await waitFor(() => expect(result.current.viewingHost).toBeNull());
    expect(result.current.client).toBeNull();
    expect(canSwitchViewingHost(result.current)).toBe(false);
  });
});
