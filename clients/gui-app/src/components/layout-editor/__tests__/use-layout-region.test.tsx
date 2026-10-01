import { act, cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { useLayoutRegion } from "@/components/layout-editor/use-layout-region";
import type { RegionId } from "@/lib/layout/region-id";
import {
  preferredRegionInstance,
  useLayoutEditorStore,
} from "@/stores/layout/layout-editor-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

function Region(props: {
  regionId: RegionId;
  instanceId: string | null;
  testId: string;
}): ReactElement {
  const { ref } = useLayoutRegion({
    regionId: props.regionId,
    instanceId: props.instanceId,
  });
  return <div ref={ref} data-testid={props.testId} />;
}

/**
 * Reports what the hook says about the ghost on the node itself, so a test can
 * read the returned `ghost` and the `data-ghost` the hook stamped side by side.
 * The two are separate writes: one is a render value, the other a DOM attribute
 * written after the commit.
 */
function GhostProbe(props: {
  regionId: RegionId;
  testId: string;
}): ReactElement {
  const { ref, ghost } = useLayoutRegion({
    regionId: props.regionId,
    instanceId: null,
  });
  return (
    <div
      ref={ref}
      data-testid={props.testId}
      data-reported-ghost={`${ghost}`}
    />
  );
}

function openSession(): void {
  act(() => {
    useLayoutEditorStore.getState().beginSession({
      entry: "pointer",
      source: "direct_ui",
      startedAt: 0,
      origin: { kind: "tab" },
    });
  });
}

beforeEach(() => {
  useLayoutEditorStore.getState().endSession();
  useLayoutEditorStore.setState({ instances: new Map() });
});

afterEach(() => {
  cleanup();
  useLayoutEditorStore.getState().endSession();
});

describe("registration", () => {
  it("registers only while a session is live", () => {
    const view = render(
      <Region regionId="minimap" instanceId="tile-a" testId="minimap" />,
    );
    const node = view.getByTestId("minimap");

    expect(
      preferredRegionInstance(useLayoutEditorStore.getState(), "minimap"),
    ).toBeNull();

    openSession();

    expect(
      preferredRegionInstance(useLayoutEditorStore.getState(), "minimap")?.node,
    ).toBe(node);

    act(() => {
      useLayoutEditorStore.getState().endSession();
    });

    expect(
      preferredRegionInstance(useLayoutEditorStore.getState(), "minimap"),
    ).toBeNull();
  });

  /**
   * L-129. The right-click menu resolves the region it landed on from the DOM,
   * so a name that only exists inside a session is a menu that only exists
   * inside a session - which is what made the quick verbs (L-19) unreachable
   * everywhere in the product. The name is a fact about the element; only the
   * registration is a fact about the session.
   */
  it("names the node at rest, before any session and after one ends", () => {
    const view = render(
      <Region regionId="minimap" instanceId="tile-a" testId="minimap" />,
    );
    const node = view.getByTestId("minimap");

    expect(node.getAttribute("data-layout-region")).toBe("minimap");
    expect(node.getAttribute("data-layout-instance")).toBe("tile-a");

    openSession();
    expect(node.getAttribute("data-layout-region")).toBe("minimap");

    act(() => {
      useLayoutEditorStore.getState().endSession();
    });

    expect(node.getAttribute("data-layout-region")).toBe("minimap");
  });

  it("leaves a hidden pane's copy out of the editor, and unnamed", () => {
    openSession();
    const view = render(
      <PaneVisibilityContext value={false}>
        <Region regionId="mic" instanceId="tile-a" testId="mic" />
      </PaneVisibilityContext>,
    );

    // Unnamed as well as unregistered: a second element carrying the same
    // region name is one `closest` could resolve a menu to.
    expect(view.getByTestId("mic").hasAttribute("data-layout-region")).toBe(
      false,
    );
    expect(
      preferredRegionInstance(useLayoutEditorStore.getState(), "mic"),
    ).toBeNull();
  });

  it("unregisters and leaves the app's element as it was found", () => {
    openSession();
    const view = render(
      <Region regionId="mic" instanceId={null} testId="mic" />,
    );
    const node = view.getByTestId("mic");
    expect(node.getAttribute("data-layout-region")).toBe("mic");

    view.unmount();

    expect(
      preferredRegionInstance(useLayoutEditorStore.getState(), "mic"),
    ).toBeNull();
    expect(node.attributes.length).toBe(1);
    expect(node.getAttribute("data-testid")).toBe("mic");
  });
});

describe("decoration", () => {
  it("lights up every instance of a hovered region (L-23)", () => {
    openSession();
    const view = render(
      <>
        <Region regionId="minimap" instanceId="tile-a" testId="a" />
        <Region regionId="minimap" instanceId="tile-b" testId="b" />
        <Region regionId="mic" instanceId="tile-a" testId="other" />
      </>,
    );

    act(() => {
      useLayoutEditorStore.getState().setHovered("minimap");
    });

    expect(view.getByTestId("a").getAttribute("data-hover")).toBe("1");
    expect(view.getByTestId("b").getAttribute("data-hover")).toBe("1");
    expect(view.getByTestId("other").hasAttribute("data-hover")).toBe(false);
  });

  it("anchors exactly one instance per role (C-12)", () => {
    openSession();
    const view = render(
      <>
        <Region regionId="minimap" instanceId="tile-a" testId="a" />
        <Region regionId="minimap" instanceId="tile-b" testId="b" />
      </>,
    );

    act(() => {
      useLayoutEditorStore.getState().setHovered("minimap");
    });

    expect(view.getByTestId("b").hasAttribute("data-layout-anchor")).toBe(
      false,
    );
    expect(view.getByTestId("a").getAttribute("data-layout-anchor")).toBe(
      "hover",
    );

    act(() => {
      useLayoutEditorStore.getState().select("minimap");
    });

    // Still one instance, and now one role: the selection takes the hover's
    // place rather than joining it (C-08).
    expect(view.getByTestId("b").hasAttribute("data-layout-anchor")).toBe(
      false,
    );
    expect(view.getByTestId("a").getAttribute("data-layout-anchor")).toBe(
      "selected",
    );
  });

  it("takes the hover decoration off a region once it is selected (C-08)", () => {
    // The ring is the one signal for a selection. The pointer is still over
    // the region it just selected, so this has to be derived rather than
    // cleared once - and it is derived in ONE place, so the attributes here
    // and the chip the canvas shows can never disagree.
    openSession();
    const view = render(
      <>
        <Region regionId="minimap" instanceId="tile-a" testId="a" />
        <Region regionId="minimap" instanceId="tile-b" testId="b" />
      </>,
    );
    act(() => {
      useLayoutEditorStore.getState().setHovered("minimap");
    });
    expect(view.getByTestId("a").getAttribute("data-hover")).toBe("1");

    act(() => {
      useLayoutEditorStore.getState().select("minimap");
    });

    expect(view.getByTestId("a").hasAttribute("data-hover")).toBe(false);
    expect(view.getByTestId("b").hasAttribute("data-hover")).toBe(false);
    expect(view.getByTestId("a").getAttribute("data-selected")).toBe("1");
    expect(useLayoutEditorStore.getState().hovered).toBe("minimap");
  });

  it("keeps the hover anchor and the selection anchor apart", () => {
    openSession();
    const view = render(
      <>
        <Region regionId="minimap" instanceId={null} testId="minimap" />
        <Region regionId="mic" instanceId={null} testId="mic" />
      </>,
    );

    act(() => {
      useLayoutEditorStore.getState().select("minimap");
      useLayoutEditorStore.getState().setHovered("mic");
    });

    expect(view.getByTestId("minimap").getAttribute("data-layout-anchor")).toBe(
      "selected",
    );
    expect(view.getByTestId("mic").getAttribute("data-layout-anchor")).toBe(
      "hover",
    );
  });

  it("moves the anchor onto the surviving instance when the anchored one goes", () => {
    openSession();
    const view = render(
      <>
        <Region regionId="minimap" instanceId="tile-a" testId="a" />
        <Region regionId="minimap" instanceId="tile-b" testId="b" />
      </>,
    );
    act(() => {
      useLayoutEditorStore.getState().select("minimap");
    });
    expect(view.getByTestId("a").getAttribute("data-layout-anchor")).toBe(
      "selected",
    );

    view.rerender(<Region regionId="minimap" instanceId="tile-b" testId="b" />);

    expect(view.getByTestId("b").getAttribute("data-layout-anchor")).toBe(
      "selected",
    );
  });
});

/**
 * A transcript can hold a timestamp per message, so hovering the region must
 * cost work per INSTANCE, not per instance squared: each instance decides
 * whether it is the on-screen anchor, and that decision used to re-measure
 * every other instance (1600 rect reads for 40 stamps).
 */
describe("a region with many instances", () => {
  const COUNT = 40;
  const hadElementFromPoint = "elementFromPoint" in document;

  afterEach(() => {
    vi.restoreAllMocks();
    if (hadElementFromPoint) return;
    Reflect.deleteProperty(document, "elementFromPoint");
  });

  it("measures each instance once on hover, and anchors exactly the on-screen one", () => {
    const view = render(
      <>
        {Array.from({ length: COUNT }, (_, index) => (
          <Region
            key={index}
            regionId="timestamps"
            instanceId={`stamp-${index}`}
            testId={`stamp-${index}`}
          />
        ))}
      </>,
    );
    openSession();
    const last = view.getByTestId(`stamp-${COUNT - 1}`);
    // Every other instance is scrolled off screen: only the last one is what
    // a hit test at its point finds.
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      writable: true,
      value: () => last,
    });
    const rects = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(() => new DOMRect(5, 5, 10, 10));

    act(() => {
      useLayoutEditorStore.getState().setHovered("timestamps");
    });

    expect(rects.mock.calls.length).toBeGreaterThan(0);
    expect(rects.mock.calls.length).toBeLessThanOrEqual(COUNT);
    const anchored = view.container.querySelectorAll(
      '[data-layout-anchor~="hover"]',
    );
    expect(anchored).toHaveLength(1);
    expect(anchored[0]).toBe(last);
  });
});

/**
 * L-14. A region the user HID is not on the canvas at rest, and materialises
 * in place only while the editor points at it - its index row hovered, or the
 * region selected. All three conjuncts are the claim: hidden, pointed at, and
 * in a session. Each test below holds the other two true so it can only be
 * decided by the one it names.
 */
describe("the ghost of a hidden region", () => {
  function hide(regionId: "mic" | "minimap"): void {
    act(() => {
      useLayoutStore.getState().setRegionValues(regionId, { shown: "hidden" });
    });
  }

  function reported(node: HTMLElement): string | null {
    return node.getAttribute("data-reported-ghost");
  }

  beforeEach(() => {
    useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  });

  afterEach(() => {
    useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  });

  it("reports ghost and stamps data-ghost on the node while a Hidden region's index row is hovered", () => {
    const view = render(<GhostProbe regionId="mic" testId="mic" />);
    const node = view.getByTestId("mic");
    openSession();
    hide("mic");
    // Hidden but not pointed at: the control for what follows.
    expect(reported(node)).toBe("false");
    expect(node.hasAttribute("data-ghost")).toBe(false);

    act(() => {
      useLayoutEditorStore.getState().setHovered("mic");
    });

    expect(reported(node)).toBe("true");
    expect(node.getAttribute("data-ghost")).toBe("1");
  });

  it("takes the ghost away again the moment the pointer leaves the index row", () => {
    const view = render(<GhostProbe regionId="mic" testId="mic" />);
    const node = view.getByTestId("mic");
    openSession();
    hide("mic");
    act(() => {
      useLayoutEditorStore.getState().setHovered("mic");
    });
    expect(node.getAttribute("data-ghost")).toBe("1");

    act(() => {
      useLayoutEditorStore.getState().setHovered(null);
    });

    expect(reported(node)).toBe("false");
    expect(node.hasAttribute("data-ghost")).toBe(false);
  });

  it("ghosts a Hidden region that is selected, not only hovered", () => {
    const view = render(<GhostProbe regionId="mic" testId="mic" />);
    const node = view.getByTestId("mic");
    openSession();
    hide("mic");

    act(() => {
      useLayoutEditorStore.getState().select("mic");
    });

    expect(reported(node)).toBe("true");
    expect(node.getAttribute("data-ghost")).toBe("1");
  });

  it("never ghosts a region that is not hidden, under the same pointing", () => {
    // Two regions pointed at at once - one hovered, one selected - and only
    // the one the user hid is asked for. A shown region is already on screen,
    // and stamping it would dim a real control to look like a preview.
    const view = render(
      <>
        <GhostProbe regionId="mic" testId="hidden-mic" />
        <GhostProbe regionId="minimap" testId="shown-minimap" />
      </>,
    );
    const hiddenMic = view.getByTestId("hidden-mic");
    const shownMinimap = view.getByTestId("shown-minimap");
    openSession();
    hide("mic");

    act(() => {
      useLayoutEditorStore.getState().select("mic");
      useLayoutEditorStore.getState().setHovered("minimap");
    });

    expect(hiddenMic.getAttribute("data-ghost")).toBe("1");
    expect(reported(shownMinimap)).toBe("false");
    expect(shownMinimap.hasAttribute("data-ghost")).toBe(false);
  });

  it("follows the Hidden value: showing the region again takes the ghost off while it is still hovered", () => {
    const view = render(<GhostProbe regionId="mic" testId="mic" />);
    const node = view.getByTestId("mic");
    openSession();
    hide("mic");
    act(() => {
      useLayoutEditorStore.getState().setHovered("mic");
    });
    expect(node.getAttribute("data-ghost")).toBe("1");

    act(() => {
      useLayoutStore.getState().setRegionValues("mic", { shown: "shown" });
    });

    expect(useLayoutEditorStore.getState().hovered).toBe("mic");
    expect(reported(node)).toBe("false");
    expect(node.hasAttribute("data-ghost")).toBe(false);
  });

  it("draws no ghost for a Hidden region at rest, with a session open and nothing pointed at", () => {
    const view = render(<GhostProbe regionId="mic" testId="mic" />);
    const node = view.getByTestId("mic");
    openSession();
    hide("mic");

    expect(useLayoutEditorStore.getState().hovered).toBeNull();
    expect(useLayoutEditorStore.getState().selected).toBeNull();
    expect(reported(node)).toBe("false");
    expect(node.hasAttribute("data-ghost")).toBe(false);

    // The same Hidden region under a hover does ghost, so the absence above is
    // the missing pointer's doing and not a region that can never ghost.
    act(() => {
      useLayoutEditorStore.getState().setHovered("mic");
    });
    expect(reported(node)).toBe("true");
  });

  it("asks for no ghost outside a session, even for a Hidden region the store still says is hovered", () => {
    const view = render(<GhostProbe regionId="mic" testId="mic" />);
    const node = view.getByTestId("mic");
    hide("mic");

    act(() => {
      useLayoutEditorStore.setState({ hovered: "mic" });
    });

    expect(useLayoutEditorStore.getState().session).toBeNull();
    expect(reported(node)).toBe("false");
    expect(node.hasAttribute("data-ghost")).toBe(false);

    // The same hover inside a session ghosts, so the absence above is the
    // missing session's doing and not a region that can never ghost.
    openSession();
    act(() => {
      useLayoutEditorStore.getState().setHovered("mic");
    });
    expect(reported(node)).toBe("true");
  });
});
