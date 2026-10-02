import { act, render, type RenderResult } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { __resetAgentActivityStoreForTests } from "@/stores/agent-activity-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { LayoutSettingsPanel } from "@/components/settings/panels/layout-settings-panel";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";
import {
  HARNESS_LOCAL_HOST,
  seedTabs,
  seedEpicCanvas,
  openEpicSession,
  seedResourceStreams,
  resetToShippedLayout,
  usageProbe,
  tick,
  normalisedMintedIds,
  type SweepMount,
  type SweepProviderUsage,
  type SweepWindow,
} from "@/components/layout-editor/__tests__/layout-sweep-fixtures";
import {
  SweepColumn,
  SweepProviders,
  UsageProbe,
} from "@/components/layout-editor/__tests__/layout-sweep-surfaces";

/**
 * The app column, mounted the way `app-shell.tsx` arranges it, in the two
 * windows the layout settings can be seen in: a SAMPLE window (the sample
 * workspace's transcript, dock, composer and rail) and an EPIC window (a task's
 * panel with the real rail and task header, and its content sheet).
 *
 * This is the jsdom twin of the browser fixture
 * `src/__tests__/browser/layout-editor-canvas.tsx?settings=1&header=app&
 * readings=both&account=1&hosts=1`, composed from the same production
 * components and answering the same host boundary: the host messenger is the
 * ONLY thing faked (`MockHostMessenger` with the methods the fixture answers,
 * `MockRunnerHost` for the platform), exactly where the fixture fakes it.
 * Nothing between the settings store and the pixels is stubbed: the real
 * `AppHeader` and its tab strip, the real `SideTabStrip`, the real
 * `AppStatusBar` and its usage and resource segments, the real
 * `SampleWorkspaceBody`, the real `EpicSurfaceSheets`, `EpicLeftPanelRail` and
 * `PanelTaskHeader`.
 *
 * The fixture itself is not imported: it mounts itself at import (a top-level
 * `createRoot`, `window` listeners, a resource stream) and states a
 * composition this harness states once more, in one place, on purpose.
 */

function sweepRoot(container: HTMLElement): HTMLElement {
  const root = container.querySelector<HTMLElement>("[data-sweep-root]");
  if (root === null) throw new Error("the app column did not mount");
  return root;
}

/**
 * Mounts one window ONCE: the real router around the real providers around the
 * app column, with the stores seeded the way `applyVariant` seeds the fixture.
 * Nothing is re-mounted afterwards; a sweep writes stores and reads the HTML.
 */
export async function mountSweepWindow(
  windowKind: SweepWindow,
): Promise<SweepMount> {
  return mountSweepTree(windowKind);
}

/**
 * The real Settings ▸ Layout panel, mounted once beside nothing else, in the
 * same providers and stores as the windows. The sweep never operates it: it is
 * where the controls a person can operate are LISTED from, so the plan is held
 * to the page rather than to its own idea of the page.
 */
export async function mountSweepSettingsPanel(): Promise<SweepMount> {
  return mountSweepTree("panel");
}

async function mountSweepTree(
  windowKind: SweepWindow | "panel",
): Promise<SweepMount> {
  localStorage.clear();
  usageProbe.clear();
  useThemeLibraryStore.setState({ panelAnimations: false });
  useAuthStore.getState().setSignedIn(
    {
      userId: "sweep-user",
      userName: "Ada Lovelace",
      email: "ada@example.com",
      avatarUrl: null,
    },
    { userId: "sweep-user", username: "ada" },
    [],
  );
  useLayoutEditorStore.getState().endSession();
  resetToShippedLayout();
  seedTabs(windowKind !== "epic");
  if (windowKind === "epic") seedEpicCanvas();

  seedResourceStreams(windowKind);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const runnerHost = new MockRunnerHost({
    signInUrl: "http://127.0.0.1:9/sign-in",
    authnBaseUrl: "http://127.0.0.1:9",
    localHost: HARNESS_LOCAL_HOST,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const session = windowKind === "epic" ? openEpicSession() : null;

  const rootRoute = createRootRoute({
    component: () => (
      <SweepProviders queryClient={queryClient} runnerHost={runnerHost}>
        {windowKind === "panel" ? (
          <div data-sweep-root>
            <LayoutSettingsPanel />
          </div>
        ) : (
          <SweepColumn windowKind={windowKind} session={session} />
        )}
        <UsageProbe />
      </SweepProviders>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  const view: RenderResult = render(<RouterProvider router={router} />);
  await act(async () => {
    await router.load();
  });
  const container = view.container;

  const mount: SweepMount = {
    root: () => sweepRoot(container),
    providerUsage: () => {
      const usage = new Map<RateLimitProviderId, SweepProviderUsage>();
      for (const [providerId, limits] of usageProbe) {
        usage.set(providerId, {
          windows: limits.windows.map((window) => ({
            windowKey: window.windowKey,
            label: window.label,
          })),
          drawnKeys: limits.drawnKeys,
        });
      }
      return usage;
    },
    rawHtml: () => sweepRoot(container).innerHTML,
    signature: () => normalisedMintedIds(sweepRoot(container).innerHTML),
    apply: async (write) => {
      act(() => {
        write();
      });
      await mount.settle();
    },
    poke: async (write) => {
      act(() => {
        write();
      });
      await tick();
    },
    settle: async () => {
      if (windowKind === "panel") {
        // The panel is only ever LISTED and operated, never compared, and its
        // HTML is the whole page, so reading it twice per settle is most of
        // the cost of walking it. Two macrotasks let what a write queued land.
        await tick();
        await tick();
        return;
      }
      // Two reads a macrotask apart that agree: nothing is mid-render.
      let previous = mount.signature();
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await tick();
        const next = mount.signature();
        if (next === previous) return;
        previous = next;
      }
    },
    unmount: () => {
      view.unmount();
      session?.dispose();
      __getOpenEpicRegistryForTests().disposeAll();
      __resetAgentActivityStoreForTests();
    },
  };
  await mount.settle();
  return mount;
}

/** Every store the sweep writes, put back for whatever runs next in the file. */
export function clearSweepStores(): void {
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  useLayoutEditorStore.getState().endSession();
}
