import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  ChatTreeSurfaceContext,
  useRevealRowControls,
  type ChatTreeSurface,
} from "@/components/epic-canvas/sidebar/chat-tree-surface";
import { nodePadRightClass } from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";

afterEach(cleanup);

function RevealProbe() {
  return <span data-testid="reveal">{String(useRevealRowControls())}</span>;
}

function surface(revealRowControls: boolean): ChatTreeSurface {
  return {
    onRowActivated: () => undefined,
    revealRowControls,
    searchQuery: null,
  };
}

describe("useRevealRowControls", () => {
  it("is false with no surface, which is the desktop sidebar", () => {
    // The desktop tree provides no surface at all rather than providing a
    // false one, so the no-provider default is the behaviour that ships.
    render(<RevealProbe />);
    expect(screen.getByTestId("reveal").textContent).toBe("false");
  });

  it("follows the mounting surface when there is one", () => {
    const view = render(
      <ChatTreeSurfaceContext.Provider value={surface(true)}>
        <RevealProbe />
      </ChatTreeSurfaceContext.Provider>,
    );
    expect(screen.getByTestId("reveal").textContent).toBe("true");

    // A fine pointer in a narrow window keeps hover reveal: the switcher passes
    // `useCoarsePointer()` here, not a constant, so both answers must work.
    view.rerender(
      <ChatTreeSurfaceContext.Provider value={surface(false)}>
        <RevealProbe />
      </ChatTreeSurfaceContext.Provider>,
    );
    expect(screen.getByTestId("reveal").textContent).toBe("false");
  });
});

describe("nodePadRightClass", () => {
  it("reserves the control pad at rest when the controls never wait for hover", () => {
    // The point of the revealed branch: no `group-hover` qualifier survives, or
    // the row would sit at `pr-2` with the controls already painted over its
    // trailing content.
    const revealed = nodePadRightClass(true, false, true);
    expect(revealed).toBe("pr-8");
    expect(revealed).not.toContain("group-hover");

    const wide = nodePadRightClass(true, true, true);
    expect(wide).toBe("pr-14");
    expect(wide).not.toContain("group-hover");
  });

  it("keeps the hover-revealed pad when the surface can hover", () => {
    expect(nodePadRightClass(true, false, false)).toContain(
      "group-hover/tree-item:pr-8",
    );
    expect(nodePadRightClass(true, true, false)).toContain(
      "group-hover/tree-item:pr-14",
    );
  });

  it("reserves nothing for a row with no controls, revealed or not", () => {
    // A viewer's row has no menu to make room for on either surface.
    expect(nodePadRightClass(false, false, true)).toBe("pr-2");
    expect(nodePadRightClass(false, false, false)).toBe("pr-2");
  });
});
