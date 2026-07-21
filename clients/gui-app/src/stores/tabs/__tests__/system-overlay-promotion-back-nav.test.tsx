// Regression test for: back button dead after promoting a system overlay to
// a tab. Replays: real back history -> open settings overlay -> click-out
// close -> forward -> promote to tab -> back click, against a `GateLike`
// component that mirrors `LocalHostGate`'s PRE-FIX structural swap
// (`<>{children}</>` on bypass vs `<Wrapper>{children}</Wrapper>` when
// ready), so React remounts the gated subtree on every `/settings` boundary
// crossing exactly like the real pre-fix bug.
//
// `GateLike` is kept REMOUNTING on purpose - it is not the thing layers 2+3
// fix (that's layer 1, in `local-host-gate.tsx`). It stands in for ANY
// future ancestor that remounts this subtree, and this test proves the
// module-scoped cold-load latch (layer 2) plus `replace` semantics on the
// focus-tab-first redirect (layer 3) defeat the back-button trap even under
// such a remount, independent of layer 1.
import "../../../../__tests__/test-browser-apis";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  useRouterState,
  type RouterHistory,
} from "@tanstack/react-router";
import {
  resetSystemTabModalColdLoadForTests,
  useSystemTabModalController,
  useSystemTabModalRefreshGuard,
  type SystemTabModalApi,
} from "@/stores/tabs/use-system-tab-modal";
import {
  createPersistentMemoryHistory,
  getHistoryController,
} from "@/lib/persistent-history";
import { goBack, goForward } from "@/lib/commands/actions/history-navigation";
import { useSettingsSectionStore } from "@/stores/tabs/settings-section-store";
import { useTabsStore } from "@/stores/tabs/store";
import { systemTabOverlaySearchSchema } from "@/lib/system-tab-overlay-search";

const modalProbe: { current: SystemTabModalApi | null } = { current: null };
const hostMountLog: string[] = [];

function ModalHostLike() {
  useSystemTabModalRefreshGuard();
  const api = useSystemTabModalController();
  useEffect(() => {
    hostMountLog.push("mounted");
    return () => {
      hostMountLog.push("unmounted");
    };
  }, []);
  useEffect(() => {
    modalProbe.current = api;
  });
  return null;
}

function CompatGateLike(props: { readonly children: ReactNode }) {
  return <>{props.children}</>;
}

// Mirrors `LocalHostGate` PRE-FIX: bypass -> bare children; ready -> children
// under a wrapper component. Different root element types => React remounts
// the subtree when `bypass` flips at the /settings boundary.
function GateLike(props: { readonly children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const bypass = pathname.startsWith("/settings");
  if (bypass) {
    return <>{props.children}</>;
  }
  return <CompatGateLike>{props.children}</CompatGateLike>;
}

function GuardedRoot() {
  return (
    <GateLike>
      <ModalHostLike />
      <Outlet />
    </GateLike>
  );
}

function buildRouter(windowId: string) {
  const rootRoute = createRootRoute({
    validateSearch: (raw) => systemTabOverlaySearchSchema.parse(raw),
    component: GuardedRoot,
  });
  const draftRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/draft/$draftId",
    component: () => <div data-testid="draft-route" />,
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/general",
    component: () => <div data-testid="settings-route" />,
  });
  const history = createPersistentMemoryHistory(null, windowId);
  return createRouter({
    routeTree: rootRoute.addChildren([draftRoute, settingsRoute]),
    history,
  });
}

function seedPersisted(
  windowId: string,
  entries: ReadonlyArray<string>,
  index: number,
) {
  window.localStorage.setItem(
    `traycer-gui-app:last-route:${windowId}`,
    JSON.stringify({ entries, index }),
  );
}

interface SnapshotRouter {
  readonly history: RouterHistory;
  readonly state: { readonly location: { readonly href: string } };
}

function snapshot(router: SnapshotRouter) {
  const controller = getHistoryController(router.history);
  if (controller === null) throw new Error("no controller");
  return {
    entries: controller.getEntries(),
    index: controller.getIndex(),
    canGoBack: controller.canGoBack(),
    canGoForward: controller.canGoForward(),
    rendered: router.state.location.href,
  };
}

describe("back stays functional after promoting a system overlay to a tab", () => {
  beforeEach(() => {
    window.localStorage.clear();
    modalProbe.current = null;
    hostMountLog.length = 0;
    resetSystemTabModalColdLoadForTests();
    useSettingsSectionStore.setState({ section: null });
    useTabsStore.setState({ systemTabs: { history: null, settings: null } });
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("back click #1 after promotion escapes the overlay entry instead of re-pushing the tab route", async () => {
    const windowId = "promote-back-nav";
    seedPersisted(windowId, ["/draft/d0", "/draft/d1"], 1);
    const router = buildRouter(windowId);
    render(<RouterProvider router={router} />);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/draft/d1"),
    );
    await waitFor(() => expect(modalProbe.current).not.toBeNull());

    act(() => {
      modalProbe.current?.openSettings({
        section: null,
        resetToGeneral: false,
      });
    });
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        settingsOverlay: true,
      }),
    );

    act(() => {
      modalProbe.current?.close();
    });
    await waitFor(() =>
      expect(router.state.location.search).not.toHaveProperty(
        "settingsOverlay",
      ),
    );

    act(() => {
      goForward(router);
    });
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        settingsOverlay: true,
      }),
    );

    act(() => {
      modalProbe.current?.promoteToTab();
    });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/general"),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const before = snapshot(router);
    expect(before.rendered).toBe("/settings/general");

    act(() => {
      goBack(router);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    const afterFirstBack = snapshot(router);
    // The core trap: pre-fix, the guard's cold-load-only redirect re-arms on
    // the remount this Back triggers and immediately pushes /settings/general
    // right back on top, leaving `rendered` byte-identical to `before`. With
    // the module-scoped latch (layer 2) that redirect can never re-fire past
    // the first ever boot, so the stack the real `history.go(-1)` produced
    // survives - back click #1 lands on the real underlying page, not a
    // re-push of /settings/general onto a byte-identical stack.
    expect(afterFirstBack.rendered).not.toBe(before.rendered);
    expect(router.state.location.pathname).toBe("/draft/d1");
    expect(afterFirstBack.canGoBack).toBe(true);

    // Note: `GateLike` here still remounts the guard on every /settings
    // boundary crossing (it is not layer 1's fix), so the auto-close branch's
    // `lastPathnameRef` is reborn already-equal to the post-navigation
    // pathname on this exact click and can't detect the change; the stray
    // `settingsOverlay` search flag on this entry survives one extra click
    // as a result. That collapse-in-one-click only happens once layer 1
    // stops the remounts (proven separately in `local-host-gate.test.tsx`).
    // What matters here is what layers 2+3 alone guarantee: back never
    // bounces to /settings/general again, and repeated presses make
    // monotonic progress back to the original entry instead of looping.
    for (let clicksRemaining = 2; clicksRemaining > 0; clicksRemaining--) {
      act(() => {
        goBack(router);
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      expect(router.state.location.pathname).not.toBe("/settings/general");
    }

    expect(router.state.location.pathname).toBe("/draft/d0");
  });
});
