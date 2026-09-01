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
import * as Y from "yjs";
import { MobileAppHeader } from "@/components/layout/header/mobile-app-header";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { dispatchEpicWriteCommand } from "@/stores/epics/open-epic/runtime/epic-write-command-dispatch";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useMobileHeaderStore } from "@/stores/layout/mobile-header-store";
import { tabItemId } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  MockHostMessenger,
  type MockHandlerMap,
} from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { UpdateEpicRequest } from "@traycer/protocol/host/epic/unary-schemas";

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
function registerSession(title: string): OpenedStoreForTest {
  const handle = openStoreForTest({
    epicId: EPIC_ID,
    userId: null,
    // The factories go to the COMPOSITION now: the store stopped
    // constructing a runtime, so a `streamClientFactory` has nowhere
    // else to go.
    factories: {
      streamClientFactory: fakeStreamClientFactory,
      laneSelection: null,
    },
    writeCommand: null,
  });
  handle.store.setState({
    epic: { title, updatedAt: 1 },
    permissionRole: "owner",
  });
  __getOpenEpicRegistryForTests().acquire(EPIC_ID, () => handle);
  return handle;
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * A registered session whose write-command queue can actually SEND and
 * settle, for the one test that drives a rename through to commit. Unlike
 * {@link registerSession}, this seeds the epic title into the real Y.Doc and
 * opens the transport (`onConnectionStatus` before `onSnapshot` - the
 * control replica clears `hasFreshRootSnapshotForOpenCycle` on every
 * transport-status transition, including into "open", so opening first is
 * what lets the snapshot's own landing set it back to true) so the queue's
 * send gate (`transportStatus === "open" && hasFreshRootSnapshotForOpenCycle`)
 * is actually satisfied - `registerSession`'s bare `setState` never touches
 * that gate, so a rename fired against it would sit "queued" forever.
 */
function registerCommittableSession(title: string): {
  readonly handle: OpenedStoreForTest;
  readonly titleCalls: () => readonly UpdateEpicRequest[];
  readonly settleTitleUpdate: () => void;
} {
  const captured: { value: EpicStreamCallbacks | null } = { value: null };
  const factory: EpicStreamClientFactory = (_id, callbacks) => {
    captured.value = callbacks;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  const titleCalls: UpdateEpicRequest[] = [];
  const pendingSettles: (() => void)[] = [];
  const entry: HostDirectoryEntry = {
    hostId: "host-cold",
    label: "host-cold",
    kind: "local",
    websocketUrl: "ws://127.0.0.1:0",
    version: "1.5.0",
    transportDialability: "dialable",
  };
  const handlers: MockHandlerMap<HostRpcRegistry> = {
    "epic.updateTitle": (params) => {
      titleCalls.push(params);
      return new Promise((resolve) => {
        pendingSettles.push(() => resolve({ updated: true }));
      });
    },
  };
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (candidateHostId) =>
      candidateHostId === entry.hostId ? entry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${entry.hostId}`,
      handlers,
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const commandRequester: HostRequester<HostRpcRegistry> =
    spine.createRequester(entry);

  const handle = openStoreForTest({
    epicId: EPIC_ID,
    userId: null,
    // The factories go to the COMPOSITION now: the store stopped
    // constructing a runtime, so a `streamClientFactory` has nowhere
    // else to go.
    factories: {
      streamClientFactory: factory,
      laneSelection: null,
    },
    writeCommand: (commandId, intent) =>
      dispatchEpicWriteCommand(
        { epicId: EPIC_ID, requester: () => commandRequester },
        commandId,
        intent,
      ),
  });
  if (captured.value === null) throw new Error("factory not invoked");
  // Seeded into the real Y.Doc BEFORE the snapshot lands, so the FULL
  // projection the snapshot triggers reads it back as the epic header - the
  // honest replacement for forcing the projected `epic` slice directly.
  handle.doc.getMap("epic").set("title", title);
  handle.doc.getMap("epic").set("updatedAt", 1);
  captured.value.onConnectionStatus("open", null, false);
  captured.value.onSnapshot(
    {
      schemaVersion: "1.0",
      epicLight: {
        id: EPIC_ID,
        title,
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "open",
        createdAt: 0,
        updatedAt: 0,
        createdBy: "u",
        version: "1",
      },
      permissionRole: "owner",
      repos: [],
      workspaces: [],
      repoMapping: [],
      workspaceFolders: [],
      unresolvedRepos: [],
      hostStateVectorBase64: encodeBase64(Y.encodeStateVector(new Y.Doc())),
    },
    Y.encodeStateAsUpdate(new Y.Doc()),
  );
  __getOpenEpicRegistryForTests().acquire(EPIC_ID, () => handle);
  return {
    handle,
    titleCalls: () => titleCalls,
    settleTitleUpdate: () => pendingSettles[pendingSettles.length - 1]?.(),
  };
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
    const { handle, titleCalls, settleTitleUpdate } =
      registerCommittableSession("Old name");
    renderRestoredAtLanding();

    const field = await screen.findByTestId("mobile-epic-header-title");
    fireEvent.click(field);
    const input = await screen.findByLabelText("Epic title");
    fireEvent.change(input, { target: { value: "Renamed on the phone" } });
    fireEvent.blur(input);

    // Post-T11 this dispatches through the session's own write-command
    // queue, never `useEpicUpdateTitle` - and the queue's `onEnqueued` stamps
    // an optimistic overlay onto the projected `epic.title` the same way it
    // does an artifact rename onto `artifacts.byId`
    // (`epic-records-replica.ts`'s `stampWriteCommand` has an
    // `update-epic-title` arm calling `beginEpicTitleMutationWithId`, same
    // shape as the artifact arms beside it). So the header already reads the
    // committed-to-be title from the enqueue alone - no forced doc echo
    // needed to observe it.
    expect(titleCalls()).toHaveLength(1);
    const firstTitleCall = titleCalls().at(0);
    if (firstTitleCall === undefined) {
      throw new Error("expected a title update call");
    }
    const epicDelta = firstTitleCall.epicDelta;
    if (epicDelta === null) {
      throw new Error("expected the title update to carry an epic delta");
    }
    expect(epicDelta.id).toBe(EPIC_ID);
    expect(epicDelta.title).toBe("Renamed on the phone");
    expect(typeof epicDelta.updatedAt).toBe("number");
    await waitFor(() =>
      expect(screen.getByTestId("mobile-header-title").textContent).toBe(
        "Renamed on the phone",
      ),
    );

    // Settle the RPC so the command actually reaches "committed" (rather
    // than leaving it permanently "queued", which the header's optimistic
    // read alone would not catch a regression in).
    settleTitleUpdate();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(handle.store.getState().epic.title).toBe("Renamed on the phone");

    // The header still reads the committed name after settlement.
    expect(screen.getByTestId("mobile-header-title").textContent).toBe(
      "Renamed on the phone",
    );
    // The record really is still stale - the header is right because it stopped
    // reading it first, not because something refreshed it.
    expect(useEpicCanvasStore.getState().tabsById[TAB_ID]?.name).toBe(
      "Old name",
    );
  });
});
