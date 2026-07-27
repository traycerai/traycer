import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PrListBackgroundMount } from "@/providers/pr-list-background-mount";
import {
  DEFAULT_LEFT_PANEL_GROUPS,
  useLeftPanelStore,
} from "@/stores/epics/left-panel-store";
import {
  prSeenFactsScopeKey,
  selectPrHasChangedDot,
  usePrSeenFactsStore,
} from "@/stores/epics/pr-seen-facts-store";

/**
 * `PrListBackgroundMount`'s dot-clearing effect: the panel's changed dot must
 * clear on any moment the panel is genuinely visible, not only on the
 * false->true EDGE. A ref seeded from the first render's own `panelVisible`
 * value can never observe an already-visible mount (an epic opened straight
 * onto the PR panel) - nor a host switch that leaves the panel visible
 * throughout - as an edge, so both used to leave a stale dot lit forever.
 */

const hostIdRef = vi.hoisted(() => ({ value: "host1" }));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => hostIdRef.value,
}));

const EPIC_ID = "epic-1";
const TAB_ID = "tab-1";

function resetLeftPanelStore(): void {
  window.localStorage.clear();
  useLeftPanelStore.setState({
    activePanelIdByTabId: {},
    panelGroups: DEFAULT_LEFT_PANEL_GROUPS,
    mainCollapsedByTabId: {},
    panelSectionCollapsedByPanelId: {},
    commentsPanelRevealedByTabId: {},
    panelVisibilityOverrideById: {},
    localRootCreatePendingByEpicPanel: {},
    acknowledgedRootCreatePendingByEpicPanel: {},
  });
}

/** Puts the Pull Requests section on-screen for `TAB_ID`: active panel group, expanded. */
function makePullRequestsPanelVisible(): void {
  useLeftPanelStore.getState().setActivePanelId(TAB_ID, "pull-requests");
}

function seedChangedDot(hostId: string): void {
  usePrSeenFactsStore.setState({
    stateByScopeKey: {
      [prSeenFactsScopeKey(hostId, EPIC_ID)]: {
        seeded: true,
        hasChanged: true,
        factsByPrKey: {},
      },
    },
  });
}

function hasChangedDot(hostId: string): boolean {
  return selectPrHasChangedDot(hostId, EPIC_ID)(usePrSeenFactsStore.getState());
}

function renderMount(active: boolean) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <PrListBackgroundMount epicId={EPIC_ID} tabId={TAB_ID} active={active} />
    </QueryClientProvider>,
  );
  return {
    ...view,
    // `useReactiveActiveHostId` is mocked to a plain module ref (not a
    // subscribed store), so a host-id change only takes effect once
    // something forces React to re-render and re-read it.
    rerenderWithSameProps: () => {
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <PrListBackgroundMount
            epicId={EPIC_ID}
            tabId={TAB_ID}
            active={active}
          />
        </QueryClientProvider>,
      );
    },
  };
}

describe("PrListBackgroundMount changed-dot clearing", () => {
  beforeEach(() => {
    resetLeftPanelStore();
    usePrSeenFactsStore.setState({ stateByScopeKey: {} });
    hostIdRef.value = "host1";
  });

  afterEach(() => {
    cleanup();
    resetLeftPanelStore();
    usePrSeenFactsStore.setState({ stateByScopeKey: {} });
  });

  it("clears a pre-existing dot when the panel is ALREADY visible on mount", () => {
    makePullRequestsPanelVisible();
    seedChangedDot("host1");
    expect(hasChangedDot("host1")).toBe(true);

    renderMount(true);

    expect(hasChangedDot("host1")).toBe(false);
  });

  it("clears the new scope's dot across a host switch that leaves the panel visible throughout", () => {
    makePullRequestsPanelVisible();
    seedChangedDot("host1");
    seedChangedDot("host2");

    const mounted = renderMount(true);
    expect(hasChangedDot("host1")).toBe(false);
    expect(hasChangedDot("host2")).toBe(true);

    act(() => {
      hostIdRef.value = "host2";
      mounted.rerenderWithSameProps();
    });

    expect(hasChangedDot("host2")).toBe(false);
  });

  it("does not clear the dot while the panel is not visible", () => {
    seedChangedDot("host1");

    renderMount(true);

    expect(hasChangedDot("host1")).toBe(true);
  });
});
