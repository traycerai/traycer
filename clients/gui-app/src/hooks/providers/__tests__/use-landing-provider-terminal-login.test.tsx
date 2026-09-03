import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const HOST_ID = "host-1";

const mocks = vi.hoisted(() => ({
  startTerminalLoginRequest: vi.fn(),
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => ({
    getActiveHostId: () => HOST_ID,
    request: mocks.startTerminalLoginRequest,
  }),
}));

import { useLandingProviderTerminalLogin } from "@/hooks/providers/use-landing-provider-terminal-login";
import {
  landingTerminalLayoutFor,
  useLandingTerminalStore,
  type LandingTerminalTabRef,
} from "@/stores/home/landing-terminal-store";
import {
  providerLoginTerminalProviderId,
  useProviderLoginTerminalsStore,
} from "@/stores/providers/provider-login-terminals";

const LANDING_PAGE_ID = "draft-1";

const OLD_TAB: LandingTerminalTabRef = {
  instanceId: "landing-term-old",
  sessionId: "term-old",
  hostId: HOST_ID,
  cwd: "~",
  name: "Reasonix sign-in",
  titleSource: "manual",
  origin: "provider-login",
  originProviderId: "reasonix",
};

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = (props: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return { queryClient, wrapper };
}

function renderStarter(
  wrapper: (props: { readonly children: ReactNode }) => ReactNode,
  launchedFromSessionId: string | null,
) {
  return renderHook(
    () =>
      useLandingProviderTerminalLogin({
        providerId: "reasonix",
        hostId: HOST_ID,
        landingPageId: LANDING_PAGE_ID,
        launchedFromSessionId,
      }),
    { wrapper },
  );
}

describe("useLandingProviderTerminalLogin", () => {
  beforeEach(() => {
    useLandingTerminalStore.getState().resetForTests();
    useProviderLoginTerminalsStore.setState(
      useProviderLoginTerminalsStore.getInitialState(),
      true,
    );
    mocks.startTerminalLoginRequest.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("sends providers.startTerminalLogin with an independent scope and the fixed initial size", async () => {
    mocks.startTerminalLoginRequest.mockResolvedValue({
      sessionId: "term-new",
      replacedSessionId: null,
    });
    const { wrapper } = makeWrapper();
    const { result } = renderStarter(wrapper, null);

    act(() => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(mocks.startTerminalLoginRequest).toHaveBeenCalledWith(
      "providers.startTerminalLogin",
      {
        providerId: "reasonix",
        scope: { kind: "independent" },
        cols: 80,
        rows: 24,
      },
    );
  });

  it("on success, adds a provider-login tab, opens the panel, and records the provider", async () => {
    mocks.startTerminalLoginRequest.mockResolvedValue({
      sessionId: "term-new",
      replacedSessionId: null,
    });
    const { wrapper } = makeWrapper();
    const { result } = renderStarter(wrapper, null);

    act(() => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    const state = useLandingTerminalStore.getState();
    expect(state.tabs).toHaveLength(1);
    const tab = state.tabs[0];
    expect(tab).toMatchObject({
      sessionId: "term-new",
      hostId: HOST_ID,
      name: "Reasonix sign-in",
      titleSource: "manual",
      origin: "provider-login",
      originProviderId: "reasonix",
    });

    const layout = landingTerminalLayoutFor(state, LANDING_PAGE_ID);
    expect(layout.panelOpen).toBe(true);

    expect(providerLoginTerminalProviderId(HOST_ID, "term-new")).toBe(
      "reasonix",
    );
  });

  it("removes the replaced tab's session without adding a pendingKills entry", async () => {
    useLandingTerminalStore.getState().addTab(OLD_TAB);
    mocks.startTerminalLoginRequest.mockResolvedValue({
      sessionId: "term-new",
      replacedSessionId: OLD_TAB.sessionId,
    });
    const { wrapper } = makeWrapper();
    const { result } = renderStarter(wrapper, null);

    act(() => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    const state = useLandingTerminalStore.getState();
    expect(state.tabs.some((tab) => tab.sessionId === OLD_TAB.sessionId)).toBe(
      false,
    );
    expect(
      state.pendingKills.some(
        (pending) =>
          pending.hostId === HOST_ID && pending.sessionId === OLD_TAB.sessionId,
      ),
    ).toBe(false);
  });

  it("removes the launchedFromSessionId tab (a dead tile's 'Start again') without adding a pendingKills entry", async () => {
    const deadTab: LandingTerminalTabRef = {
      ...OLD_TAB,
      instanceId: "landing-term-dead",
      sessionId: "term-dead",
    };
    useLandingTerminalStore.getState().addTab(deadTab);
    mocks.startTerminalLoginRequest.mockResolvedValue({
      sessionId: "term-new",
      replacedSessionId: null,
    });
    const { wrapper } = makeWrapper();
    const { result } = renderStarter(wrapper, deadTab.sessionId);

    act(() => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    const state = useLandingTerminalStore.getState();
    expect(state.tabs.some((tab) => tab.sessionId === deadTab.sessionId)).toBe(
      false,
    );
    expect(
      state.pendingKills.some(
        (pending) =>
          pending.hostId === HOST_ID && pending.sessionId === deadTab.sessionId,
      ),
    ).toBe(false);
  });

  it("does not add a second tab for a second success reporting the same session id", async () => {
    mocks.startTerminalLoginRequest.mockResolvedValue({
      sessionId: "term-new",
      replacedSessionId: null,
    });
    const { wrapper } = makeWrapper();

    const first = renderStarter(wrapper, null);
    act(() => {
      first.result.current.start();
    });
    await waitFor(() => expect(first.result.current.isPending).toBe(false));

    const second = renderStarter(wrapper, null);
    act(() => {
      second.result.current.start();
    });
    await waitFor(() => expect(second.result.current.isPending).toBe(false));

    const state = useLandingTerminalStore.getState();
    expect(
      state.tabs.filter((tab) => tab.sessionId === "term-new"),
    ).toHaveLength(1);
  });
});
