import "../../../../__tests__/test-browser-apis";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MobileAppHeader } from "@/components/layout/header/mobile-app-header";
import {
  __getOpenEpicRegistryForTests,
  __setEpicStreamClientFactoryForTests,
} from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useMobileHeaderStore } from "@/stores/layout/mobile-header-store";
import { tabItemId } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";

// Host-backed chrome only; the registry accessors the header reads for the
// epic's title and permission role stay REAL here - they are the half of the
// cold-restore path under test.
vi.mock("@/components/layout/header/rate-limit-icon", () => ({
  RateLimitIconButton: () => <button type="button" aria-label="Usage limits" />,
}));
vi.mock("@/components/resources/resource-monitor-popover", () => ({
  ResourceMonitorPopover: () => (
    <button type="button" aria-label="Resource monitor" />
  ),
}));
vi.mock("@/components/notifications/mobile-notifications-button", () => ({
  MobileNotificationsButton: () => (
    <button type="button" aria-label="Notifications" />
  ),
}));
const updateTitleMutateAsyncSpy = vi.hoisted(() =>
  vi.fn<(vars: { epicDelta: { title: string } }) => Promise<void>>(),
);
vi.mock("@/hooks/epic/use-epic-title-mutation", () => ({
  useEpicUpdateTitle: () => ({
    mutateAsync: updateTitleMutateAsyncSpy,
    isPending: false,
  }),
}));

const EPIC_ID = "epic-cold";
const TAB_ID = "tab-cold";

const fakeStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => {},
  awareness: () => {},
  applyArtifactRoomUpdate: () => {},
  artifactRoomAwareness: () => {},
  retryMigration: () => {},
  close: () => {},
});

/** The session the epic surface's provider has registered by now. */
function registerSession(title: string): OpenEpicStoreHandle {
  const handle = createOpenEpicStore({
    epicId: EPIC_ID,
    streamClientFactory: fakeStreamClientFactory,
    userId: null,
    onAuthError: null,
  });
  handle.store.setState({
    epic: { title, updatedAt: 1 },
    permissionRole: "owner",
  });
  __getOpenEpicRegistryForTests().acquire(EPIC_ID, () => handle);
  return handle;
}

/** The persisted tab record a restore rehydrates from localStorage. */
function seedTabRecord(name: string): void {
  useEpicCanvasStore.setState({
    tabsById: { [TAB_ID]: { tabId: TAB_ID, epicId: EPIC_ID, name } },
  });
}

/** The restored tab layout - the only thing that says which epic is on screen. */
function restoreEpicTabLayout(): void {
  const ref = { kind: "epic", id: TAB_ID } as const;
  const itemId = tabItemId(ref);
  useTabsStore.setState({
    items: [{ kind: "tab", id: itemId, ref }],
    activeItemId: itemId,
  });
}

/**
 * Renders the header at the LANDING route, which is where a cold-restored phone
 * actually sits: the shell has no route persistence, so its WebView boots at
 * `/` and the epic is known only from the restored tab layout. Rendering at
 * `/epics/...` here would hide every failure this file exists to catch.
 */
function renderRestoredAtLanding(): void {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <MobileAppHeader />
        <Outlet />
      </>
    ),
  });
  const nullComponent = () => null;
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: nullComponent,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/epics/$epicId/$tabId",
      component: nullComponent,
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  // `MobileEpicHeaderTitle` reads `useQueryClient()` for the session-host
  // success arm's cloud-cache patch; the mocked mutation hook used to hide
  // that dependency.
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/**
 * A cold restore reaches the header with the tab layout rehydrated and nothing
 * else primed: no route match, and none of the epic route's active-session
 * effects mounted. That last part is the point - those effects own the only
 * production write back into the tab record, so anything the header shows has
 * to come from a source that is live without them.
 */
describe("MobileAppHeader on a cold-restored epic tab", () => {
  beforeEach(() => {
    useEpicCanvasStore.setState({ tabsById: {} });
    useMobileHeaderStore.setState({ rightActionEntries: new Map() });
    useTabsStore.setState({ items: [], activeItemId: null });
    __getOpenEpicRegistryForTests().disposeAll();
    updateTitleMutateAsyncSpy.mockClear();
    updateTitleMutateAsyncSpy.mockResolvedValue(undefined);
    restoreEpicTabLayout();
  });

  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
    __setEpicStreamClientFactoryForTests(null);
    useEpicCanvasStore.setState({ tabsById: {} });
    useMobileHeaderStore.setState({ rightActionEntries: new Map() });
    useTabsStore.setState({ items: [], activeItemId: null });
  });

  // The restored layout names a TAB; only the tab record maps that id to an
  // epic. Without it there is no epic identity to resolve a session against, so
  // no title is the honest answer rather than a defect.
  it("renders no title when the layout has a tab the canvas has no record for", async () => {
    registerSession("Ship the mobile header");
    renderRestoredAtLanding();
    await screen.findByRole("button", { name: "Open menu" });

    expect(screen.queryByTestId("mobile-header-title")).toBeNull();
  });

  it("holds an empty title slot until a name resolves, then resolves", async () => {
    // The record maps the tab to its epic but carries no usable name yet.
    seedTabRecord("");
    renderRestoredAtLanding();
    await screen.findByRole("button", { name: "Open menu" });
    // No stand-in: an unresolved name renders no title rather than a
    // placeholder the real name would then replace.
    expect(screen.queryByTestId("mobile-header-title")).toBeNull();

    registerSession("Resolved later");

    await waitFor(() =>
      expect(screen.getByTestId("mobile-header-title").textContent).toBe(
        "Resolved later",
      ),
    );
  });

  it("falls back to the persisted tab record before the session registers", async () => {
    seedTabRecord("Persisted name");
    renderRestoredAtLanding();

    await waitFor(() =>
      expect(screen.getByTestId("mobile-header-title").textContent).toBe(
        "Persisted name",
      ),
    );
  });

  it("prefers the live session title over a stale tab record", async () => {
    seedTabRecord("Stale name");
    registerSession("Live name");
    renderRestoredAtLanding();

    await waitFor(() =>
      expect(screen.getByTestId("mobile-header-title").textContent).toBe(
        "Live name",
      ),
    );
  });

  // A tab record can carry a blank name; showing it would open the rename
  // field on an epic that does have a title.
  it("treats a blank tab record name as unresolved", async () => {
    seedTabRecord("   ");
    renderRestoredAtLanding();
    await screen.findByRole("button", { name: "Open menu" });

    expect(screen.queryByTestId("mobile-header-title")).toBeNull();
  });

  // The rename field is editable in exactly this state, so the name it shows
  // has to be the one its own commit lands in. The tab record is NOT that
  // place: its only production writer is the epic route's active-session title
  // sync, which is unmounted here - so a header reading the record would keep
  // rendering the pre-rename name after a successful commit, and keep it
  // across the next restart too.
  it("shows the committed name after a rename, not the stale tab record", async () => {
    seedTabRecord("Old name");
    const handle = registerSession("Old name");
    renderRestoredAtLanding();

    const field = await screen.findByTestId("mobile-epic-header-title");
    fireEvent.click(field);
    const input = await screen.findByLabelText("Epic title");
    fireEvent.change(input, { target: { value: "Renamed on the phone" } });
    fireEvent.blur(input);

    expect(updateTitleMutateAsyncSpy).toHaveBeenCalledTimes(1);
    // Flush the retire `.then` arm before the manual echo below, so the
    // "landed" retire and the doc-echo overlay resolution happen in the
    // documented order rather than racing.
    await act(async () => {
      await Promise.resolve();
    });
    // The committed title landing in the epic doc is what the live session
    // projects back; the host round trip is the mocked half.
    handle.store.setState({
      epic: {
        title: "Renamed on the phone",
        updatedAt: 2,
      },
    });

    await waitFor(() =>
      expect(screen.getByTestId("mobile-header-title").textContent).toBe(
        "Renamed on the phone",
      ),
    );
    // The record really is still stale - the header is right because it stopped
    // reading it first, not because something refreshed it.
    expect(useEpicCanvasStore.getState().tabsById[TAB_ID]?.name).toBe(
      "Old name",
    );
  });
});
