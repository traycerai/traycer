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
