/**
 * Where the task list sits relative to the composer. Row heights and the
 * editor cap are layout, measured in
 * `browser-tests/landing-draft-surface-cap.spec.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useSettingsStore } from "@/stores/settings/settings-store";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useRouterState: ({
      select,
    }: {
      select: (state: {
        location: { search: Record<string, unknown> };
      }) => unknown;
    }) => select({ location: { search: {} } }),
  };
});

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({
    openSettings: () => undefined,
    openHistory: () => undefined,
    close: () => undefined,
    setSection: () => undefined,
  }),
}));

vi.mock("@/components/home/home-hero", () => ({
  HomeHero: () => <div data-testid="home-hero" />,
}));

vi.mock("@/components/home/composer/landing-composer", () => ({
  LandingComposer: () => <div data-testid="landing-composer" />,
}));

vi.mock("@/components/home/current-tasks-section", () => ({
  CurrentTasksSection: () => <div data-testid="current-tasks-section" />,
}));

vi.mock("@/components/home/host-update-banner", () => ({
  HostUpdateBanner: () => null,
}));

vi.mock("@/components/home/landing-appearance-wallpaper", () => ({
  LandingAppearanceWallpaper: () => null,
}));

vi.mock("@/components/onboarding/first-task-guide", () => ({
  FirstTaskLandingGuide: () => null,
}));

import { LandingDraftSurface } from "@/components/home/landing-draft-surface";

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

function appearanceGrid(): Element {
  const grid = document.querySelector(".landing-appearance-surface");
  if (grid === null) {
    throw new Error("landing appearance surface is missing");
  }
  return grid;
}

afterEach(() => {
  cleanup();
  useSettingsStore.setState({ showGreeting: true, showRecentHistory: true });
});

describe("LandingDraftSurface grid", () => {
  it("places the task list after the composer, and on a phone offers history from the composer", () => {
    setViewportWidth(1280);
    useSettingsStore.setState({ showGreeting: true, showRecentHistory: true });
    const view = render(<LandingDraftSurface />);

    const grid = appearanceGrid();
    const composer = grid.querySelector("[data-composer-placement]");
    if (composer === null) {
      throw new Error("composer track is missing");
    }

    const tasks = screen.getByTestId("current-tasks-section");
    const wrapper = tasks.parentElement;
    if (wrapper === null) {
      throw new Error("task list wrapper is missing");
    }
    expect(wrapper.parentElement).toBe(grid);
    expect(composer.parentElement).toBe(grid);
    expect(composer.contains(tasks)).toBe(false);
    expect(composer.nextElementSibling).toBe(wrapper);

    // Below md the section is not mounted. Recent tasks are the history
    // control in the composer column.
    view.unmount();
    setViewportWidth(390);
    render(<LandingDraftSurface />);
    const phoneComposer = appearanceGrid().querySelector(
      "[data-composer-placement]",
    );
    expect(screen.queryByTestId("current-tasks-section")).toBeNull();
    expect(
      phoneComposer?.contains(screen.getByTestId("home-view-history")),
    ).toBe(true);
  });

  it("omits the task list on the empty start page", () => {
    setViewportWidth(1280);
    useSettingsStore.setState({
      showGreeting: false,
      showRecentHistory: false,
    });
    render(<LandingDraftSurface />);

    expect(screen.queryByTestId("current-tasks-section")).toBeNull();
  });
});
