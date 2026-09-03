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

import { useLandingProviderStartTerminalLogin } from "@/hooks/providers/use-landing-provider-terminal-login";
import {
  landingTerminalLayoutFor,
  useLandingTerminalStore,
  type LandingTerminalTabRef,
} from "@/stores/home/landing-terminal-store";
import {
  providerLoginTerminalProviderId,
  useProviderLoginTerminalsStore,
} from "@/stores/providers/provider-login-terminals";
import { useLandingPaneAnchorStore } from "@/components/home/terminal-panel/landing-pane-anchor-store";

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
      useLandingProviderStartTerminalLogin({
        providerId: "reasonix",
        hostId: HOST_ID,
        launchedFromSessionId,
      }),
    { wrapper },
  );
}

describe("useLandingProviderStartTerminalLogin", () => {
  beforeEach(() => {
    useLandingTerminalStore.getState().resetForTests();
    useProviderLoginTerminalsStore.setState(
      useProviderLoginTerminalsStore.getInitialState(),
      true,
    );
    useLandingPaneAnchorStore.setState(
      useLandingPaneAnchorStore.getInitialState(),
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
      result.current.start(LANDING_PAGE_ID);
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
      result.current.start(LANDING_PAGE_ID);
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

  it("opens the panel for whichever landingPageId is passed to start() at press time, not a fixed hook-level id - the hook takes no landingPageId argument", async () => {
    mocks.startTerminalLoginRequest.mockResolvedValue({
      sessionId: "term-new",
      replacedSessionId: null,
    });
    const { wrapper } = makeWrapper();
    const { result } = renderStarter(wrapper, null);
    const otherLandingPageId = "draft-second";

    act(() => {
      result.current.start(otherLandingPageId);
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    const state = useLandingTerminalStore.getState();
    expect(landingTerminalLayoutFor(state, otherLandingPageId).panelOpen).toBe(
      true,
    );
    // Never opened for a page nobody asked for - the id genuinely comes from
    // the call-time argument rather than some hook-bound default.
    expect(landingTerminalLayoutFor(state, LANDING_PAGE_ID).panelOpen).toBe(
      false,
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
      result.current.start(LANDING_PAGE_ID);
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
      result.current.start(LANDING_PAGE_ID);
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
      first.result.current.start(LANDING_PAGE_ID);
    });
    await waitFor(() => expect(first.result.current.isPending).toBe(false));

    const second = renderStarter(wrapper, null);
    act(() => {
      second.result.current.start(LANDING_PAGE_ID);
    });
    await waitFor(() => expect(second.result.current.isPending).toBe(false));

    const state = useLandingTerminalStore.getState();
    expect(
      state.tabs.filter((tab) => tab.sessionId === "term-new"),
    ).toHaveLength(1);
  });

  it("opens the panel layout for the initiating landingPageId plus every start page with a mounted panel anchor", async () => {
    const anchorA = document.createElement("div");
    const anchorB = document.createElement("div");
    useLandingPaneAnchorStore.getState().setAnchor("draft-a", anchorA);
    useLandingPaneAnchorStore.getState().setAnchor("draft-b", anchorB);
    mocks.startTerminalLoginRequest.mockResolvedValue({
      sessionId: "term-new",
      replacedSessionId: null,
    });
    const { wrapper } = makeWrapper();
    const { result } = renderStarter(wrapper, null);

    act(() => {
      result.current.start("draft-a");
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    const state = useLandingTerminalStore.getState();
    // Both anchored pages open - the initiating one directly, and the other
    // because the retained hosted-page id (unreadable from outside) might be
    // either one.
    expect(landingTerminalLayoutFor(state, "draft-a").panelOpen).toBe(true);
    expect(landingTerminalLayoutFor(state, "draft-b").panelOpen).toBe(true);
  });

  it("opens only the initiating page's layout when no panel anchors are registered", async () => {
    mocks.startTerminalLoginRequest.mockResolvedValue({
      sessionId: "term-new",
      replacedSessionId: null,
    });
    const { wrapper } = makeWrapper();
    const { result } = renderStarter(wrapper, null);

    act(() => {
      result.current.start(LANDING_PAGE_ID);
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    const state = useLandingTerminalStore.getState();
    expect(landingTerminalLayoutFor(state, LANDING_PAGE_ID).panelOpen).toBe(
      true,
    );
    // No crash, and no layout key opened beyond the initiating page - an
    // empty anchor set contributes nothing to the union.
    expect(Object.keys(state.layoutsByLandingPageId)).toEqual([
      LANDING_PAGE_ID,
    ]);
  });

  it("opens the initiating page's layout even when it has no panel anchor of its own", async () => {
    const anchorB = document.createElement("div");
    useLandingPaneAnchorStore.getState().setAnchor("draft-b", anchorB);
    mocks.startTerminalLoginRequest.mockResolvedValue({
      sessionId: "term-new",
      replacedSessionId: null,
    });
    const { wrapper } = makeWrapper();
    const { result } = renderStarter(wrapper, null);

    act(() => {
      // "draft-a" has no anchor registered - only "draft-b" does.
      result.current.start("draft-a");
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    const state = useLandingTerminalStore.getState();
    expect(landingTerminalLayoutFor(state, "draft-a").panelOpen).toBe(true);
    expect(landingTerminalLayoutFor(state, "draft-b").panelOpen).toBe(true);
  });
});
