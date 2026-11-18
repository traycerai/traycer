import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { RollingNumber } from "@/components/ui/rolling-number";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";

/**
 * The wrapper has exactly two renderings and the suite has to see both.
 *
 * jsdom has no `Element.prototype.animate` and no `CSS` global, so the
 * package's own capability probe is false for every test in this repo and the
 * component renders its plain span - which is the whole reason the call sites
 * that ticket B and C touch keep their existing `getByText` assertions. That
 * path is exercised unmocked below.
 *
 * The other path only exists where the probe is true, so `useIsSupported` is
 * stubbed to reach it. Nothing else is stubbed: the real `NumberFlow` renders,
 * so what those tests observe is the package's own output, not a mock's.
 *
 * What that output is under vitest is worth writing down, because it is NOT
 * what it is in the renderer. `esm-env`'s `BROWSER` is false here, so the
 * package takes its server path: it never calls `define()`, the element never
 * upgrades, there is no shadow root, and the formatted value plus a
 * declarative-shadow-root `<template>` and a `<style>` land in the LIGHT DOM.
 * In Electron `BROWSER` is true, the element upgrades and the digits live in
 * an open shadow root where a light-DOM text query cannot reach them. So the
 * rendering the wrapper picks is assertable here; the roll, the shadow
 * boundary and the inherited tone are the browser driver's job.
 */

const isSupported = { current: false };

vi.mock("@number-flow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@number-flow/react")>();
  return { ...actual, useIsSupported: () => isSupported.current };
});

function reset(): void {
  isSupported.current = false;
  useThemeLibraryStore.setState({ panelAnimations: true });
}

beforeEach(reset);
afterEach(() => {
  cleanup();
  reset();
});

function InVisiblePane({ children }: { readonly children: ReactNode }) {
  return (
    <PaneVisibilityContext.Provider value>
      {children}
    </PaneVisibilityContext.Provider>
  );
}

function renderRolling(ui: ReactElement) {
  return render(<InVisiblePane>{ui}</InVisiblePane>);
}

function rolled(container: HTMLElement): Element | null {
  return container.querySelector("number-flow-react");
}

describe("RollingNumber in the environment the suite actually runs in", () => {
  it("renders the exact value as light-DOM text and starts no custom element", () => {
    const { container } = renderRolling(
      <RollingNumber value={47} className={undefined} testId="count" />,
    );

    expect(screen.getByTestId("count").textContent).toBe("47");
    expect(screen.getByText("47")).toBe(screen.getByTestId("count"));
    expect(rolled(container)).toBeNull();
  });

  it("prints a four-digit count ungrouped, the way the plain numbers beside it are printed", () => {
    renderRolling(
      <RollingNumber value={1234} className={undefined} testId="count" />,
    );

    expect(screen.getByTestId("count").textContent).toBe("1234");
  });

  it("updates in place when the value changes, without remounting", () => {
    const { rerender } = renderRolling(
      <RollingNumber value={3} className={undefined} testId="count" />,
    );
    const first = screen.getByTestId("count");

    rerender(
      <InVisiblePane>
        <RollingNumber value={4} className={undefined} testId="count" />
      </InVisiblePane>,
    );

    expect(screen.getByTestId("count")).toBe(first);
    expect(first.textContent).toBe("4");
  });

  it("carries the caller's class and no tone of its own, so the parent's colour inherits", () => {
    renderRolling(
      <RollingNumber value={9} className="font-mono" testId="count" />,
    );
    const rendered = screen.getByTestId("count");

    expect(rendered.className).toBe("tabular-nums font-mono");
  });
});

describe("RollingNumber where the browser can animate", () => {
  it("hands the value to the custom element instead of rendering a span", () => {
    isSupported.current = true;

    const { container } = renderRolling(
      <RollingNumber value={47} className={undefined} testId="count" />,
    );
    const element = rolled(container);

    expect(element).not.toBeNull();
    expect(container.querySelector("span[data-testid]")).toBeNull();
    // The test id and the type follow the value onto whichever element wins,
    // so a call site's query does not have to know which branch it got.
    expect(screen.getByTestId("count")).toBe(element);
    expect(element?.className).toBe("tabular-nums");
  });

  it("falls back to plain text when the app's own Panel animations switch is off", () => {
    isSupported.current = true;
    useThemeLibraryStore.setState({ panelAnimations: false });

    const { container } = renderRolling(
      <RollingNumber value={47} className={undefined} testId="count" />,
    );

    expect(rolled(container)).toBeNull();
    expect(screen.getByText("47")).toBe(screen.getByTestId("count"));
  });
});
