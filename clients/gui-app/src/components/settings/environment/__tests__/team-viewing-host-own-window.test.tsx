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
import type { EnvironmentTransportAnswer } from "@traycer-clients/shared/environment/environment-cloud";
import type { EnvironmentHostRecordV12 } from "@traycer/protocol/host/environment/contracts";
import { TeamVariableLiveFacts } from "@/components/settings/environment/team-variable-live-facts";
import { TeamViewingHostPicker } from "@/components/settings/environment/team-viewing-host-picker";
import {
  canSwitchViewingHost,
  useTeamViewingHost,
} from "@/hooks/environment/team/use-team-viewing-host";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { reachableHost, teamEnvironments } from "./mcp-skills-test-support";
import { invalidateEnvironmentReads } from "@/hooks/environment/use-environment-cloud";
import {
  answerTeamHostList,
  authnAnswer,
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
      "config.shell.get": () => ({
        path: "/bin/zsh",
        args: [],
        synthesised: false,
        entries: [],
      }),
      "config.env.list": () => ({ entries: [] }),
    },
  );
  return {
    ...harness,
    setFailure: (next: Error | null): void => {
      failure = next;
    },
  };
}

function studioAndLaptop(): EnvironmentHostRecordV12[] {
  return [
    lapsed(mockLocalHostEntry.hostId, "Studio"),
    {
      ...reachableHost,
      hostId: mockRemoteHostEntry.hostId,
      hostLabel: "Laptop",
    },
  ];
}

/**
 * The window views Laptop, the picker is drawn, then authn answers the next
 * host list read with `answer` and the read is made again.
 */
async function viewLaptopThenReadHosts(
  environmentId: string,
  answer: EnvironmentTransportAnswer | null,
) {
  const harness = mountMutableTeamHarness(
    studioAndLaptop(),
    environmentId,
    null,
  );
  const hook = renderHook(() => useTeamViewingHost(), {
    wrapper: harness.Wrapper,
  });
  const { result } = hook;
  await waitFor(() =>
    expect(result.current.viewingHost?.hostId).toBe(mockLocalHostEntry.hostId),
  );
  act(() => result.current.selectHost(mockRemoteHostEntry.hostId));
  const picker = render(
    <TeamViewingHostPicker open={false} onOpenChange={() => {}} />,
    { wrapper: harness.Wrapper },
  );
  expect(await screen.findByText("as reported by Laptop")).toBeTruthy();

  answerTeamHostList(harness, environmentId, answer);
  let refetchFailed = false;
  await act(async () => {
    refetchFailed = (await result.current.hosts.refetch()).isError;
  });
  expect(refetchFailed).toBe(true);
  await waitFor(() => expect(result.current.hosts.isError).toBe(true));
  return { harness, result, picker };
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
    const { result, picker } = await viewLaptopThenReadHosts(
      "env-host-list-forbidden",
      authnAnswer(403, { code: "environment_action_forbidden" }),
    );

    expect(result.current.viewingHost).toBeNull();
    expect(result.current.client).toBeNull();
    expect(result.current.canSelectHost(mockRemoteHostEntry.hostId)).toBe(
      false,
    );
    expect(canSwitchViewingHost(result.current)).toBe(false);
    expect(picker.container.textContent).toBe("");
  });

  it("drops cached hosts when authn says the team is not the person's to read", async () => {
    const { result, picker } = await viewLaptopThenReadHosts(
      "env-host-list-not-found",
      authnAnswer(404, { code: "environment_not_found" }),
    );

    expect(result.current.viewingHost).toBeNull();
    expect(result.current.client).toBeNull();
    expect(result.current.canSelectHost(mockRemoteHostEntry.hostId)).toBe(
      false,
    );
    expect(canSwitchViewingHost(result.current)).toBe(false);
    expect(picker.container.textContent).toBe("");
  });

  // Each case has an environment of its own: the viewing host the person
  // picked is remembered per environment for the whole file.
  it.each([
    ["a 403 without authn's code", "kept-403", authnAnswer(403, {})],
    ["a 404 without authn's code", "kept-404", authnAnswer(404, {})],
    [
      "a malformed request",
      "kept-400",
      authnAnswer(400, { error: "environmentId must be an environment id" }),
    ],
    [
      "a 503",
      "kept-503",
      authnAnswer(503, { error: "temporarily unavailable" }),
    ],
    ["no answer", "kept-no-answer", null],
  ])("keeps cached hosts through %s", async (_label, slug, answer) => {
    const { result } = await viewLaptopThenReadHosts(
      `env-host-list-${slug}`,
      answer,
    );

    expect(result.current.viewingHost?.hostId).toBe(mockRemoteHostEntry.hostId);
    expect(result.current.client).not.toBeNull();
    expect(result.current.canSelectHost(mockRemoteHostEntry.hostId)).toBe(true);
    expect(canSwitchViewingHost(result.current)).toBe(true);
    expect(screen.getByText("as reported by Laptop")).toBeTruthy();
    expect(screen.getByText("Use another host")).toBeTruthy();
  });

  it("replaces a page's live values with the card that says the hosts could not be read after a refusal", async () => {
    const harness = mountMutableTeamHarness(studioAndLaptop(), "env-a", null);
    render(<TeamVariableLiveFacts />, { wrapper: harness.Wrapper });
    expect(await screen.findByText("Applied on Studio")).toBeTruthy();

    answerTeamHostList(
      harness,
      "env-a",
      authnAnswer(403, { code: "environment_action_forbidden" }),
    );
    await act(() =>
      invalidateEnvironmentReads(harness.queryClient, [
        "environment.host.list",
      ]),
    );

    expect(await screen.findByText("Couldn't read Acme's hosts.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText("Pick one.")).toBeNull();
    expect(screen.queryByText("Applied on Studio")).toBeNull();
  });

  it("keeps a page's live values through a host list outage", async () => {
    const harness = mountMutableTeamHarness(studioAndLaptop(), "env-a", null);
    render(<TeamVariableLiveFacts />, { wrapper: harness.Wrapper });
    expect(await screen.findByText("Applied on Studio")).toBeTruthy();

    answerTeamHostList(
      harness,
      "env-a",
      authnAnswer(503, { error: "temporarily unavailable" }),
    );
    await act(() =>
      invalidateEnvironmentReads(harness.queryClient, [
        "environment.host.list",
      ]),
    );

    expect(screen.getByText("Applied on Studio")).toBeTruthy();
    expect(screen.queryByText(/Couldn't read Acme's hosts/)).toBeNull();
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
