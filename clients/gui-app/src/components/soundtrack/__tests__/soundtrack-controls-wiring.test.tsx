/**
 * The window's music controls through the real wiring: the real
 * `TopLevelTabHost` mount for every kind that carries them, and the real
 * `SoundtrackPageControlsScope` reading a real router's Settings overlay. Only
 * the surface bodies behind the controls are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  createMemoryHistory,
  useRouterState,
  createRootRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { SoundtrackPageControlsScope } from "@/components/soundtrack/soundtrack-page-controls-scope";
import { SoundtrackPlaybackControls } from "@/components/soundtrack/soundtrack-playback-controls";
import { TopLevelTabHost } from "@/components/layout/top-level-tab-host";
import { LayoutOverrideContext } from "@/lib/layout-overrides";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import { systemTabOverlaySearchSchema } from "@/lib/system-tab-overlay-search";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";

vi.mock("@/lib/soundtrack/manifest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/soundtrack/manifest")>()),
  soundtrackOffered: () => true,
}));

// The bodies are what these tests are not about; the mount around them is.
vi.mock("@/stores/tabs/registry", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/stores/tabs/registry")>();
  return {
    ...actual,
    tabSurfaceDescriptor: () => ({
      render: () => <div data-testid="surface-body-stub" />,
    }),
  };
});

const DRAFT: TabRef = { kind: "draft", id: "draft-a" };
const SETTINGS: TabRef = { kind: "settings", id: "settings" };
const HISTORY: TabRef = { kind: "history", id: "history" };
const TRACY: TabRef = { kind: "tracy", id: "tracy" };

function groups(): HTMLElement[] {
  return screen.queryAllByRole("group", { name: "Music playback" });
}

function setItems(
  refs: readonly TabRef[],
  active: string | null,
  split: {
    readonly left: TabRef;
    readonly right: TabRef;
    readonly focused: "left" | "right";
  } | null,
): void {
  useTabsStore.setState((state) => ({
    ...state,
    systemTabs: {
      history: refs.includes(HISTORY)
        ? { id: "history", kind: "history", name: "History", lastPath: null }
        : null,
      settings: refs.includes(SETTINGS)
        ? { id: "settings", kind: "settings", name: "Settings", lastPath: null }
        : null,
    },
    items:
      split === null
        ? refs.map((ref) => ({
            kind: "tab" as const,
            id: `tab:${ref.kind}:${ref.id}`,
            ref,
          }))
        : [
            {
              kind: "split" as const,
              id: "pair",
              left: { kind: "tab" as const, ref: split.left },
              right: { kind: "tab" as const, ref: split.right },
              focusedSide: split.focused,
              routeBackingSide: split.focused,
              leftRatio: 0.5,
            },
          ],
    activeItemId: active,
    stripOrder: [...refs],
  }));
}

beforeEach(() => {
  window.localStorage.clear();
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  useLandingDraftStore.setState(useLandingDraftStore.getInitialState(), true);
  useLandingDraftStore.getState().createDraftWithId(DRAFT.id, null);
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  useSettingsStore.setState({
    soundtrackEnabled: true,
    soundtrackPlaybackControls: true,
  });
});

afterEach(() => {
  cleanup();
  useTracySurfaceStore.setState(useTracySurfaceStore.getInitialState(), true);
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  useLandingDraftStore.setState(useLandingDraftStore.getInitialState(), true);
  vi.restoreAllMocks();
});

describe("the controls in the top-level surfaces", () => {
  it.each([
    ["a draft", DRAFT],
    ["Settings", SETTINGS],
    ["Tracy", TRACY],
  ])("draws one group on %s", (_name, ref) => {
    if (ref === TRACY) useTracySurfaceStore.getState().openSurface("host-a");
    setItems([ref], `tab:${ref.kind}:${ref.id}`, null);

    render(<TopLevelTabHost />);

    expect(groups()).toHaveLength(1);
  });

  it("draws none on History", () => {
    setItems([HISTORY], `tab:${HISTORY.kind}:${HISTORY.id}`, null);

    render(<TopLevelTabHost />);

    expect(groups()).toHaveLength(0);
  });

  it("draws one group on Home when no tab is open", () => {
    setItems([], null, null);

    render(
      <LayoutOverrideContext
        value={{ values: { homeTab: { shown: "shown" } } }}
      >
        <TopLevelTabHost />
      </LayoutOverrideContext>,
    );

    expect(groups()).toHaveLength(1);
  });

  it("draws the one group on the focused side of a split, and moves it with focus", () => {
    setItems([DRAFT, SETTINGS], "pair", {
      left: DRAFT,
      right: SETTINGS,
      focused: "left",
    });
    const { rerender } = render(<TopLevelTabHost />);
    expect(groups()).toHaveLength(1);
    const surface = (ref: TabRef): HTMLElement =>
      screen.getByTestId(`top-level-surface-${ref.kind}-${ref.id}`);
    expect(surface(DRAFT).contains(groups()[0])).toBe(true);

    act(() => {
      setItems([DRAFT, SETTINGS], "pair", {
        left: DRAFT,
        right: SETTINGS,
        focused: "right",
      });
    });
    rerender(<TopLevelTabHost />);

    expect(groups()).toHaveLength(1);
    expect(surface(SETTINGS).contains(groups()[0])).toBe(true);
  });
});

describe("the controls under a real router's Settings overlay", () => {
  function ModalSlot() {
    const open = useRouterState({
      select: (state) => state.location.search.settingsOverlay === true,
    });
    return (
      <div data-testid="modal">
        {open ? (
          <SoundtrackPlaybackControls placement="settings-modal" />
        ) : null}
      </div>
    );
  }

  async function openApp() {
    const root = createRootRoute({
      validateSearch: systemTabOverlaySearchSchema,
      component: () => (
        <SoundtrackPageControlsScope>
          <div data-testid="page">
            <SoundtrackPlaybackControls placement="surface" />
          </div>
          <ModalSlot />
          <Outlet />
        </SoundtrackPageControlsScope>
      ),
    });
    const router = createRouter({
      routeTree: root,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await act(async () => {
      render(<RouterProvider router={router} />);
      await router.load();
    });
    return router;
  }

  it("draws the page's group alone, and the modal's alone once the overlay opens, and back", async () => {
    const router = await openApp();
    const page = screen.getByTestId("page");
    const modal = screen.getByTestId("modal");
    expect(groups()).toHaveLength(1);
    expect(page.querySelector('[role="group"]')).not.toBeNull();
    expect(modal.querySelector('[role="group"]')).toBeNull();

    await act(async () => {
      await router.navigate({ to: "/", search: { settingsOverlay: true } });
    });
    expect(groups()).toHaveLength(1);
    expect(page.querySelector('[role="group"]')).toBeNull();
    expect(modal.querySelector('[role="group"]')).not.toBeNull();

    await act(async () => {
      await router.navigate({ to: "/", search: {} });
    });
    expect(groups()).toHaveLength(1);
    expect(page.querySelector('[role="group"]')).not.toBeNull();
  });
});
