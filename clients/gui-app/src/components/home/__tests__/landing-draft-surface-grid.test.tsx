/**
 * The start page's row tracks. `HomePage`'s suite mounts this surface for
 * composer identity; this file mounts it only to read the grid the task list
 * scrolls inside.
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

function desktopTrack(grid: Element): string | undefined {
  return [...grid.classList].find((name) => name.startsWith("grid-rows-"));
}

afterEach(() => {
  cleanup();
  useSettingsStore.setState({ showGreeting: true, showRecentHistory: true });
});

describe("LandingDraftSurface grid", () => {
  it("keeps the task list inside a desktop fraction of the page", () => {
    setViewportWidth(1280);
    useSettingsStore.setState({ showGreeting: true, showRecentHistory: true });
    const view = render(<LandingDraftSurface />);

    const grid = appearanceGrid();
    // The last desktop track is the task list, floored at 12.5rem. The auto
    // track before it is the composer's own row, so a tall draft cannot spend
    // the list's floor. Below md that floor is not the track that applies.
    expect(desktopTrack(grid)).toBe(
      "grid-rows-[auto_minmax(0,1fr)_auto_minmax(12.5rem,1fr)]",
    );
    expect(
      grid.classList.contains(
        "max-md:grid-rows-[auto_minmax(0,1fr)_minmax(min-content,1.4fr)]",
      ),
    ).toBe(true);
    expect(
      [...grid.classList].some(
        (name) => name.startsWith("max-md:") && name.includes("12.5rem"),
      ),
    ).toBe(false);
    expect(grid.classList.contains("overflow-y-auto")).toBe(true);
    expect(grid.classList.contains("overflow-hidden")).toBe(false);

    const composer = grid.querySelector("[data-composer-placement]");
    if (composer === null) {
      throw new Error("composer track is missing");
    }
    expect(composer.className.split(/\s+/)).toContain("md:min-h-0");

    const tasks = screen.getByTestId("current-tasks-section");
    const wrapper = tasks.parentElement;
    if (wrapper === null) {
      throw new Error("task list wrapper is missing");
    }
    expect(wrapper.parentElement).toBe(grid);
    expect(composer.parentElement).toBe(grid);
    expect(composer.contains(tasks)).toBe(false);
    expect(composer.nextElementSibling).toBe(wrapper);
    expect(wrapper.className.split(/\s+/)).toEqual(
      expect.arrayContaining([
        "mx-auto",
        "w-full",
        "max-w-3xl",
        "px-6",
        "min-h-0",
        "overflow-hidden",
        "pb-6",
      ]),
    );

    // Same row tokens at every width. Below md the section is not mounted;
    // recent tasks are the history control in the composer column.
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

  it("keeps the empty start page centred on the composer's own height", () => {
    setViewportWidth(1280);
    useSettingsStore.setState({
      showGreeting: false,
      showRecentHistory: false,
    });
    render(<LandingDraftSurface />);

    const grid = appearanceGrid();
    expect(desktopTrack(grid)).toBe(
      "grid-rows-[auto_0_minmax(min-content,1fr)]",
    );
    expect(
      grid.classList.contains("max-md:short-landscape:grid-rows-[auto_0_auto]"),
    ).toBe(true);
    expect([...grid.classList].some((name) => name.includes("12.5rem"))).toBe(
      false,
    );
    expect(screen.queryByTestId("current-tasks-section")).toBeNull();
  });
});
