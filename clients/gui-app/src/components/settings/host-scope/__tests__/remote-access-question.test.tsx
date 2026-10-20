// The client is a REAL `HostClient` over an in-memory messenger
// (`buildAccessHost`); only the host on the far side is faked.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { EnvironmentStatusResponse } from "@traycer/protocol/host/environment-schemas";
import {
  ACCESS_HOST_ID,
  ACCESS_METHODS,
  buildAccessHost,
  buildAccessHostOn,
  type AccessHost,
} from "@/components/settings/host-scope/__tests__/host-access-test-support";
import { REMOTE_ACCESS_QUESTION } from "@/components/settings/host-scope/host-access-model";
import { RemoteAccessQuestion } from "@/components/settings/host-scope/remote-access-question";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import { useHostAccessPromptsStore } from "@/stores/hosts/host-access-prompts-store";

const OTHER_HOST_ID = "host-b";

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  window.localStorage.clear();
  useHostAccessPromptsStore.setState({
    remoteAccessAnswered: {},
    movedNoticeDismissed: {},
  });
});

const WITHOUT_REMOTE_ACCESS_SET = ACCESS_METHODS.filter(
  (method) => method !== "host.remoteAccess.set",
);

function askingHost(overrides: Partial<EnvironmentStatusResponse>): AccessHost {
  return buildAccessHost({
    status: environmentStatusFixture({
      principal: { kind: "personal" },
      remoteAccess: "off",
      ...overrides,
    }),
    remoteAccessAnswer: { state: "on" },
  });
}

function renderQuestion(options: {
  readonly host: AccessHost;
  readonly hostId: string | null;
  readonly enabled: boolean;
  readonly methods: readonly string[];
}): { readonly unmount: () => void } {
  for (const hostId of [ACCESS_HOST_ID, OTHER_HOST_ID]) {
    recordNegotiatedHostMethods(hostId, options.methods);
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RemoteAccessQuestion
        client={options.host.client}
        hostId={options.hostId}
        enabled={options.enabled}
      />
    </QueryClientProvider>,
  );
}

/**
 * Lets everything a NEGATIVE assertion depends on happen first: the status
 * read lands (when one is due) and React commits it. `waitFor` cannot carry a
 * negative, it passes on its first check.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  });
}

describe("<RemoteAccessQuestion />", () => {
  it("asks once for a personal host whose remote access is off", async () => {
    renderQuestion({
      host: askingHost({}),
      hostId: ACCESS_HOST_ID,
      enabled: true,
      methods: ACCESS_METHODS,
    });

    const question = await screen.findByTestId("remote-access-question");
    expect(question.textContent).toContain(REMOTE_ACCESS_QUESTION);
    expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "On" })).toBeTruthy();
  });

  it("Not now hides it and records the answer for that host only", async () => {
    const host = askingHost({});
    const { unmount } = renderQuestion({
      host,
      hostId: ACCESS_HOST_ID,
      enabled: true,
      methods: ACCESS_METHODS,
    });
    await screen.findByTestId("remote-access-question");

    fireEvent.click(screen.getByRole("button", { name: "Not now" }));

    await waitFor(() => {
      expect(screen.queryByTestId("remote-access-question")).toBeNull();
    });
    expect(useHostAccessPromptsStore.getState().remoteAccessAnswered).toEqual({
      [ACCESS_HOST_ID]: true,
    });
    // Not now leaves it off: nothing was sent.
    expect(host.requests).toEqual([]);

    // Another host id has not been asked yet, so it still asks.
    unmount();
    renderQuestion({
      host: buildAccessHostOn(OTHER_HOST_ID, {
        status: environmentStatusFixture({
          principal: { kind: "personal" },
          remoteAccess: "off",
        }),
      }),
      hostId: OTHER_HOST_ID,
      enabled: true,
      methods: ACCESS_METHODS,
    });
    expect(await screen.findByTestId("remote-access-question")).toBeTruthy();
  });

  it("On sends enabled: true, records the answer and stops asking", async () => {
    const host = askingHost({});
    renderQuestion({
      host,
      hostId: ACCESS_HOST_ID,
      enabled: true,
      methods: ACCESS_METHODS,
    });
    await screen.findByTestId("remote-access-question");

    fireEvent.click(screen.getByRole("button", { name: "On" }));

    await waitFor(() => {
      expect(host.paramsOf("host.remoteAccess.set")).toEqual([
        { enabled: true },
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("remote-access-question")).toBeNull();
    });
    expect(useHostAccessPromptsStore.getState().remoteAccessAnswered).toEqual({
      [ACCESS_HOST_ID]: true,
    });
  });

  it("does not ask on a team's host", async () => {
    const host = askingHost({ principal: { kind: "team", teamName: "Acme" } });
    renderQuestion({
      host,
      hostId: ACCESS_HOST_ID,
      enabled: true,
      methods: ACCESS_METHODS,
    });
    await waitFor(() => {
      expect(host.reads.status).toBeGreaterThan(0);
    });
    await settle();
    expect(screen.queryByTestId("remote-access-question")).toBeNull();
  });

  it("does not ask on a host with no settings of the person's yet", async () => {
    const host = askingHost({ principal: null });
    renderQuestion({
      host,
      hostId: ACCESS_HOST_ID,
      enabled: true,
      methods: ACCESS_METHODS,
    });
    await waitFor(() => {
      expect(host.reads.status).toBeGreaterThan(0);
    });
    await settle();
    expect(screen.queryByTestId("remote-access-question")).toBeNull();
  });

  it("does not ask while remote access is on", async () => {
    const host = askingHost({ remoteAccess: "on" });
    renderQuestion({
      host,
      hostId: ACCESS_HOST_ID,
      enabled: true,
      methods: ACCESS_METHODS,
    });
    await waitFor(() => {
      expect(host.reads.status).toBeGreaterThan(0);
    });
    await settle();
    expect(screen.queryByTestId("remote-access-question")).toBeNull();
  });

  it("does not ask again once this desktop has an answer for the host", async () => {
    useHostAccessPromptsStore.getState().answerRemoteAccess(ACCESS_HOST_ID);
    const host = askingHost({});
    renderQuestion({
      host,
      hostId: ACCESS_HOST_ID,
      enabled: true,
      methods: ACCESS_METHODS,
    });
    await waitFor(() => {
      expect(host.reads.status).toBeGreaterThan(0);
    });
    await settle();
    expect(screen.queryByTestId("remote-access-question")).toBeNull();
  });

  it("does not ask, or even read, when the scope cannot reach the host", async () => {
    const host = askingHost({});
    renderQuestion({
      host,
      hostId: ACCESS_HOST_ID,
      enabled: false,
      methods: ACCESS_METHODS,
    });
    await settle();
    expect(screen.queryByTestId("remote-access-question")).toBeNull();
    expect(host.reads.status).toBe(0);
  });

  it("does not ask on a host that cannot switch remote access", async () => {
    const host = askingHost({});
    renderQuestion({
      host,
      hostId: ACCESS_HOST_ID,
      enabled: true,
      methods: WITHOUT_REMOTE_ACCESS_SET,
    });
    await waitFor(() => {
      expect(host.reads.status).toBeGreaterThan(0);
    });
    await settle();
    expect(screen.queryByTestId("remote-access-question")).toBeNull();
  });

  it("does not ask with no host to ask about", async () => {
    const host = askingHost({});
    renderQuestion({
      host,
      hostId: null,
      enabled: true,
      methods: ACCESS_METHODS,
    });
    await settle();
    expect(screen.queryByTestId("remote-access-question")).toBeNull();
    expect(host.reads.status).toBe(0);
  });
});
