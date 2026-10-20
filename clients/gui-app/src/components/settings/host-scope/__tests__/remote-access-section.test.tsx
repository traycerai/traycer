// The grant minter a write carries is read from the host binding. Mocked at
// that boundary, as the other Personal suites do; the client itself is a REAL
// `HostClient` over an in-memory messenger (`buildAccessHost`), so a switch
// travels the request path the app uses and only the host is faked.
const hostMock = vi.hoisted(
  (): { binding: { readonly auth: unknown } | null } => ({ binding: null }),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => hostMock.binding };
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { RemoteAccessState } from "@traycer/protocol/host/environment-schemas";
import {
  ACCESS_HOST_ID,
  ACCESS_HOST_NAME,
  ACCESS_METHODS,
  buildAccessHost,
  type AccessHost,
} from "@/components/settings/host-scope/__tests__/host-access-test-support";
import { REMOTE_ACCESS_TEXT } from "@/components/settings/host-scope/host-access-model";
import { HostOverviewAccessTab } from "@/components/settings/panels/host-overview-access-tab";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import { useHostAccessPromptsStore } from "@/stores/hosts/host-access-prompts-store";

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  hostMock.binding = null;
  window.localStorage.clear();
  useHostAccessPromptsStore.setState({
    remoteAccessAnswered: {},
    movedNoticeDismissed: {},
  });
});

const WITHOUT_REMOTE_ACCESS_SET = ACCESS_METHODS.filter(
  (method) => method !== "host.remoteAccess.set",
);

function hostWithRemoteAccess(
  remoteAccess: RemoteAccessState,
  answer: RemoteAccessState,
): AccessHost {
  return buildAccessHost({
    status: environmentStatusFixture({ remoteAccess }),
    remoteAccessAnswer: { state: answer },
  });
}

function renderTab(host: AccessHost, methods: readonly string[]): QueryClient {
  recordNegotiatedHostMethods(ACCESS_HOST_ID, methods);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <HostOverviewAccessTab
        client={host.client}
        hostId={ACCESS_HOST_ID}
        hostName={ACCESS_HOST_NAME}
        connecting={false}
        usable
      />
    </QueryClientProvider>,
  );
  return queryClient;
}

/** What the section says now, as the person reads it. */
async function shownState(): Promise<string> {
  const state = await screen.findByTestId("remote-access-state");
  return state.textContent;
}

/** The host answers a read again: the status poll, or the tab being reopened. */
async function rereadStatus(
  queryClient: QueryClient,
  host: AccessHost,
): Promise<void> {
  const before = host.reads.status;
  await act(async () => {
    await queryClient.invalidateQueries();
  });
  await waitFor(() => {
    expect(host.reads.status).toBeGreaterThan(before);
  });
}

function noSwitch(): void {
  expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Turn off" })).toBeNull();
}

describe("<RemoteAccessSection /> in Access and setup", () => {
  it("Off shows 'turning off' until the host confirms", async () => {
    const host = hostWithRemoteAccess("on", "turning_off");
    const queryClient = renderTab(host, ACCESS_METHODS);
    expect(await shownState()).toBe(REMOTE_ACCESS_TEXT.on);

    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));

    // The request is Off, and nothing else.
    await waitFor(() => {
      expect(host.paramsOf("host.remoteAccess.set")).toEqual([
        { enabled: false },
      ]);
    });
    // The host answered `turning_off`, and its status read can still say `on`
    // for a poll or two: the section shows the host's answer, not that read.
    await waitFor(() => {
      expect(screen.getByTestId("remote-access-state").textContent).toBe(
        "Turning off. Other devices and agents are being disconnected.",
      );
    });
    expect(screen.getByTestId("remote-access-turning-off")).toBeTruthy();
    noSwitch();

    // The status is read again after the switch (the mutation re-reads it)
    // and again here: still `on`, still "turning off".
    await rereadStatus(queryClient, host);
    expect(host.state.status.remoteAccess).toBe("on");
    expect(screen.getByTestId("remote-access-state").textContent).toBe(
      REMOTE_ACCESS_TEXT.turning_off,
    );
    expect(screen.getByTestId("remote-access-turning-off")).toBeTruthy();
    noSwitch();

    // The host itself says `turning_off`: the same line, the same spinner.
    host.state.status = environmentStatusFixture({
      remoteAccess: "turning_off",
    });
    await rereadStatus(queryClient, host);
    expect(screen.getByTestId("remote-access-state").textContent).toBe(
      REMOTE_ACCESS_TEXT.turning_off,
    );
    expect(screen.getByTestId("remote-access-turning-off")).toBeTruthy();
    noSwitch();

    // Only the host's own `off` ends it.
    host.state.status = environmentStatusFixture({ remoteAccess: "off" });
    await rereadStatus(queryClient, host);
    await waitFor(() => {
      expect(screen.getByTestId("remote-access-state").textContent).toBe(
        "Off. Other devices and agents can't reach this computer. Your settings still reach it.",
      );
    });
    expect(screen.queryByTestId("remote-access-turning-off")).toBeNull();
    expect(screen.getByRole("button", { name: "Turn on" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Turn off" })).toBeNull();
  });

  it("says what On means and offers Turn off", async () => {
    renderTab(hostWithRemoteAccess("on", "turning_off"), ACCESS_METHODS);

    expect(await shownState()).toBe(
      "On. Other devices and agents signed in to your account can reach this computer.",
    );
    expect(screen.getByRole("button", { name: "Turn off" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
    expect(screen.queryByTestId("remote-access-turning-off")).toBeNull();
  });

  it("Turn on sends enabled: true and shows what the host reads next", async () => {
    const host = hostWithRemoteAccess("off", "on");
    const queryClient = renderTab(host, ACCESS_METHODS);
    expect(await shownState()).toBe(REMOTE_ACCESS_TEXT.off);

    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));

    await waitFor(() => {
      expect(host.paramsOf("host.remoteAccess.set")).toEqual([
        { enabled: true },
      ]);
    });
    host.state.status = environmentStatusFixture({ remoteAccess: "on" });
    await rereadStatus(queryClient, host);
    await waitFor(() => {
      expect(screen.getByTestId("remote-access-state").textContent).toBe(
        REMOTE_ACCESS_TEXT.on,
      );
    });
    expect(screen.getByRole("button", { name: "Turn off" })).toBeTruthy();
  });

  it("shows a host that is turning remote access off by itself the same way", async () => {
    renderTab(hostWithRemoteAccess("turning_off", "off"), ACCESS_METHODS);

    expect(await shownState()).toBe(REMOTE_ACCESS_TEXT.turning_off);
    expect(screen.getByTestId("remote-access-turning-off")).toBeTruthy();
    noSwitch();
  });

  it("offers no switch on a host that does not have host.remoteAccess.set, and still says the state", async () => {
    const host = hostWithRemoteAccess("on", "turning_off");
    renderTab(host, WITHOUT_REMOTE_ACCESS_SET);

    expect(await shownState()).toBe(REMOTE_ACCESS_TEXT.on);
    noSwitch();
    expect(host.paramsOf("host.remoteAccess.set")).toEqual([]);
  });

  it("marks the host answered when the person switches remote access, and no other host", async () => {
    const host = hostWithRemoteAccess("on", "turning_off");
    renderTab(host, ACCESS_METHODS);
    await shownState();
    expect(useHostAccessPromptsStore.getState().remoteAccessAnswered).toEqual(
      {},
    );

    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));

    await waitFor(() => {
      expect(useHostAccessPromptsStore.getState().remoteAccessAnswered).toEqual(
        { [ACCESS_HOST_ID]: true },
      );
    });
    expect(
      useHostAccessPromptsStore.getState().remoteAccessAnswered["host-b"],
    ).toBeUndefined();
  });
});
