import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const HOST_ID = "host-1";
const OTHER_HOST_ID = "host-2";

const mocks = vi.hoisted(() => ({
  startTerminalLoginRequest: vi.fn(),
  // The host the transient client currently addresses. Mutable because the
  // composer's target host can move WHILE a request is in flight, which
  // re-points this client underneath the pending mutation.
  activeHostId: { current: "host-1" },
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => ({
    getActiveHostId: () => mocks.activeHostId.current,
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
    mocks.activeHostId.current = HOST_ID;
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
    // Exactly one page recorded a layout, and it is the one `start()` named -
    // the id genuinely comes from the call-time argument rather than some
    // hook-bound default. (Read on the KEYED layouts: with no anchor mounted
    // the page-less recovery also opens every page that has none, so a
    // resolved `panelOpen` cannot tell the two apart.)
    expect(Object.keys(state.layoutsByLandingPageId)).toEqual([
      otherLandingPageId,
    ]);
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

  it("with no anchors, opens the panel for a start page that does not exist yet - so a draft discarded mid-flight cannot strand the terminal", async () => {
    mocks.startTerminalLoginRequest.mockResolvedValue({
      sessionId: "term-new",
      replacedSessionId: null,
    });
    const { wrapper } = makeWrapper();
    const { result } = renderStarter(wrapper, null);

    act(() => {
      // The draft bound at press time; by the time the host answers the user
      // has submitted it, so nothing renders under this id any more and no
      // pane is mounted to fall back to.
      result.current.start("draft-discarded");
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    const state = useLandingTerminalStore.getState();
    // The tab is global, so the NEXT start page only has to open its panel.
    expect(state.tabs).toHaveLength(1);
    expect(
      landingTerminalLayoutFor(state, "a-start-page-minted-later").panelOpen,
    ).toBe(true);
  });

  it("with no anchors, also re-opens a start page that had already recorded a CLOSED layout", async () => {
    // The next page to mount is not necessarily new: `landingTerminalLayoutFor`
    // gives a page's own layout precedence over the fallback, so a page that
    // once closed its panel would hide the terminal behind that very layout.
    useLandingTerminalStore.getState().setPanelOpen("draft-existing", false);
    mocks.startTerminalLoginRequest.mockResolvedValue({
      sessionId: "term-new",
      replacedSessionId: null,
    });
    const { wrapper } = makeWrapper();
    const { result } = renderStarter(wrapper, null);

    act(() => {
      result.current.start("draft-discarded");
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    const state = useLandingTerminalStore.getState();
    expect(landingTerminalLayoutFor(state, "draft-existing").panelOpen).toBe(
      true,
    );
  });

  it("opens each of two in-flight presses on ITS OWN page, not both on the last one", async () => {
    const pending: Array<
      (value: { sessionId: string; replacedSessionId: null }) => void
    > = [];
    mocks.startTerminalLoginRequest.mockImplementation(
      () =>
        new Promise<{ sessionId: string; replacedSessionId: null }>(
          (resolve) => {
            pending.push(resolve);
          },
        ),
    );
    const { wrapper } = makeWrapper();
    const { result } = renderStarter(wrapper, null);

    // Two presses on one instance before the first answers - a double click
    // ahead of the `isPending` re-render. `onSuccess` is mutation-level and
    // closes over the hook, so a page read back from a ref there would name
    // the SECOND press for both.
    act(() => {
      result.current.start("draft-first");
      result.current.start("draft-second");
    });
    // The request is dispatched after the (awaited) `onMutate`, so it lands a
    // microtask later than the press.
    await waitFor(() => expect(pending).toHaveLength(2));

    await act(async () => {
      pending[0]?.({ sessionId: "term-first", replacedSessionId: null });
      await Promise.resolve();
    });
    // Only the first page has a keyed layout so far - the first session did
    // not open on "draft-second".
    expect(
      Object.keys(useLandingTerminalStore.getState().layoutsByLandingPageId),
    ).toEqual(["draft-first"]);

    await act(async () => {
      pending[1]?.({ sessionId: "term-second", replacedSessionId: null });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));
    const state = useLandingTerminalStore.getState();
    expect(Object.keys(state.layoutsByLandingPageId).sort()).toEqual([
      "draft-first",
      "draft-second",
    ]);
    expect(state.tabs.map((tab) => tab.sessionId).sort()).toEqual([
      "term-first",
      "term-second",
    ]);
  });

  it("with a live anchor, leaves an unrelated future start page closed", async () => {
    const anchor = document.createElement("div");
    useLandingPaneAnchorStore.getState().setAnchor(LANDING_PAGE_ID, anchor);
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
    // The page-less open is a recovery for having nowhere to show this, not a
    // default: a mounted pane already showed it, so an unrelated page later
    // keeps its own (closed) default.
    expect(
      landingTerminalLayoutFor(state, "a-start-page-minted-later").panelOpen,
    ).toBe(false);
  });

  it("files the new session against the host the request was SENT on, not the one the client points at when it answers", async () => {
    mocks.startTerminalLoginRequest.mockImplementation(() => {
      // The composer's target host moves while the call is in flight, which
      // re-points the transient client underneath this pending mutation.
      mocks.activeHostId.current = OTHER_HOST_ID;
      return Promise.resolve({
        sessionId: "term-new",
        replacedSessionId: null,
      });
    });
    const { wrapper } = makeWrapper();
    const { result } = renderStarter(wrapper, null);

    act(() => {
      result.current.start(LANDING_PAGE_ID);
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    const state = useLandingTerminalStore.getState();
    expect(state.tabs).toHaveLength(1);
    // A tab bound to host-2 points at a PTY that does not exist there, and the
    // provenance record filed under host-2 never matches the session either -
    // so the live sign-in terminal on host-1 has no tab and no origin.
    expect(state.tabs[0]).toMatchObject({
      sessionId: "term-new",
      hostId: HOST_ID,
    });
    expect(providerLoginTerminalProviderId(HOST_ID, "term-new")).toBe(
      "reasonix",
    );
    expect(
      providerLoginTerminalProviderId(OTHER_HOST_ID, "term-new"),
    ).toBeNull();
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
