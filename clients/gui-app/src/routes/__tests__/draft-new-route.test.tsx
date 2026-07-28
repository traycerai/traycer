import "../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const navigationMock = vi.hoisted(() => ({
  failed: false,
  listener: null as (() => void) | null,
}));

vi.mock("@tanstack/react-router", () => ({
  useRouterState: (options: {
    readonly select: (state: {
      readonly location: { readonly state: unknown };
    }) => unknown;
  }) => options.select({ location: { state: { __TSR_key: "draft-new" } } }),
}));

vi.mock("@/lib/tab-navigation", () => ({
  subscribeTabNavigationResolutionFailure: (listener: () => void) => {
    navigationMock.listener = listener;
    return () => {
      navigationMock.listener = null;
    };
  },
  tabNavigationResolutionFailed: () => navigationMock.failed,
}));

vi.mock("@/components/layout/root-landing-page", () => ({
  RootLandingPage: () => <div data-testid="draft-new-fallback" />,
}));

import { DraftNewRoute } from "@/routes/draft-new-route-components";

afterEach(() => {
  cleanup();
  navigationMock.failed = false;
  navigationMock.listener = null;
});

describe("DraftNewRoute render-only adapter", () => {
  it("renders a passive progress surface while the root bridge resolves the entry", () => {
    const view = render(<DraftNewRoute />);
    expect(view.container.firstElementChild).not.toBeNull();
    expect(view.queryByTestId("draft-new-fallback")).toBeNull();
  });

  it("renders the deterministic fallback after the controller exhausts correction", () => {
    navigationMock.failed = true;
    const view = render(<DraftNewRoute />);
    expect(view.getByTestId("draft-new-fallback")).toBeDefined();
  });
});
