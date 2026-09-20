import { beforeEach, describe, expect, it } from "vitest";
import {
  consumeCustomizeDragClick,
  resolveCustomizeDrop,
  suppressNextCustomizeClick,
} from "@/lib/customize/drop";
import {
  registerCustomizeOptions,
  type CustomizeDrag,
  type CustomizeMove,
  type CustomizeOptions,
} from "@/lib/customize/customize-options";
import type { HotspotInstance } from "@/stores/customize/customize-store";
import { useCustomizeStore } from "@/stores/customize/customize-store";

const SETTING_ID = "composer.mic" as const;
const MOVE: CustomizeMove = {
  id: "move-right",
  label: "Move right",
  announcement: "Moved right",
  disabled: false,
  touches: ["composer"],
  analytics: "layout.composer.mic",
  run: () => undefined,
};

function dndInstance(key: string): HotspotInstance {
  return {
    key,
    settingId: SETTING_ID,
    sceneId: "shell",
    tileId: null,
    node: document.createElement("div"),
    ghost: false,
    condition: null,
  };
}

let unregister: (() => void) | null = null;

function registerDrag(drag: CustomizeDrag): void {
  const options: CustomizeOptions = {
    state: "",
    control: null,
    moves: [],
    drag,
  };
  unregister = registerCustomizeOptions(SETTING_ID, () => options);
}

beforeEach(() => {
  useCustomizeStore.setState({ instances: new Map() });
  unregister?.();
  unregister = null;
});

describe("resolveCustomizeDrop: cancelled paths", () => {
  it("no drop target -> null", () => {
    expect(resolveCustomizeDrop("a", null, "group")).toBeNull();
  });

  it("dropped on itself -> null", () => {
    expect(resolveCustomizeDrop("a", "a", "group")).toBeNull();
  });

  it("the dragged key is not a registered instance -> null", () => {
    expect(resolveCustomizeDrop("unregistered", "b", "group")).toBeNull();
  });

  it("the instance has no options registered at all (drag descriptor absent) -> null", () => {
    const instance = dndInstance("a");
    useCustomizeStore.getState().register(instance);
    // Nothing registered under SETTING_ID: getCustomizeOptions -> null.
    expect(resolveCustomizeDrop("a", "b", "group")).toBeNull();
  });

  it("the instance has options but no drag descriptor (drag: null) -> null", () => {
    const instance = dndInstance("a");
    useCustomizeStore.getState().register(instance);
    const options: CustomizeOptions = {
      state: "",
      control: null,
      moves: [],
      drag: null,
    };
    unregister = registerCustomizeOptions(SETTING_ID, () => options);

    expect(resolveCustomizeDrop("a", "b", "group")).toBeNull();
  });

  it("the drop target's group does not match the drag's group -> null", () => {
    const instance = dndInstance("a");
    useCustomizeStore.getState().register(instance);
    registerDrag({
      group: "toolbar-left",
      axis: "horizontal",
      resolveDrop: () => MOVE,
    });

    expect(resolveCustomizeDrop("a", "b", "toolbar-right")).toBeNull();
  });

  it("the drag's own resolver rejects the position -> null", () => {
    const instance = dndInstance("a");
    useCustomizeStore.getState().register(instance);
    registerDrag({
      group: "toolbar",
      axis: "horizontal",
      resolveDrop: () => null,
    });

    expect(resolveCustomizeDrop("a", "b", "toolbar")).toBeNull();
  });

  it("a resolved but disabled move -> null", () => {
    const instance = dndInstance("a");
    useCustomizeStore.getState().register(instance);
    registerDrag({
      group: "toolbar",
      axis: "horizontal",
      resolveDrop: () => ({ ...MOVE, disabled: true }),
    });

    expect(resolveCustomizeDrop("a", "b", "toolbar")).toBeNull();
  });
});

describe("resolveCustomizeDrop: valid path", () => {
  it("returns the resolved move when the instance, group and position all line up", () => {
    const instance = dndInstance("a");
    useCustomizeStore.getState().register(instance);
    registerDrag({
      group: "toolbar",
      axis: "horizontal",
      resolveDrop: (overId) => (overId === "b" ? MOVE : null),
    });

    expect(resolveCustomizeDrop("a", "b", "toolbar")).toBe(MOVE);
  });
});

describe("suppress / consume the click that follows a completed drag", () => {
  beforeEach(() => {
    // Drain any pending suppression from a previous case before asserting.
    consumeCustomizeDragClick();
  });

  it("is false with nothing suppressed", () => {
    expect(consumeCustomizeDragClick()).toBe(false);
  });

  it("reads true exactly once after a drag, then resets", () => {
    suppressNextCustomizeClick();

    expect(consumeCustomizeDragClick()).toBe(true);
    expect(consumeCustomizeDragClick()).toBe(false);
  });
});
