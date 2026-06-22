import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { getDefaultBindings } from "@/lib/keybindings/actions";

describe("useKeybindingStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
  });

  afterEach(() => {
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
  });

  it("initializes with the default bindings", () => {
    const state = useKeybindingStore.getState();
    expect(state.bindings["epic.switch.byDigit"]).toBe("alt");
    expect(state.bindings["tab.switch.byDigit"]).toBe("mod");
    expect(state.bindings["epic.next"]).toBe("mod+shift+]");
    expect(state.bindings["epic.prev"]).toBe("mod+shift+[");
    expect(state.bindings["tab.next"]).toBe("mod+]");
    expect(state.bindings["tab.prev"]).toBe("mod+[");
    expect(state.bindings["app.settings.section.byDigit"]).toBe("alt");
    expect(state.bindings["group.split.horizontal"]).toBe("mod+d");
    expect(state.bindings["group.split.vertical"]).toBe("mod+shift+d");
    expect(state.bindings["app.sidebar.toggle"]).toBe("mod+b");
  });

  it("setBinding updates an action's chord", () => {
    useKeybindingStore.getState().setBinding("app.settings.open", "mod+alt+s");
    expect(useKeybindingStore.getState().bindings["app.settings.open"]).toBe(
      "mod+alt+s",
    );
  });

  it("clearBinding sets the action to null", () => {
    useKeybindingStore.getState().clearBinding("epic.switch.byDigit");
    expect(
      useKeybindingStore.getState().bindings["epic.switch.byDigit"],
    ).toBeNull();
  });

  it("resetAll restores every default", () => {
    useKeybindingStore.getState().clearBinding("epic.switch.byDigit");
    useKeybindingStore.getState().setBinding("app.settings.open", "mod+alt+s");
    useKeybindingStore.getState().resetAll();
    expect(useKeybindingStore.getState().bindings).toEqual(
      getDefaultBindings(),
    );
  });

  it("persists bindings to the versioned localStorage key", () => {
    useKeybindingStore.getState().setBinding("epic.new", "mod+alt+t");
    const raw = window.localStorage.getItem("traycer-gui-app:keybindings");
    expect(raw).not.toBeNull();
    if (raw === null) return;
    const parsed = JSON.parse(raw) as {
      state: { bindings: Record<string, string | null> };
    };
    expect(parsed.state.bindings["epic.new"]).toBe("mod+alt+t");
  });

  it("rehydrates persisted rebinds via default hydration", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:keybindings",
      JSON.stringify({
        state: {
          bindings: {
            ...getDefaultBindings(),
            "epic.new": "mod+alt+n",
          },
        },
        version: 1,
      }),
    );

    await useKeybindingStore.persist.rehydrate();

    expect(useKeybindingStore.getState().bindings["epic.new"]).toBe(
      "mod+alt+n",
    );
  });

  it("ignores invalid persisted binding keys and values during hydration", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:keybindings",
      JSON.stringify({
        state: {
          bindings: {
            "epic.new": 123,
            "tab.new": ["mod+t"],
            "group.split.horizontal": "mod+alt+h",
            "group.split.vertical": null,
            "unknown.action": "mod+u",
          },
        },
        version: 1,
      }),
    );

    await useKeybindingStore.persist.rehydrate();

    const bindings = useKeybindingStore.getState().bindings;
    expect(bindings["epic.new"]).toBe(getDefaultBindings()["epic.new"]);
    expect(bindings["tab.new"]).toBe(getDefaultBindings()["tab.new"]);
    expect(bindings["group.split.horizontal"]).toBe("mod+alt+h");
    expect(bindings["group.split.vertical"]).toBeNull();
    expect(Object.hasOwn(bindings, "unknown.action")).toBe(false);
  });

  it("migrates the legacy split default pair to right on mod+d and down on mod+shift+d", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:keybindings",
      JSON.stringify({
        state: {
          bindings: {
            ...getDefaultBindings(),
            "group.split.horizontal": "mod+shift+d",
            "group.split.vertical": "mod+d",
          },
        },
        version: 1,
      }),
    );

    await useKeybindingStore.persist.rehydrate();

    expect(
      useKeybindingStore.getState().bindings["group.split.horizontal"],
    ).toBe("mod+d");
    expect(useKeybindingStore.getState().bindings["group.split.vertical"]).toBe(
      "mod+shift+d",
    );
  });

  it("preserves customized split bindings during hydration", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:keybindings",
      JSON.stringify({
        state: {
          bindings: {
            ...getDefaultBindings(),
            "group.split.horizontal": "mod+alt+h",
            "group.split.vertical": "mod+alt+v",
          },
        },
        version: 1,
      }),
    );

    await useKeybindingStore.persist.rehydrate();

    expect(
      useKeybindingStore.getState().bindings["group.split.horizontal"],
    ).toBe("mod+alt+h");
    expect(useKeybindingStore.getState().bindings["group.split.vertical"]).toBe(
      "mod+alt+v",
    );
  });
});
