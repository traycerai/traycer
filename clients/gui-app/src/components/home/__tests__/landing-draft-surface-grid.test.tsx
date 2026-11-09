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

function composerColumn(): HTMLElement {
  const composer = appearanceGrid().querySelector("[data-composer-placement]");
  if (!(composer instanceof HTMLElement)) {
    throw new Error("composer track is missing");
  }
  return composer;
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
    const grid = appearanceGrid();
    const customize = customizeButton();
    expect(customize.parentElement).toBe(grid);
    expect(composerColumn().nextElementSibling).toBe(customize);
    expect(grid.children).toHaveLength(4);
  });

  it("nests tasks when history is on and the greeting is off", () => {
    setViewportWidth(1280);
    useSettingsStore.setState({ showGreeting: false, showRecentHistory: true });
    render(<LandingDraftSurface />);

    expectNestedTasks();
  });

  it("mounts no task list for a greeting without history", () => {
    setViewportWidth(1280);
    useSettingsStore.setState({ showGreeting: true, showRecentHistory: false });
    render(<LandingDraftSurface />);

    expect(screen.queryByTestId("current-tasks-section")).toBeNull();
  });

  it("mounts no task list when greeting and history are off", () => {
    setViewportWidth(1280);
    useSettingsStore.setState({
      showGreeting: false,
      showRecentHistory: false,
    });
    render(<LandingDraftSurface />);

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
  expect(wrapper.parentElement).toBe(composer);
  expect(composer.contains(tasks)).toBe(true);
  expect(Array.from(appearanceGrid().children).includes(wrapper)).toBe(false);
}
