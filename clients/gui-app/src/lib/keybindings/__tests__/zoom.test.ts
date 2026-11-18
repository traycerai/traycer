import { afterEach, describe, expect, it } from "vitest";
import { ACTION_META, getDefaultBindings } from "@/lib/keybindings/actions";
import { findActionForChord } from "@/lib/keybindings/dispatch";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";

describe("zoom keybindings", () => {
  afterEach(() => {
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
  });

  it("registers rebindable whole-app zoom actions", () => {
    const bindings = getDefaultBindings();

    expect(ACTION_META["app.zoom.in"].category).toBe("app");
    expect(ACTION_META["app.zoom.out"].category).toBe("app");
    expect(ACTION_META["app.zoom.reset"].category).toBe("app");
    expect(bindings["app.zoom.in"]).toBe("mod+=");
    expect(bindings["app.zoom.out"]).toBe("mod+-");
    expect(bindings["app.zoom.reset"]).toBe("mod+0");
  });

  it("honors rebinding and releases the old zoom chord", () => {
    useKeybindingStore.setState({
      bindings: {
        ...getDefaultBindings(),
        "app.zoom.in": "mod+shift+=",
      },
    });

    expect(findActionForChord("mod+=")).toBeNull();
    expect(findActionForChord("mod+shift+=")).toBe("app.zoom.in");
  });
});
