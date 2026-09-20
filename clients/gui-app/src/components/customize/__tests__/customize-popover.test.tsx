import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustomizePopover } from "@/components/customize/customize-popover";
import {
  registerCustomizeOptions,
  type CustomizeControl,
  type CustomizeMove,
  type CustomizeOptions,
} from "@/lib/customize/customize-options";
import type { HotspotInstance } from "@/stores/customize/customize-store";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import {
  DEFAULT_COMPOSER_LAYOUT,
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";

// `composer.mic` is a real catalog entry (`getCustomizeSetting` must resolve
// it), but the CONTROL rendered is entirely this fixture's - the popover
// draws whatever `registerCustomizeOptions` hands back for the instance's
// `settingId`, independent of the catalog's own declared kind.
const SETTING_ID = "composer.mic" as const;

function micInstance(): HotspotInstance {
  return {
    key: "composer.mic@shell:-",
    settingId: SETTING_ID,
    sceneId: "shell",
    tileId: null,
    node: document.createElement("div"),
    ghost: false,
    condition: null,
  };
}

function resetStores(): void {
  useLayoutStore.setState({
    statusBar: DEFAULT_STATUS_BAR_LAYOUT,
    composer: DEFAULT_COMPOSER_LAYOUT,
  });
  useCustomizeStore.setState({
    session: { scene: "in-place", opener: { kind: "none" }, startedAt: 0 },
    instances: new Map(),
    popoverKey: null,
    disclosure: null,
    history: { past: [], future: [] },
  });
}

let unregister: (() => void) | null = null;

beforeEach(resetStores);
afterEach(() => {
  cleanup();
  unregister?.();
  unregister = null;
});

const MOVE_RIGHT: CustomizeMove = {
  id: "move-right",
  label: "Move right",
  announcement: "Moved right",
  disabled: false,
  touches: ["composer"],
  analytics: "layout.composer.mic",
  run: () => {
    useLayoutStore.getState().setComposerPreferences({
      ...useLayoutStore.getState().composer,
      mic: "hidden",
    });
  },
};

function registerFixture(
  changeSpy: (value: string) => void,
  moves: ReadonlyArray<CustomizeMove>,
): void {
  const primary: CustomizeControl = {
    kind: "choice",
    id: "fixture.primary",
    label: "Primary setting",
    touches: ["composer"],
    analytics: "layout.composer.mic",
    value: "a",
    options: [
      {
        value: "a",
        label: "Option A",
        picture: () => <div data-testid="pic-a">A</div>,
        override: {},
      },
      {
        value: "b",
        label: "Option B",
        picture: () => <div data-testid="pic-b">B</div>,
        override: {},
      },
      {
        value: "c",
        label: "Option C",
        picture: () => <div data-testid="pic-c">C</div>,
        override: {},
      },
    ],
    change: changeSpy,
  };
  const more: CustomizeControl = {
    kind: "toggle",
    id: "fixture.more-toggle",
    label: "Toggle setting",
    touches: ["composer"],
    analytics: "layout.composer.mic",
    checked: false,
    pictures: [],
    change: () => undefined,
  };
  const composite: CustomizeControl = {
    kind: "composite",
    id: "fixture.composite",
    label: "Fixture setting",
    touches: ["composer"],
    analytics: "layout.composer.mic",
    primary,
    more: [more],
  };
  const options: CustomizeOptions = {
    state: "Option A",
    control: composite,
    moves,
    drag: null,
  };
  unregister = registerCustomizeOptions(SETTING_ID, () => options);
}

describe("CustomizePopover", () => {
  it("renders each choice option's picture as inert and aria-hidden", () => {
    registerFixture(() => undefined, []);
    const instance = micInstance();
    useCustomizeStore.getState().register(instance);
    useCustomizeStore.setState({ popoverKey: instance.key });
    const rects = new Map([[instance.key, new DOMRect(10, 10, 20, 20)]]);

    render(<CustomizePopover rects={rects} />);

    const picA = screen.getByTestId("pic-a");
    const wrapper = picA.parentElement;
    expect(wrapper?.hasAttribute("inert")).toBe(true);
    expect(wrapper?.getAttribute("aria-hidden")).toBe("true");
  });

  it("picking a choice option writes the store once and pushes exactly one history entry", () => {
    const changeSpy = vi.fn((value: string) => {
      useLayoutStore.getState().setComposerPreferences({
        ...useLayoutStore.getState().composer,
        mic: value === "b" ? "hidden" : "visible",
      });
    });
    registerFixture(changeSpy, []);
    const instance = micInstance();
    useCustomizeStore.getState().register(instance);
    useCustomizeStore.setState({ popoverKey: instance.key });
    const rects = new Map([[instance.key, new DOMRect(10, 10, 20, 20)]]);
    render(<CustomizePopover rects={rects} />);

    fireEvent.click(screen.getByRole("radio", { name: /Option B/ }));

    expect(changeSpy).toHaveBeenCalledTimes(1);
    expect(changeSpy).toHaveBeenCalledWith("b");
    expect(useLayoutStore.getState().composer.mic).toBe("hidden");
    const { history } = useCustomizeStore.getState();
    expect(history.past).toHaveLength(1);
  });

  it("selecting between three options (not just a binary toggle) writes each pick once", () => {
    // `composer.mic` is only ever visible/hidden (2 states), which can't tell
    // a B->C pick apart from a no-op - `reasoningIndicator` genuinely has all
    // three states this fixture's options need.
    const reasoningIndicatorFor: Record<string, "text" | "bars" | "bars-text"> =
      { a: "text", b: "bars", c: "bars-text" };
    const changeSpy = vi.fn((value: string) => {
      useLayoutStore.getState().setComposerPreferences({
        ...useLayoutStore.getState().composer,
        reasoningIndicator: reasoningIndicatorFor[value] ?? "text",
      });
    });
    registerFixture(changeSpy, []);
    const instance = micInstance();
    useCustomizeStore.getState().register(instance);
    useCustomizeStore.setState({ popoverKey: instance.key });
    const rects = new Map([[instance.key, new DOMRect(10, 10, 20, 20)]]);
    render(<CustomizePopover rects={rects} />);
    expect(screen.getAllByRole("radio")).toHaveLength(3);

    fireEvent.click(screen.getByRole("radio", { name: /Option B/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Option C/ }));

    expect(changeSpy).toHaveBeenCalledTimes(2);
    expect(changeSpy).toHaveBeenNthCalledWith(1, "b");
    expect(changeSpy).toHaveBeenNthCalledWith(2, "c");
    expect(useCustomizeStore.getState().history.past).toHaveLength(2);
  });

  it("a keyboard-driven Move action announces the result and records one history entry", async () => {
    registerFixture(() => undefined, [MOVE_RIGHT]);
    const instance = micInstance();
    useCustomizeStore.getState().register(instance);
    useCustomizeStore.setState({ popoverKey: instance.key });
    const rects = new Map([[instance.key, new DOMRect(10, 10, 20, 20)]]);
    render(<CustomizePopover rects={rects} />);
    const user = userEvent.setup();
    const moveButton = screen.getByRole("button", { name: "Move right" });
    moveButton.focus();

    await user.keyboard("{Enter}");

    expect(useLayoutStore.getState().composer.mic).toBe("hidden");
    expect(useCustomizeStore.getState().announcement).toBe("Moved right");
    expect(useCustomizeStore.getState().history.past).toHaveLength(1);
    expect(useCustomizeStore.getState().popoverKey).toBeNull();
  });

  it("the composite's More disclosure starts closed, and opens when the search target lands inside it", () => {
    registerFixture(() => undefined, []);
    const instance = micInstance();
    useCustomizeStore.getState().register(instance);
    useCustomizeStore.setState({ popoverKey: instance.key, disclosure: null });
    const rects = new Map([[instance.key, new DOMRect(10, 10, 20, 20)]]);
    const { unmount } = render(<CustomizePopover rects={rects} />);

    expect(
      screen
        .getByRole("button", { name: "More" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    unmount();

    // A search result naming something inside "More" (the fixture's toggle
    // setting) opens the popover with the disclosure pre-expanded.
    useCustomizeStore.setState({ disclosure: "toggle setting" });
    render(<CustomizePopover rects={rects} />);

    expect(
      screen
        .getByRole("button", { name: "More" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("closing the popover returns focus to the proxy that opened it", async () => {
    registerFixture(() => undefined, []);
    const instance = micInstance();
    useCustomizeStore.getState().register(instance);
    // Matches the real invoker a proxy's own click sets: its own key, not "search".
    useCustomizeStore.setState({
      popoverKey: instance.key,
      invoker: instance.key,
    });
    const rects = new Map([[instance.key, new DOMRect(10, 10, 20, 20)]]);
    const proxy = document.createElement("button");
    proxy.dataset.customizeProxy = instance.key;
    document.body.appendChild(proxy);
    render(<CustomizePopover rects={rects} />);

    act(() => {
      useCustomizeStore.getState().closePopover();
    });

    await waitFor(() => expect(document.activeElement).toBe(proxy));
    proxy.remove();
  });
});
