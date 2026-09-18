import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

/**
 * NEW FILE. Mounts the REAL `StatusBarGhost` + REAL `CustomizeOverlay`
 * (real `useHotspotRects` geometry, real proxies, real `CustomizePopover`) -
 * same idiom `composer-mic-hotspot-geometry-customize.test.tsx` uses for
 * composer.mic - so a regression in the ghost, the proxy geometry hook, or
 * the popover shows up here instead of only in a factory-level unit test.
 *
 * D14 (landed in status-bar-options.ts's `footerControls()` /
 * `footerProvidersControl()` / `resourceMetricsControl()`, confirmed with
 * the implementer): the `statusBar.placement` ghost's popover renders a
 * "Status bar" group (`statusBar.footer`) containing the placement choice
 * and a nested "Shown when placement is Status bar" group
 * (`statusBar.footerOnly`) with, in order: the Usage limits toggle,
 * Percentage / Mode word / Timer / Mini bar (`footerDisplayControls`), a
 * "Providers" checklist with per-item Move up/down
 * (`footerProvidersControl`), and a "Metrics" checklist
 * (`resourceMetricsControl`, same id/options as `statusBar.resources.metrics`).
 * Placement is `header` for this scenario - per `status-bar-ghost.tsx`'s own
 * doc comment, that's exactly when this ghost (rather than the live footer
 * segments) is the only way back to these settings, which is why D14
 * duplicates Providers/Metrics into this group instead of requiring the
 * now-unmounted per-provider hotspots.
 *
 * UPDATE (post-landing correction from the implementer): `footerProvidersControl`
 * does NOT read `segmentOrder` verbatim - it merges the saved order into the
 * FULL canonical rate-limit-capable provider list
 * (`mergeOrder(savedOrder, canonical)`, `canonical` = `ORDERED_PROVIDERS`
 * narrowed through `rateLimitCapableProviderIdSchema`), the same reconciliation
 * `applySegmentOrder` already does for the live cluster. A saved order of only
 * `["codex", "opencode"]` therefore still renders EVERY rate-limit-capable
 * provider (codex's real neighbour is whichever canonical provider merges in
 * right after it - claude-code, not opencode), so the move test below derives
 * its expectations from the real `mergeOrder`/`ORDERED_PROVIDERS` building
 * blocks rather than hand-transcribing the merged list, and checks the
 * RENDERED checklist order (not just the store) before and after the move.
 * `history.before` is still the literal pre-mutation snapshot
 * (`["codex", "opencode"]`, what was actually saved), so Undo restores
 * exactly that two-item array even though the merged/rendered list is longer -
 * `recordGesture`'s snapshot/restore never sees the merge.
 *
 * Both new checklists are asserted through a real checkbox/button click, not
 * the option factory directly, and every gesture checks the
 * single-recording-owner invariant (blocking 3: one `history.past` entry,
 * one `trackLayoutSetting` call with the SPECIFIC id - not
 * `layout.statusBar.rateLimits.enabled` reused, should-fix 13) plus Undo.
 */

vi.mock("@/components/settings/panels/layout/track-layout-setting", () => ({
  trackLayoutSetting: vi.fn(),
}));

import { trackLayoutSetting } from "@/components/settings/panels/layout/track-layout-setting";
import { StatusBarGhost } from "@/components/layout/status-bar/status-bar-ghost";
import { CustomizeOverlay } from "@/components/customize/customize-overlay";
import { undo } from "@/lib/customize/history";
import { registerStatusBarCustomizeOptions } from "@/lib/customize/options/status-bar-options";
import { mergeOrder } from "@/lib/order-merge";
import {
  ORDERED_PROVIDERS,
  providerDisplayName,
} from "@/lib/provider-ordering";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import { rateLimitCapableProviderIdSchema } from "@traycer/protocol/host/rate-limit";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import {
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";

registerStatusBarCustomizeOptions();

/**
 * The exact merge the real `footerProvidersControl` does - built from the
 * same three primitives it imports (`ORDERED_PROVIDERS`,
 * `rateLimitCapableProviderIdSchema`, `mergeOrder`), so this expectation
 * tracks a future catalog change instead of going stale the moment a new
 * rate-limit-capable provider is added.
 */
function canonicalProviderOrder(): ReadonlyArray<RateLimitProviderId> {
  return ORDERED_PROVIDERS.flatMap(({ providerId }) => {
    const id = rateLimitCapableProviderIdSchema.options.find(
      (candidate) => candidate === providerId,
    );
    return id === undefined ? [] : [id];
  });
}
function expectedProviderOrder(
  saved: ReadonlyArray<string>,
): ReadonlyArray<RateLimitProviderId> {
  return mergeOrder(saved, canonicalProviderOrder());
}

// jsdom does no layout, so a plain node measures as an all-zero rect and the
// REAL `useHotspotRects` would (correctly) call it unreachable. Stub the two
// DOM reads the hook uses - same technique as
// `composer-mic-hotspot-geometry-customize.test.tsx` / `customize-overlay.test.tsx`.
function stubRect(
  node: HTMLElement,
  rect: { x: number; y: number; width: number; height: number },
): void {
  node.getBoundingClientRect = () =>
    new DOMRect(rect.x, rect.y, rect.width, rect.height);
  node.getClientRects = () => {
    const measured = new DOMRect(rect.x, rect.y, rect.width, rect.height);
    return Object.assign([measured], {
      item: (index: number) => (index === 0 ? measured : null),
    });
  };
}

function proxyFor(key: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    `[data-customize-proxy="${key}"]`,
  );
}

/** Rendered provider display names, in DOM order, read off the checklist's
 *  own `<label>` text - the same box the popover renders, not the store. */
function renderedProviderNames(
  providersGroup: HTMLElement,
): ReadonlyArray<string> {
  return within(providersGroup)
    .getAllByRole("checkbox")
    .map((checkbox) => checkbox.closest("label")?.textContent.trim() ?? "");
}

function resetStores(): void {
  useLayoutStore.setState({
    statusBar: {
      ...DEFAULT_STATUS_BAR_LAYOUT,
      placement: "header",
      // Only these two are "saved" - the rest of the rendered checklist
      // comes from the merge with the canonical catalog, which is the whole
      // point of this fixture.
      segmentOrder: ["codex", "opencode"],
    },
  });
  useCustomizeStore.setState({
    session: {
      scene: "in-place",
      opener: { kind: "none" },
      startedAt: Date.now(),
    },
    instances: new Map(),
    activeKey: null,
    popoverKey: null,
    invoker: null,
    disclosure: null,
    pendingTarget: null,
    history: { past: [], future: [] },
  });
}

/** Renders the real ghost + overlay, stubs its geometry, and clicks its
 *  proxy open - the real overlay->popover path, not a hand-built instance.
 *  Also used to re-open a FRESH popover mount after a mutation, since the
 *  popover doesn't reactively re-render off a plain layout-store write
 *  (same reason `context-usage-chip-customize.test.tsx` re-mounts to check
 *  post-gesture rendered order rather than re-querying the same popover). */
async function openFooterGhostPopover(): Promise<{
  readonly key: string;
  readonly providersGroup: HTMLElement;
}> {
  render(
    <>
      <StatusBarGhost />
      <CustomizeOverlay />
    </>,
  );
  const ghost = screen.getByTestId("status-bar-ghost");
  stubRect(ghost, { x: 0, y: 0, width: 300, height: 24 });
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
  const key = [...useCustomizeStore.getState().instances.keys()].find((k) =>
    k.startsWith("statusBar.placement@"),
  );
  if (!key) throw new Error("statusBar.placement did not register");
  await waitFor(() => expect(proxyFor(key)).not.toBeNull());
  const proxy = proxyFor(key);
  if (!proxy) throw new Error("statusBar.placement proxy missing");
  fireEvent.click(proxy);
  expect(useCustomizeStore.getState().popoverKey).toBe(key);
  const providersGroup = screen.getByRole("group", { name: "Providers" });
  return { key, providersGroup };
}

beforeEach(resetStores);
afterEach(() => {
  act(() => {
    useCustomizeStore.setState({ session: null });
  });
  cleanup();
  document.body.innerHTML = "";
  useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
  vi.clearAllMocks();
});

describe("statusBar.placement footer ghost, real overlay -> popover (D14)", () => {
  it("the footer-only group carries Percentage/Mode word/Timer/Mini bar plus a Providers checklist (with Move) and a Metrics checklist", async () => {
    const { providersGroup } = await openFooterGhostPopover();

    const footerOnly = screen.getByRole("group", {
      name: "Shown when placement is Status bar",
    });
    expect(
      within(footerOnly).getByRole("radiogroup", { name: "Percentage" }),
    ).not.toBeNull();
    expect(
      within(footerOnly).getByRole("switch", { name: "Mode word" }),
    ).not.toBeNull();
    expect(
      within(footerOnly).getByRole("switch", { name: "Timer" }),
    ).not.toBeNull();
    expect(
      within(footerOnly).getByRole("switch", { name: "Mini bar" }),
    ).not.toBeNull();

    // Merged, not just the two "saved" ids - the whole rate-limit-capable
    // catalog is a row here, so it can be shown/hidden/reordered without
    // ever needing a live per-provider hotspot.
    const canonical = canonicalProviderOrder();
    expect(canonical.length).toBeGreaterThan(2);
    expect(renderedProviderNames(providersGroup)).toEqual(
      canonical.map(providerDisplayName),
    );
    expect(
      within(providersGroup).getByRole("checkbox", { name: "Codex" }),
    ).not.toBeNull();
    // Per-item Move buttons prove `moveItem` is wired here, unlike the
    // Metrics checklist beside it.
    expect(
      within(providersGroup).getByRole("group", { name: "Move Codex" }),
    ).not.toBeNull();

    const metrics = within(footerOnly).getByRole("group", { name: "Metrics" });
    expect(
      within(metrics).getByRole("checkbox", { name: "CPU" }),
    ).not.toBeNull();
    expect(
      within(metrics).queryByRole("group", { name: "Move CPU" }),
    ).toBeNull();
  });

  it("toggling a metric in the footer Metrics checklist writes one history entry and the metric analytics id, then Undo restores it", async () => {
    await openFooterGhostPopover();

    // DEFAULT_STATUS_BAR_RESOURCES.metrics is ["cpu", "processes"] - CPU is
    // checked, so this click UNCHECKS it.
    const metrics = screen.getByRole("group", { name: "Metrics" });
    fireEvent.click(within(metrics).getByRole("checkbox", { name: "CPU" }));

    expect(useLayoutStore.getState().statusBar.resources.metrics).not.toContain(
      "cpu",
    );
    expect(useCustomizeStore.getState().history.past).toHaveLength(1);
    expect(vi.mocked(trackLayoutSetting)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(trackLayoutSetting)).toHaveBeenCalledWith(
      "layout.statusBar.resources.metric",
    );

    act(() => undo());
    expect(useLayoutStore.getState().statusBar.resources.metrics).toContain(
      "cpu",
    );
    expect(useCustomizeStore.getState().history.past).toHaveLength(0);
  });

  it("moving Codex in the footer Providers checklist swaps it with its actual merged neighbour, updates the rendered order, and Undo restores the original SAVED order", async () => {
    const savedOrder = ["codex", "opencode"];
    const before = expectedProviderOrder(savedOrder);
    const codexIndex = before.indexOf("codex");
    // Sanity on the fixture premise the coordinator flagged: codex's real
    // next neighbour in the merged catalog is not necessarily "opencode".
    const actualNeighbour = before[codexIndex + 1];
    expect(actualNeighbour).toBeDefined();

    const { providersGroup } = await openFooterGhostPopover();
    expect(renderedProviderNames(providersGroup)).toEqual(
      before.map(providerDisplayName),
    );

    const moveCodex = within(providersGroup).getByRole("group", {
      name: "Move Codex",
    });
    // Codex sits first in the merged order, so "Move up" is disabled and
    // "Move down" is the one real swap available.
    fireEvent.click(
      within(moveCodex).getByRole("button", { name: "Move down" }),
    );

    const after = [...before];
    after[codexIndex] = actualNeighbour;
    after[codexIndex + 1] = "codex";

    expect(useLayoutStore.getState().statusBar.segmentOrder).toEqual(after);
    expect(useCustomizeStore.getState().history.past).toHaveLength(1);
    expect(vi.mocked(trackLayoutSetting)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(trackLayoutSetting)).toHaveBeenCalledWith(
      "layout.statusBar.segmentOrder",
    );

    expect(renderedProviderNames(providersGroup)).toEqual(
      after.map(providerDisplayName),
    );

    act(() => undo());
    // `recordGesture`'s snapshot is the literal pre-mutation store value -
    // the two-item SAVED order, not the merged/rendered list - so Undo
    // restores exactly what was there before this test seeded it.
    expect(useLayoutStore.getState().statusBar.segmentOrder).toEqual(
      savedOrder,
    );
    expect(useCustomizeStore.getState().history.past).toHaveLength(0);
  });
});
