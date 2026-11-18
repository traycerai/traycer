import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  PaneSurfaceActivityContext,
  PaneVisibilityContext,
  useActivePaneEffect,
  useFocusedPaneModalOpen,
  useVisiblePaneEffect,
  type PaneSurfaceActivity,
} from "@/components/epic-tabs/pane-visibility-context";
import { SurfaceActivityProvider } from "@/components/home/composer/surface-activity-context";
import { useSurfaceActivity } from "@/components/home/composer/surface-activity-hooks";
import { chatTileCatalogActivity } from "@/components/epic-canvas/renderers/chat-tile-surface-activity";

afterEach(() => cleanup());

function ActivityProbe(props: {
  readonly onFocused: () => void;
  readonly onVisible: () => void;
}) {
  useActivePaneEffect(props.onFocused);
  useVisiblePaneEffect(props.onVisible);
  return null;
}

function PortalProbe(props: { readonly open: boolean }) {
  const presented = useFocusedPaneModalOpen(props.open);
  return presented ? <div data-testid="pane-modal-portal" /> : null;
}

function CatalogProbe(props: { readonly id: string }) {
  const subscribed = useSurfaceActivity();
  return (
    <div data-testid={`catalog-${props.id}`} data-subscribed={subscribed} />
  );
}

function FocusedCatalogScope(props: {
  readonly id: string;
  readonly tileActive: boolean;
}) {
  const focused = useFocusedPaneModalOpen(true);
  const active = chatTileCatalogActivity(focused, true, props.tileActive);
  return (
    <SurfaceActivityProvider active={active}>
      <CatalogProbe id={props.id} />
    </SurfaceActivityProvider>
  );
}

function renderProbe(
  activity: PaneSurfaceActivity,
  onFocused: () => void,
  onVisible: () => void,
) {
  return render(
    <PaneSurfaceActivityContext.Provider value={activity}>
      <PaneVisibilityContext.Provider value={activity.visible}>
        <ActivityProbe onFocused={onFocused} onVisible={onVisible} />
      </PaneVisibilityContext.Provider>
    </PaneSurfaceActivityContext.Provider>,
  );
}

describe("pane surface activity", () => {
  it("keeps visible work on both split members while focused work has one owner", () => {
    const visible = vi.fn();
    const focused = vi.fn();
    const left: PaneSurfaceActivity = { visible: true, focused: true };
    const right: PaneSurfaceActivity = { visible: true, focused: false };

    renderProbe(left, focused, visible);
    renderProbe(right, focused, visible);

    expect(visible).toHaveBeenCalledTimes(2);
    expect(focused).toHaveBeenCalledTimes(1);
  });

  it("suppresses an unfocused split member's document portal while retaining its local open state", () => {
    render(
      <>
        <PaneSurfaceActivityContext.Provider
          value={{ visible: true, focused: true }}
        >
          <PaneVisibilityContext.Provider value>
            <PortalProbe open />
          </PaneVisibilityContext.Provider>
        </PaneSurfaceActivityContext.Provider>
        <PaneSurfaceActivityContext.Provider
          value={{ visible: true, focused: false }}
        >
          <PaneVisibilityContext.Provider value>
            <PortalProbe open />
          </PaneVisibilityContext.Provider>
        </PaneSurfaceActivityContext.Provider>
      </>,
    );

    expect(
      document.querySelectorAll("[data-testid='pane-modal-portal']"),
    ).toHaveLength(1);
  });

  it("lets only the exact active chat tile own catalog subscriptions", () => {
    render(
      <PaneSurfaceActivityContext.Provider
        value={{ visible: true, focused: true }}
      >
        <PaneVisibilityContext.Provider value>
          <FocusedCatalogScope id="active-inner-tile" tileActive />
          <FocusedCatalogScope id="inactive-inner-tile" tileActive={false} />
        </PaneVisibilityContext.Provider>
      </PaneSurfaceActivityContext.Provider>,
    );

    expect(
      screen.getByTestId("catalog-active-inner-tile").dataset.subscribed,
    ).toBe("true");
    expect(
      screen.getByTestId("catalog-inactive-inner-tile").dataset.subscribed,
    ).toBe("false");
  });

  it("releases catalog ownership when the top-level split partner loses focus", () => {
    render(
      <>
        <PaneSurfaceActivityContext.Provider
          value={{ visible: true, focused: true }}
        >
          <PaneVisibilityContext.Provider value>
            <FocusedCatalogScope id="focused-partner" tileActive />
          </PaneVisibilityContext.Provider>
        </PaneSurfaceActivityContext.Provider>
        <PaneSurfaceActivityContext.Provider
          value={{ visible: true, focused: false }}
        >
          <PaneVisibilityContext.Provider value>
            <FocusedCatalogScope id="visible-partner" tileActive />
          </PaneVisibilityContext.Provider>
        </PaneSurfaceActivityContext.Provider>
      </>,
    );

    expect(
      screen.getByTestId("catalog-focused-partner").dataset.subscribed,
    ).toBe("true");
    expect(
      screen.getByTestId("catalog-visible-partner").dataset.subscribed,
    ).toBe("false");
  });
});
