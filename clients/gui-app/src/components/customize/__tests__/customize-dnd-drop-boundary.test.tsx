import { act, cleanup, render } from "@testing-library/react";
import type { DndContextProps, DragEndEvent } from "@dnd-kit/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustomizeDropSlot } from "@/components/customize/customize-drop-slot";
import {
  CustomizeDnd,
  CustomizeDropTarget,
} from "@/components/customize/customize-dnd";
import { useHotspotRects } from "@/components/customize/use-hotspot-rects";
import { undo } from "@/lib/customize/history";
import type { CustomizeSettingId } from "@/lib/customize/catalog";
import { registerBuiltinCustomizeOptions } from "@/lib/customize/options";
import {
  useCustomizeStore,
  type HotspotInstance,
} from "@/stores/customize/customize-store";
import {
  DEFAULT_COMPOSER_LAYOUT,
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";
import { useSettingsStore } from "@/stores/settings/settings-store";

const track = vi.hoisted(() => vi.fn());
vi.mock("@/components/settings/panels/layout/track-layout-setting", () => ({
  trackLayoutSetting: track,
}));

// Only the DndContext boundary is faked: real pointer sensing is not
// reproducible in jsdom, so capture the callbacks CustomizeDnd hands it and
// invoke them the way dnd-kit would at drop / cancel.
const captured = vi.hoisted(() => ({ props: null as DndContextProps | null }));
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: DndContextProps) => {
      captured.props = props;
      return <>{props.children}</>;
    },
    DragOverlay: () => null,
  };
});

registerBuiltinCustomizeOptions();

const RECT = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };

function endEvent(
  activeId: string,
  overId: string | null,
  group: string | null,
): DragEndEvent {
  return {
    activatorEvent: new Event("pointerdown"),
    active: {
      id: activeId,
      data: { current: undefined },
      rect: { current: { initial: null, translated: null } },
    },
    collisions: null,
    delta: { x: 0, y: 0 },
    over:
      overId === null
        ? null
        : {
            id: overId,
            rect: RECT,
            disabled: false,
            data: { current: { group } },
          },
  };
}

function instance(
  settingId: CustomizeSettingId,
  sceneId: string,
  tileId: string | null,
): HotspotInstance {
  return {
    key: `${settingId}@${sceneId}:${tileId ?? "-"}`,
    settingId,
    sceneId,
    tileId,
    node: document.createElement("div"),
    ghost: false,
    condition: null,
  };
}

function seed(...instances: ReadonlyArray<HotspotInstance>): void {
  useCustomizeStore.setState({
    session: { scene: "in-place", opener: { kind: "none" }, startedAt: 0 },
    instances: new Map(instances.map((entry) => [entry.key, entry])),
    popoverKey: null,
    activeKey: null,
    history: { past: [], future: [] },
    announcement: "",
  });
}

function history() {
  return useCustomizeStore.getState().history;
}

/** Drag `active` and complete it over `over` through the mounted DnD context. */
function completeDrop(
  active: HotspotInstance,
  overId: string | null,
  group: string | null,
): void {
  act(() => {
    captured.props?.onDragStart?.({
      activatorEvent: new Event("pointerdown"),
      active: endEvent(active.key, null, null).active,
    });
    captured.props?.onDragEnd?.(endEvent(active.key, overId, group));
  });
}

function cancelDrop(active: HotspotInstance): void {
  act(() => {
    captured.props?.onDragStart?.({
      activatorEvent: new Event("pointerdown"),
      active: endEvent(active.key, null, null).active,
    });
    captured.props?.onDragCancel?.({
      activatorEvent: new Event("pointerdown"),
      active: endEvent(active.key, null, null).active,
      collisions: null,
      over: null,
      delta: { x: 0, y: 0 },
    });
  });
}

function expectOneGesture(label: string, setting: string): void {
  expect(history().past).toHaveLength(1);
  expect(history().past[0]?.label).toBe(label);
  expect(track).toHaveBeenCalledTimes(1);
  expect(track).toHaveBeenCalledWith(setting);
}

function expectNoGesture(): void {
  expect(history().past).toHaveLength(0);
  expect(track).not.toHaveBeenCalled();
}

const SCENE = "tab-1";
const TILE = "chat-1";

beforeEach(() => {
  track.mockClear();
  captured.props = null;
  useLayoutStore.setState({
    statusBar: DEFAULT_STATUS_BAR_LAYOUT,
    composer: DEFAULT_COMPOSER_LAYOUT,
  });
  useSettingsStore.setState({ chatTurnMinimapSide: "right" });
  render(<CustomizeDnd>{null}</CustomizeDnd>);
});
afterEach(() => {
  cleanup();
  useCustomizeStore.setState({ session: null, instances: new Map() });
});

describe("minimap side drops", () => {
  const minimap = instance("chat.minimapSide", SCENE, TILE);

  it.each([
    ["left", "right"],
    ["right", "left"],
  ] as const)(
    "completing a drop on the %s edge slot sets it with one history entry and one analytics event",
    (side, start) => {
      useSettingsStore.setState({ chatTurnMinimapSide: start });
      seed(minimap);
      completeDrop(minimap, `minimap:${side}@${SCENE}:${TILE}`, "chat-minimap");

      expect(useSettingsStore.getState().chatTurnMinimapSide).toBe(side);
      expectOneGesture("Change minimap side", "chatTurnMinimapSide");
      expect(useCustomizeStore.getState().announcement).toBe(
        `Minimap moved ${side}`,
      );
      act(() => undo());
      expect(useSettingsStore.getState().chatTurnMinimapSide).toBe(start);
      expect(history().past).toHaveLength(0);
    },
  );

  it("a cancelled drag changes nothing", () => {
    seed(minimap);
    cancelDrop(minimap);
    expect(useSettingsStore.getState().chatTurnMinimapSide).toBe("right");
    expectNoGesture();
  });

  it("a drop with the wrong group or no target is silent", () => {
    seed(minimap);
    completeDrop(minimap, `minimap:left@${SCENE}:${TILE}`, "composer-toolbar");
    completeDrop(minimap, null, null);
    expect(useSettingsStore.getState().chatTurnMinimapSide).toBe("right");
    expectNoGesture();
  });
});

describe("resource side drops", () => {
  const resources = instance("statusBar.resources", "shell", null);

  it.each([
    ["left", "right"],
    ["right", "left"],
  ] as const)(
    "dropping on the %s slot sets resourceSide with one entry / one event",
    (side, start) => {
      useLayoutStore.getState().setStatusBarResourceSide(start);
      seed(resources);
      completeDrop(
        resources,
        `resources:${side}@shell:-`,
        "status-bar-resources",
      );

      expect(useLayoutStore.getState().statusBar.resourceSide).toBe(side);
      expectOneGesture(
        "Move resource monitor",
        "layout.statusBar.resourceSide",
      );
      act(() => undo());
      expect(useLayoutStore.getState().statusBar.resourceSide).toBe(start);
    },
  );

  it("a cancelled drag leaves resourceSide alone", () => {
    seed(resources);
    cancelDrop(resources);
    expect(useLayoutStore.getState().statusBar.resourceSide).toBe("right");
    expectNoGesture();
  });
});

describe("usage cluster placement drops", () => {
  it("statusBar.usage handle onto header.usage moves the cluster to the header", () => {
    const usage = instance("statusBar.usage", "shell", null);
    seed(usage);
    completeDrop(usage, "header.usage@shell:-", "status-bar-placement");

    expect(useLayoutStore.getState().statusBar.placement).toBe("header");
    expectOneGesture("Move usage to header", "layout.statusBar.placement");
    act(() => undo());
    expect(useLayoutStore.getState().statusBar.placement).toBe("status-bar");
  });

  it("header.usage onto the footer target moves it back to the status bar", () => {
    useLayoutStore.getState().setStatusBarPlacement("header");
    const header = instance("header.usage", "shell", null);
    seed(header);
    completeDrop(header, "statusBar.placement@shell:-", "status-bar-placement");

    expect(useLayoutStore.getState().statusBar.placement).toBe("status-bar");
    expectOneGesture("Move usage to status bar", "layout.statusBar.placement");
  });

  it("a cancelled drag keeps the placement", () => {
    const usage = instance("statusBar.usage", "shell", null);
    seed(usage);
    cancelDrop(usage);
    expect(useLayoutStore.getState().statusBar.placement).toBe("status-bar");
    expectNoGesture();
  });
});

describe("toolbar end-slot drops", () => {
  const overLeft = `toolbar:left@${SCENE}:${TILE}`;
  const overRight = `toolbar:right@${SCENE}:${TILE}`;
  const toolbar = () => useLayoutStore.getState().composer.toolbar;

  it("attachImage onto the right end slot lands last in the right cluster", () => {
    const attach = instance("composer.attachImage", SCENE, TILE);
    seed(attach);
    completeDrop(attach, overRight, "composer-toolbar");

    expect(toolbar().left).toEqual(["access", "harness"]);
    expect(toolbar().right).toEqual(["model", "mic", "attachImage"]);
    expectOneGesture("Arrange toolbar", "layout.composer.toolbarOrder");
    act(() => undo());
    expect(toolbar().left).toEqual(["attachImage", "access", "harness"]);
  });

  it("an emptied left cluster still receives a drop through its end slot", () => {
    useLayoutStore.getState().setComposerToolbarOrder({
      left: [],
      right: ["attachImage", "access", "harness", "model", "mic"],
    });
    const harness = instance("composer.harness", SCENE, TILE);
    seed(harness);
    completeDrop(harness, overLeft, "composer-toolbar");

    expect(toolbar().left).toEqual(["harness"]);
    expect(toolbar().right).toEqual(["attachImage", "access", "model", "mic"]);
    expectOneGesture("Arrange toolbar", "layout.composer.toolbarOrder");
  });

  it("the model chip refuses the left slot: announced, no history, no analytics", () => {
    const model = instance("composer.model", SCENE, TILE);
    seed(model);
    const before = toolbar();
    completeDrop(model, overLeft, "composer-toolbar");

    expect(toolbar()).toEqual(before);
    expectNoGesture();
    expect(useCustomizeStore.getState().announcement).toBe(
      "The model chip must stay on the right",
    );
  });

  it("the model chip also refuses a target that sits in the left cluster", () => {
    const model = instance("composer.model", SCENE, TILE);
    seed(model);
    completeDrop(model, `composer.access@${SCENE}:${TILE}`, "composer-toolbar");
    expect(toolbar().right).toContain("model");
    expectNoGesture();
    expect(useCustomizeStore.getState().announcement).toBe(
      "The model chip must stay on the right",
    );
  });

  it("a cancelled toolbar drag changes nothing", () => {
    const attach = instance("composer.attachImage", SCENE, TILE);
    seed(attach);
    const before = toolbar();
    cancelDrop(attach);
    expect(toolbar()).toEqual(before);
    expectNoGesture();
  });
});

describe("drop slot markers reach the overlay as measurable droppables", () => {
  function Slots() {
    const measured = useHotspotRects(useCustomizeStore((s) => s.instances));
    return (
      <>
        {measured.slots.map((slot) => (
          <CustomizeDropTarget key={slot.id} slot={slot} />
        ))}
      </>
    );
  }

  it("a marker with a real box becomes a droppable with the surface's id and group", () => {
    seed();
    const rect = new DOMRect(10, 20, 24, 48);
    const proto = Element.prototype;
    const box = vi
      .spyOn(proto, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        return this.hasAttribute("data-customize-drop-slot")
          ? rect
          : new DOMRect();
      });
    const rects = vi
      .spyOn(proto, "getClientRects")
      .mockImplementation(function (this: Element) {
        return this.hasAttribute("data-customize-drop-slot")
          ? Object.assign([rect], { item: () => rect })
          : Object.assign([], { item: () => null });
      });
    try {
      const view = render(
        <>
          <CustomizeDropSlot
            id="minimap:left"
            group="chat-minimap"
            tileId={TILE}
            className="absolute"
          />
          <Slots />
        </>,
      );
      const target = view.container.ownerDocument.querySelector<HTMLElement>(
        '[data-customize-drop-target="minimap:left@shell:chat-1"]',
      );
      expect(target).not.toBeNull();
      expect(target?.style.width).toBe("24px");
      expect(target?.style.height).toBe("48px");
    } finally {
      box.mockRestore();
      rects.mockRestore();
    }
  });
});
