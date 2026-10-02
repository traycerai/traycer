/**
 * `landing-pane-anchor-store.ts`: what the start page's terminal panel RENDERS
 * on each page, published by the panel itself (`panelCoverage`) for the one
 * reader that has to match the page's ground, the tab that joins it.
 *
 * Pinned here: the pure answer (`landingPanelCoverage`), the store's setter and
 * its identity guarantees (a no-op write must not hand subscribers a new
 * state), and the publishing hook that keeps the entry true to the component
 * that owns it (`usePublishLandingPanelCoverage`): published before paint,
 * following the panel, and retracted when the panel leaves the page.
 */
import { useLayoutEffect } from "react";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  landingPanelCoverage,
  useLandingPaneAnchorStore,
  usePublishLandingPanelCoverage,
  type LandingPanelCoverage,
} from "../landing-pane-anchor-store";

function coverageOf(landingPageId: string): LandingPanelCoverage | undefined {
  return useLandingPaneAnchorStore.getState().panelCoverage.get(landingPageId);
}

afterEach(() => {
  cleanup();
  useLandingPaneAnchorStore.setState(
    useLandingPaneAnchorStore.getInitialState(),
    true,
  );
});

describe("landingPanelCoverage", () => {
  it.each([false, true])(
    "is null for a closed panel when fullOverlay is %s",
    (fullOverlay) => {
      expect(
        landingPanelCoverage({ panelOpen: false, fullOverlay }),
      ).toBeNull();
    },
  );

  it("is full for an open panel that covers the page", () => {
    expect(landingPanelCoverage({ panelOpen: true, fullOverlay: true })).toBe(
      "full",
    );
  });

  it("is docked for an open panel that does not cover the page", () => {
    expect(landingPanelCoverage({ panelOpen: true, fullOverlay: false })).toBe(
      "docked",
    );
  });
});

describe("setPanelCoverage", () => {
  it("starts with no page showing a panel", () => {
    expect(useLandingPaneAnchorStore.getState().panelCoverage.size).toBe(0);
  });

  it("records the coverage a page's panel renders", () => {
    useLandingPaneAnchorStore.getState().setPanelCoverage("page-a", "docked");

    expect(coverageOf("page-a")).toBe("docked");
  });

  it("replaces a page's coverage with the new one", () => {
    const { setPanelCoverage } = useLandingPaneAnchorStore.getState();
    setPanelCoverage("page-a", "docked");

    setPanelCoverage("page-a", "full");

    expect(coverageOf("page-a")).toBe("full");
    expect(useLandingPaneAnchorStore.getState().panelCoverage.size).toBe(1);
  });

  it("deletes a page's entry when given null", () => {
    const { setPanelCoverage } = useLandingPaneAnchorStore.getState();
    setPanelCoverage("page-a", "full");

    setPanelCoverage("page-a", null);

    expect(coverageOf("page-a")).toBeUndefined();
    expect(
      useLandingPaneAnchorStore.getState().panelCoverage.has("page-a"),
    ).toBe(false);
  });

  it("keeps the same state object when it deletes an entry that is not there", () => {
    const before = useLandingPaneAnchorStore.getState();

    before.setPanelCoverage("missing", null);

    expect(useLandingPaneAnchorStore.getState()).toBe(before);
    expect(useLandingPaneAnchorStore.getState().panelCoverage).toBe(
      before.panelCoverage,
    );
  });

  it.each(["docked", "full"] as const)(
    "keeps the same state object when a page is set to the %s coverage it already has",
    (coverage) => {
      useLandingPaneAnchorStore.getState().setPanelCoverage("page-a", coverage);
      const before = useLandingPaneAnchorStore.getState();

      before.setPanelCoverage("page-a", coverage);

      expect(useLandingPaneAnchorStore.getState()).toBe(before);
      expect(useLandingPaneAnchorStore.getState().panelCoverage).toBe(
        before.panelCoverage,
      );
    },
  );

  it("hands subscribers a new map, never the one it mutated", () => {
    const { setPanelCoverage } = useLandingPaneAnchorStore.getState();
    setPanelCoverage("page-a", "docked");
    const before = useLandingPaneAnchorStore.getState().panelCoverage;

    setPanelCoverage("page-a", "full");

    expect(useLandingPaneAnchorStore.getState().panelCoverage).not.toBe(before);
    expect(before.get("page-a")).toBe("docked");
  });

  it("leaves other pages' entries alone", () => {
    const { setPanelCoverage } = useLandingPaneAnchorStore.getState();
    setPanelCoverage("page-a", "docked");
    setPanelCoverage("page-b", "full");

    setPanelCoverage("page-a", "full");
    expect(coverageOf("page-b")).toBe("full");

    setPanelCoverage("page-a", null);
    expect(coverageOf("page-b")).toBe("full");
    expect(useLandingPaneAnchorStore.getState().panelCoverage.size).toBe(1);
  });

  it("does not touch the anchors or presentations", () => {
    const before = useLandingPaneAnchorStore.getState();

    before.setPanelCoverage("page-a", "full");

    const after = useLandingPaneAnchorStore.getState();
    expect(after.anchors).toBe(before.anchors);
    expect(after.presentations).toBe(before.presentations);
  });
});

interface PublishProps {
  readonly landingPageId: string;
  readonly coverage: LandingPanelCoverage | null;
}

function usePublishProps(props: PublishProps): void {
  usePublishLandingPanelCoverage(props.landingPageId, props.coverage);
}

function mountPublisher(initialProps: PublishProps) {
  return renderHook(usePublishProps, { initialProps });
}

describe("usePublishLandingPanelCoverage", () => {
  it("publishes the coverage on mount", () => {
    mountPublisher({ landingPageId: "page-a", coverage: "docked" });

    expect(coverageOf("page-a")).toBe("docked");
  });

  it("follows a change of coverage on rerender", () => {
    const { rerender } = mountPublisher({
      landingPageId: "page-a",
      coverage: "docked",
    });
    expect(coverageOf("page-a")).toBe("docked");

    rerender({ landingPageId: "page-a", coverage: "full" });
    expect(coverageOf("page-a")).toBe("full");

    rerender({ landingPageId: "page-a", coverage: "docked" });
    expect(coverageOf("page-a")).toBe("docked");
  });

  it("removes the entry when it publishes null, and publishes again after", () => {
    const { rerender } = mountPublisher({
      landingPageId: "page-a",
      coverage: "full",
    });
    expect(coverageOf("page-a")).toBe("full");

    rerender({ landingPageId: "page-a", coverage: null });
    expect(coverageOf("page-a")).toBeUndefined();

    rerender({ landingPageId: "page-a", coverage: "docked" });
    expect(coverageOf("page-a")).toBe("docked");
  });

  it("publishes nothing for a panel that renders nothing", () => {
    mountPublisher({ landingPageId: "page-a", coverage: null });

    expect(coverageOf("page-a")).toBeUndefined();
    expect(useLandingPaneAnchorStore.getState().panelCoverage.size).toBe(0);
  });

  it("retracts the entry on unmount", () => {
    const { unmount } = mountPublisher({
      landingPageId: "page-a",
      coverage: "full",
    });
    expect(coverageOf("page-a")).toBe("full");

    unmount();

    expect(coverageOf("page-a")).toBeUndefined();
  });

  it("retracts the old page's entry and publishes the new one when the page changes", () => {
    const { rerender } = mountPublisher({
      landingPageId: "page-a",
      coverage: "full",
    });
    expect(coverageOf("page-a")).toBe("full");

    rerender({ landingPageId: "page-b", coverage: "full" });

    expect(coverageOf("page-a")).toBeUndefined();
    expect(coverageOf("page-b")).toBe("full");
    expect(useLandingPaneAnchorStore.getState().panelCoverage.size).toBe(1);
  });

  it("moves the coverage and the page in one render without leaving the old entry behind", () => {
    const { rerender } = mountPublisher({
      landingPageId: "page-a",
      coverage: "full",
    });

    rerender({ landingPageId: "page-b", coverage: "docked" });

    expect(coverageOf("page-a")).toBeUndefined();
    expect(coverageOf("page-b")).toBe("docked");
    expect(useLandingPaneAnchorStore.getState().panelCoverage.size).toBe(1);
  });

  it("does not retract the entry when only the coverage changes", () => {
    const seen: Array<LandingPanelCoverage | undefined> = [];
    const unsubscribe = useLandingPaneAnchorStore.subscribe((state) => {
      seen.push(state.panelCoverage.get("page-a"));
    });
    const { rerender } = mountPublisher({
      landingPageId: "page-a",
      coverage: "docked",
    });

    rerender({ landingPageId: "page-a", coverage: "full" });
    unsubscribe();

    // Straight from docked to full: a cleanup on the publish effect would have
    // put an `undefined` between them.
    expect(seen).toEqual(["docked", "full"]);
  });

  it("leaves another page's entry alone while it publishes and retracts its own", () => {
    useLandingPaneAnchorStore.getState().setPanelCoverage("page-b", "docked");
    const { unmount } = mountPublisher({
      landingPageId: "page-a",
      coverage: "full",
    });
    expect(coverageOf("page-b")).toBe("docked");

    unmount();

    expect(coverageOf("page-a")).toBeUndefined();
    expect(coverageOf("page-b")).toBe("docked");
  });

  it("publishes in the layout phase of the commit that mounts it, before anything paints", () => {
    const seenByLaterLayoutEffect: Array<LandingPanelCoverage | undefined> = [];

    renderHook(() => {
      usePublishLandingPanelCoverage("page-a", "full");
      // Declared after the hook, so it runs after the hook's own layout
      // effect and before any passive one: the entry is already there only if
      // the hook publishes in a layout effect.
      useLayoutEffect(() => {
        seenByLaterLayoutEffect.push(coverageOf("page-a"));
      });
    });

    expect(seenByLaterLayoutEffect).toEqual(["full"]);
  });
});
