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
    render(<LandingDraftSurface />);

    const grid = document.querySelector(".landing-appearance-surface");
    expect(grid).not.toBeNull();
    expect(desktopTrack(grid as Element)).toBe(
      "grid-rows-[auto_minmax(0,1fr)_minmax(0,1fr)]",
    );
    expect(desktopTrack(grid as Element)).not.toContain(
      "minmax(min-content,1fr)",
    );
    expect(grid?.classList.contains("overflow-y-auto")).toBe(true);
    expect(grid?.classList.contains("overflow-hidden")).toBe(false);

    const composer = document.querySelector("[data-composer-placement]");
    expect(composer?.className.split(/\s+/)).toContain("md:min-h-0");

    const tasks = screen.getByTestId("current-tasks-section");
    const wrapper = tasks.parentElement;
    expect(wrapper?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["overflow-hidden", "min-h-0"]),
    );
  });

  it("keeps the empty start page centred on the composer's own height", () => {
    setViewportWidth(1280);
    useSettingsStore.setState({
      showGreeting: false,
      showRecentHistory: false,
    });
    render(<LandingDraftSurface />);

    const grid = document.querySelector(".landing-appearance-surface");
    expect(desktopTrack(grid as Element)).toBe(
      "grid-rows-[auto_0_minmax(min-content,1fr)]",
    );
    expect(screen.queryByTestId("current-tasks-section")).toBeNull();
  });
});
