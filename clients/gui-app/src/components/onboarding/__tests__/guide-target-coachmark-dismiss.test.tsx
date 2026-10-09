/**
 * Escape and the coachmark's own dismiss button both call `focusGuideTarget`
 * before closing (`onboarding-coachmark.tsx`), so a guide step aimed at
 * Settings ▸ Layout's `[data-layout-areas]` root has to land somewhere
 * sensible when the person backs out of it. Narrow only: jsdom's
 * `querySelectorAll` does not sort a grouped selector's matches into document
 * order, so on the desktop rail `firstReachable` meets the first tab before
 * the tablist - an engine artifact a real browser does not share. The
 * tablist hand-off itself is a unit case in `guide-target.test.ts`.
 */
import { useRef, type ReactNode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnboardingCoachmark } from "@/components/onboarding/onboarding-coachmark";
import { LayoutSettingsPanel } from "@/components/settings/panels/layout-settings-panel";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => null,
}));
vi.mock(
  "@/components/layout-editor/inspector/provider-limit-windows",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/layout-editor/inspector/provider-limit-windows")
    >()),
    ProviderLimitWindowsReader: (props: {
      readonly children: (limits: {
        windows: ReadonlyArray<never>;
        drawnKeys: ReadonlyArray<never>;
      }) => ReactNode;
    }) => props.children({ windows: [], drawnKeys: [] }),
    LayoutUsageProvider: (props: { readonly children: ReactNode }) =>
      props.children,
  }),
);
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));

// Same stand-in `onboarding-coachmark-lifecycle.test.tsx` uses: jsdom has no
// layout, so only the element the card anchors to is real.
vi.mock("@floating-ui/dom", () => ({
  computePosition: vi.fn(() =>
    Promise.resolve({
      x: 24,
      y: 48,
      placement: "bottom-start",
      strategy: "fixed",
      middlewareData: {},
    }),
  ),
  autoUpdate: (
    _reference: Element,
    _floating: Element,
    update: () => void,
  ): (() => void) => {
    update();
    return () => undefined;
  },
  offset: () => ({ name: "offset", fn: () => ({}) }),
  flip: () => ({ name: "flip", fn: () => ({}) }),
  shift: () => ({ name: "shift", fn: () => ({}) }),
}));

function stubGetClientRects(): () => void {
  const original = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "getClientRects",
  );
  Object.defineProperty(HTMLElement.prototype, "getClientRects", {
    configurable: true,
    value: () => ({ length: 1 }),
  });
  return () => {
    if (original !== undefined) {
      Object.defineProperty(HTMLElement.prototype, "getClientRects", original);
    }
  };
}

function stubCheckVisibility(hideSelector: string): () => void {
  const prototype = HTMLElement.prototype as {
    checkVisibility?: (this: HTMLElement) => boolean;
  };
  const original = prototype.checkVisibility;
  prototype.checkVisibility = function (this: HTMLElement): boolean {
    return this.closest(hideSelector) === null;
  };
  return () => {
    if (original === undefined) {
      delete prototype.checkVisibility;
    } else {
      prototype.checkVisibility = original;
    }
  };
}

function LayoutAreasGuideHarness(props: { readonly onClose: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rootRef} data-testid="guide-root">
      <LayoutSettingsPanel />
      <OnboardingCoachmark
        id="layout-areas-guide"
        title="Every piece has a row"
        content="Content"
        progress={null}
        rootRef={rootRef}
        selector="[data-layout-areas]"
        onClose={props.onClose}
        onTarget={null}
        back={null}
        action={null}
      />
    </div>
  );
}

afterEach(() => {
  cleanup();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  vi.restoreAllMocks();
});

describe("Escape and the dismiss button focus the Layout areas guide target (review H2)", () => {
  it("Escape from inside the card lands on the Layout area select on a narrow viewport", async () => {
    // jsdom's real `getClientRects` never reports layout, so every element
    // reads as invisible to `useGuideTarget` unless stubbed.
    const restoreRects = stubGetClientRects();
    const restoreVisibility = stubCheckVisibility("nav");
    const onClose = vi.fn();

    render(<LayoutAreasGuideHarness onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByTestId("guide-coachmark")).toBeTruthy();
    });

    const card = screen.getByTestId("guide-coachmark");
    act(() => {
      card.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(
      screen.getByRole("combobox", { name: "Layout area" }),
    );

    restoreVisibility();
    restoreRects();
  });

  it("clicking Dismiss lands on the Layout area select on a narrow viewport", async () => {
    const restoreRects = stubGetClientRects();
    const restoreVisibility = stubCheckVisibility("nav");
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(<LayoutAreasGuideHarness onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByTestId("guide-coachmark")).toBeTruthy();
    });

    await user.click(
      screen.getByRole("button", { name: "Dismiss getting started guide" }),
    );

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(
      screen.getByRole("combobox", { name: "Layout area" }),
    );

    restoreVisibility();
    restoreRects();
  });
});
