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

function appearanceGrid(): HTMLElement {
  const grid = document.querySelector(".landing-appearance-surface");
  if (!(grid instanceof HTMLElement)) {
    throw new Error("landing appearance surface is missing");
  }
  return grid;
}

function classTokens(className: string): readonly string[] {
  return className.split(/\s+/);
}

function composerColumn(): HTMLElement {
  const composer = appearanceGrid().querySelector("[data-composer-placement]");
  if (!(composer instanceof HTMLElement)) {
    throw new Error("composer track is missing");
  }
  return composer;
}

function heroSection(): HTMLElement {
  const hero = screen.getByTestId("home-hero").parentElement;
  if (!(hero instanceof HTMLElement)) {
    throw new Error("hero track is missing");
  }
  return hero;
}

function customizeButton(): HTMLElement {
  const button = screen.getByRole("button", { name: "Customize start page" });
  const grid = appearanceGrid();
  let node: HTMLElement | null = button;
  while (node.parentElement !== null && node.parentElement !== grid) {
    node = node.parentElement;
  }
  return node;
}

function expectBalancedDesktopRows(): void {
  const grid = appearanceGrid();
  expect(classTokens(grid.className)).toContain(
    "md:grid-rows-[auto_minmax(0,1fr)_minmax(0,1fr)]",
  );
  expect(classTokens(grid.className)).toContain(
    "max-md:grid-rows-[auto_minmax(0,1fr)_minmax(min-content,1.4fr)]",
  );
  expect(classTokens(grid.className)).toContain(
    "max-md:short-landscape:grid-rows-[auto_0_auto]",
  );
  expect(classTokens(grid.className)).toContain("overflow-hidden");
  expect(classTokens(grid.className)).toContain("max-md:overflow-y-auto");
  expect(classTokens(grid.className)).toContain(
    "max-md:short-landscape:content-start",
  );
  expect(classTokens(composerColumn().className)).toContain("md:min-h-0");
  expect(classTokens(heroSection().className)).not.toContain("h-0");
  expect(classTokens(heroSection().className)).not.toContain("overflow-hidden");
}

afterEach(() => {
  cleanup();
  useSettingsStore.setState({ showGreeting: true, showRecentHistory: true });
});

describe("LandingDraftSurface grid", () => {
  it("nests current tasks in the composer column when greeting and history are on", () => {
    setViewportWidth(1280);
    useSettingsStore.setState({ showGreeting: true, showRecentHistory: true });
    render(<LandingDraftSurface />);

    expectNestedTasks();
    expectBalancedDesktopRows();
    const grid = appearanceGrid();
    const customize = customizeButton();
    expect(customize.parentElement).toBe(grid);
    expect(customize.className).toContain("absolute");
    expect(customize.className).toContain("bottom-3");
    expect(customize.className).toContain("left-3");
    expect(composerColumn().nextElementSibling).toBe(customize);
    expect(grid.children).toHaveLength(4);
  });

  it("uses the same desktop rows for history without a greeting, and still nests tasks", () => {
    setViewportWidth(1280);
    useSettingsStore.setState({ showGreeting: false, showRecentHistory: true });
    render(<LandingDraftSurface />);

    expectNestedTasks();
    expectBalancedDesktopRows();
    expect(classTokens(heroSection().className)).toContain("invisible");
  });

  it("uses the same desktop rows for a greeting without history, and mounts no task list", () => {
    setViewportWidth(1280);
    useSettingsStore.setState({ showGreeting: true, showRecentHistory: false });
    render(<LandingDraftSurface />);

    expectBalancedDesktopRows();
    expect(screen.queryByTestId("current-tasks-section")).toBeNull();
  });

  it("collapses the hero and centres the composer when greeting and history are off", () => {
    setViewportWidth(1280);
    useSettingsStore.setState({
      showGreeting: false,
      showRecentHistory: false,
    });
    render(<LandingDraftSurface />);

    const grid = appearanceGrid();
    expect(classTokens(grid.className)).toContain(
      "md:grid-rows-[auto_minmax(0,0fr)_minmax(0,1fr)]",
    );
    expect(classTokens(grid.className)).toContain(
      "max-md:grid-rows-[auto_0_minmax(min-content,1fr)]",
    );
    expect(classTokens(grid.className)).toContain(
      "max-md:short-landscape:grid-rows-[auto_0_auto]",
    );
    expect(classTokens(heroSection().className)).toContain("h-0");
    expect(classTokens(heroSection().className)).toContain("overflow-hidden");
    const composer = composerColumn();
    expect(classTokens(composer.className)).toContain("justify-center");
    expect(classTokens(composer.className)).not.toContain("md:min-h-0");
    expect(screen.queryByTestId("current-tasks-section")).toBeNull();
  });

  it("on a phone keeps history in the composer and omits tasks and customize", () => {
    setViewportWidth(390);
    useSettingsStore.setState({ showGreeting: true, showRecentHistory: true });
    render(<LandingDraftSurface />);

    const grid = appearanceGrid();
    const composer = composerColumn();
    expect(screen.queryByTestId("current-tasks-section")).toBeNull();
    expect(composer.contains(screen.getByTestId("home-view-history"))).toBe(
      true,
    );
    expect(
      screen.queryByRole("button", { name: "Customize start page" }),
    ).toBeNull();
    expect(classTokens(grid.className)).toContain(
      "max-md:grid-rows-[auto_minmax(0,1fr)_minmax(min-content,1.4fr)]",
    );
    expect(classTokens(grid.className)).toContain("max-md:overflow-y-auto");
    expect(grid.children).toHaveLength(3);
  });
});

function expectNestedTasks(): void {
  const composer = composerColumn();
  const tasks = screen.getByTestId("current-tasks-section");
  const wrapper = tasks.parentElement;
  if (!(wrapper instanceof HTMLElement)) {
    throw new Error("task list wrapper is missing");
  }
  expect(wrapper.className).toBe("flex min-h-0 flex-1 flex-col pb-6");
  expect(wrapper.parentElement).toBe(composer);
  expect(composer.contains(tasks)).toBe(true);
  expect(Array.from(appearanceGrid().children).includes(wrapper)).toBe(false);
}
