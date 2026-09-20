import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * NEW FILE: drives the real `statusBar.resources` composite control through
 * the real `CustomizePopover`, the same "real popover" idiom
 * `context-usage-chip-customize.test.tsx` and
 * `composer-mic-hotspot-geometry-customize.test.tsx` already use.
 *
 * Wave-3 fixup regressions this covers (review w3):
 * - Should-fix 1: the resources control was missing its Scope leaf and its
 *   Metrics leaf's controls; both are exercised here against the real
 *   popover's rendered form.
 * - Should-fix 4 + the "already-required drag gaps" table: Move
 *   left/right now actually flips `resourceSide` (app-status-bar.tsx reads
 *   it); covered here at the option/popover boundary (the DOM-render half -
 *   which side the segment actually lands on - is covered by the
 *   app-status-bar-customize appendix).
 * - Should-fix 13: status structural changes used to report the WRONG
 *   analytics id (side/metrics/scope all reused
 *   `layout.statusBar.resources.enabled`). Each assertion below checks the
 *   id `trackLayoutSetting` was actually called with.
 * - Blocking 3 (nested gesture recording / duplicate undo entries): every
 *   assertion also checks `history.past` has exactly ONE entry per real
 *   gesture, not two.
 */

vi.mock("@/components/settings/panels/layout/track-layout-setting", () => ({
  trackLayoutSetting: vi.fn(),
}));

import { trackLayoutSetting } from "@/components/settings/panels/layout/track-layout-setting";
import { CustomizePopover } from "@/components/customize/customize-popover";
import { registerStatusBarCustomizeOptions } from "@/lib/customize/options/status-bar-options";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import type { HotspotInstance } from "@/stores/customize/customize-store";
import {
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";

registerStatusBarCustomizeOptions();

function resourcesInstance(): HotspotInstance {
  return {
    key: "statusBar.resources@shell:-",
    settingId: "statusBar.resources",
    sceneId: "shell",
    tileId: null,
    node: document.createElement("div"),
    ghost: false,
    condition: null,
  };
}

/** Same two-step other w3 suites use: register the real instance, point the
 *  popover's key at it, render `<CustomizePopover>` against a fixture rect. */
function openResourcesPopover(): void {
  const instance = resourcesInstance();
  useCustomizeStore.getState().register(instance);
  useCustomizeStore.setState({ popoverKey: instance.key });
  const rects = new Map([[instance.key, new DOMRect(0, 0, 20, 20)]]);
  render(<CustomizePopover rects={rects} />);
}

beforeEach(() => {
  useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
  useCustomizeStore.setState({
    session: { scene: "in-place", opener: { kind: "none" }, startedAt: 0 },
    instances: new Map(),
    activeKey: null,
    popoverKey: null,
    invoker: null,
    disclosure: null,
    pendingTarget: null,
    preferredTileId: null,
    history: { past: [], future: [] },
  });
  vi.mocked(trackLayoutSetting).mockClear();
});
afterEach(() => {
  cleanup();
  useCustomizeStore.setState({ session: null });
  useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
});

describe("statusBar.resources composite through the real popover", () => {
  it("toggling a metric writes one history entry and the metric analytics id, not the enabled id", () => {
    openResourcesPopover();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    // DEFAULT_STATUS_BAR_RESOURCES.metrics is ["cpu", "processes"]; CPU is
    // checked, so this click UNCHECKS it.
    fireEvent.click(screen.getByRole("checkbox", { name: "CPU" }));

    expect(useLayoutStore.getState().statusBar.resources.metrics).not.toContain(
      "cpu",
    );
    expect(useCustomizeStore.getState().history.past).toHaveLength(1);
    expect(vi.mocked(trackLayoutSetting)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(trackLayoutSetting)).toHaveBeenCalledWith(
      "layout.statusBar.resources.metric",
    );
  });

  it("changing scope writes one history entry and the scope analytics id, not the enabled id", () => {
    openResourcesPopover();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("radio", { name: "Desktop app" }));

    expect(useLayoutStore.getState().statusBar.resources.scope).toBe(
      "desktop-app",
    );
    expect(useCustomizeStore.getState().history.past).toHaveLength(1);
    expect(vi.mocked(trackLayoutSetting)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(trackLayoutSetting)).toHaveBeenCalledWith(
      "layout.statusBar.resources.scope",
    );
  });

  it("Move (resource side) writes one history entry and the resourceSide analytics id, not the enabled id", () => {
    // Default resourceSide is "right", so the Move button reads "Move to
    // left".
    openResourcesPopover();
    fireEvent.click(screen.getByRole("button", { name: "Move to left" }));

    expect(useLayoutStore.getState().statusBar.resourceSide).toBe("left");
    expect(useCustomizeStore.getState().history.past).toHaveLength(1);
    expect(vi.mocked(trackLayoutSetting)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(trackLayoutSetting)).toHaveBeenCalledWith(
      "layout.statusBar.resourceSide",
    );
  });

  it("the primary enabled toggle still reports its own id and exactly one history entry", () => {
    openResourcesPopover();
    fireEvent.click(screen.getByRole("switch", { name: "Resource monitor" }));

    expect(useLayoutStore.getState().statusBar.resources.enabled).toBe(false);
    expect(useCustomizeStore.getState().history.past).toHaveLength(1);
    expect(vi.mocked(trackLayoutSetting)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(trackLayoutSetting)).toHaveBeenCalledWith(
      "layout.statusBar.resources.enabled",
    );
  });
});
