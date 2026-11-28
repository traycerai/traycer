import "../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import { settleProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import {
  cloudEpicTasksQueryKey,
  LIST_CLOUD_TASKS_REQUEST,
} from "@/lib/cloud-epic-tasks-query";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import type { ListTasksResponse } from "@traycer/protocol/host/epic/unary-schemas";
import { toast } from "sonner";
import { MobileEpicHeaderTitle } from "@/components/epic-canvas/mobile/epic-mobile-header-actions";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useTabsStore } from "@/stores/tabs/store";
import { useHeaderTabForRef } from "@/stores/tabs/use-header-tabs";
import {
  getOpenEpicRegistry,
  handleHostIds,
} from "@/lib/registries/epic-session-registry";
import { registerEditableEpicSession } from "@/stores/epics/open-epic/test-support/editable-epic-session-fixture";
import type { EpicWriteCommandIntent } from "@/stores/epics/open-epic/runtime/epic-write-command";
import { useCloudEpicTasksPagesStore } from "@/stores/epics/cloud-epic-tasks-pages-store";
import {
  createTitleRequesterFixture,
  mountPoolServingWithHomeOffline,
  resetTitleRequesterFixture,
  seedPoolCloudHistoryRow,
  signInTaskTitleTestUser,
  titleUpdateCalls,
  TITLE_TEST_HOME_HOST_ID,
  TITLE_TEST_PINNED_HOST_ID,
  TITLE_TEST_USER_ID,
} from "@/lib/test-support/epic-title-requester-fixture";

const titleRequesterState = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
}));
const headerHostProjection = vi.hoisted(() => ({
  hostId: undefined as string | null | undefined,
}));

vi.mock("@/lib/host/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host/runtime")>();
  return {
    ...actual,
    getHostBindingSnapshot: () =>
      titleRequesterState.client === null
        ? null
        : { hostClient: titleRequesterState.client },
  };
});

vi.mock("@/stores/tabs/use-header-tabs", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/stores/tabs/use-header-tabs")>();
  return {
    ...actual,
    useHeaderTabForRef: (
      ref: Parameters<typeof actual.useHeaderTabForRef>[0],
    ) => {
      const tab = actual.useHeaderTabForRef(ref);
      if (tab?.kind !== "epic" || headerHostProjection.hostId === undefined) {
        return tab;
      }
      return { ...tab, hostId: headerHostProjection.hostId };
    },
  };
});

const EPIC_ID = "mobile-title-test-task";

function renderWithQueryClient(
  element: ReactElement,
  queryClient: QueryClient,
) {
  return render(
    <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>,
  );
}

function openFocusedEpicTab(): { readonly kind: "epic"; readonly id: string } {
  const id = useEpicCanvasStore.getState().openEpicTab(EPIC_ID, "Task title");
  const ref = { kind: "epic" as const, id };
  useTabsStore.getState().ensurePresent(ref);
  useTabsStore.getState().focusRef(ref);
  return ref;
}

function renderTitle(queryClient: QueryClient) {
  return renderWithQueryClient(
    <MobileEpicHeaderTitle epicId={EPIC_ID} title="Task title" />,
    queryClient,
  );
}

function openMobileTitleEdit(): HTMLElement {
  fireEvent.keyDown(screen.getByTestId("mobile-epic-header-title"), {
    key: "Enter",
  });
  return screen.getByTestId("mobile-epic-header-title-input");
}

function submitMobileTitle(input: HTMLElement, title: string): void {
  fireEvent.change(input, { target: { value: title } });
  fireEvent.keyDown(input, { key: "Enter" });
}

function resetCanvasAndTabs(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useTabsStore.setState(useTabsStore.getInitialState(), true);
}

beforeEach(() => {
  headerHostProjection.hostId = undefined;
  titleRequesterState.client = null;
  signInTaskTitleTestUser();
  settleProcessHostRpcTierPlan(poolEntry);
  resetCanvasAndTabs();
});

afterEach(() => {
  cleanup();
  headerHostProjection.hostId = undefined;
  titleRequesterState.client = null;
  resetTitleRequesterFixture();
  resetCanvasAndTabs();
  useCloudEpicTasksPagesStore.setState({
    pagesByIdentity: {},
    generationByIdentity: {},
    identitiesWithDisplacedRowsPage: new Set(),
    deletedEpicIdsByScope: {},
  });
  getOpenEpicRegistry().disposeAll();
});

describe("MobileEpicHeaderTitle requester fallback", () => {
  it("keeps the draft and routes through pool row evidence after the live home session detaches", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const requesterFixture = createTitleRequesterFixture();
    titleRequesterState.client = requesterFixture.client;
    mountPoolServingWithHomeOffline();
    seedPoolCloudHistoryRow(queryClient, EPIC_ID);
    const writes: EpicWriteCommandIntent[] = [];
    const session = registerEditableEpicSession({
      epicId: EPIC_ID,
      title: "Task title",
      userId: TITLE_TEST_USER_ID,
      hostId: TITLE_TEST_HOME_HOST_ID,
      writes,
    });
    handleHostIds.set(session.handle, TITLE_TEST_HOME_HOST_ID);
    const tabRef = openFocusedEpicTab();
    const projection = renderHook(() => useHeaderTabForRef(tabRef));
    expect(projection.result.current).toMatchObject({
      kind: "epic",
      hostId: TITLE_TEST_HOME_HOST_ID,
    });
    renderTitle(queryClient);
    const input = openMobileTitleEdit();

    act(() => {
      session.release();
    });
    await waitFor(() => {
      expect(projection.result.current).toMatchObject({
        kind: "epic",
        hostId: null,
      });
      expect(screen.getByTestId("mobile-epic-header-title-input")).toBe(input);
    });
    submitMobileTitle(input, "Pool task title");

    await waitFor(() => {
      expect(titleUpdateCalls(requesterFixture.messenger)).toEqual([
        {
          hostId: POOL_HOST_ID,
          epicId: EPIC_ID,
          title: "Pool task title",
        },
      ]);
    });
    expect(writes).toEqual([]);
    const poolPage = queryClient.getQueryData<ListTasksResponse>(
      cloudEpicTasksQueryKey(
        POOL_HOST_ID,
        TITLE_TEST_USER_ID,
        LIST_CLOUD_TASKS_REQUEST,
      ),
    );
    expect(
      poolPage?.tasks.find((task) => task.epic?.light?.id === EPIC_ID)?.epic
        ?.light?.title,
    ).toBe("Pool task title");
  });

  it("prefers a published pinned tab host over pool evidence after detachment", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const requesterFixture = createTitleRequesterFixture();
    titleRequesterState.client = requesterFixture.client;
    mountPoolServingWithHomeOffline();
    seedPoolCloudHistoryRow(queryClient, EPIC_ID);
    const session = registerEditableEpicSession({
      epicId: EPIC_ID,
      title: "Task title",
      userId: TITLE_TEST_USER_ID,
      hostId: TITLE_TEST_HOME_HOST_ID,
      writes: [],
    });
    handleHostIds.set(session.handle, TITLE_TEST_HOME_HOST_ID);
    const tabRef = openFocusedEpicTab();
    const projection = renderHook(() => useHeaderTabForRef(tabRef));
    const rendered = renderTitle(queryClient);
    const input = openMobileTitleEdit();

    act(() => {
      session.release();
    });
    await waitFor(() => {
      expect(projection.result.current).toMatchObject({
        kind: "epic",
        hostId: null,
      });
      expect(screen.getByTestId("mobile-epic-header-title-input")).toBe(input);
    });
    headerHostProjection.hostId = TITLE_TEST_PINNED_HOST_ID;
    projection.rerender();
    rendered.rerender(
      <QueryClientProvider client={queryClient}>
        <MobileEpicHeaderTitle epicId={EPIC_ID} title="Task title" />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(projection.result.current).toMatchObject({
        kind: "epic",
        hostId: TITLE_TEST_PINNED_HOST_ID,
      });
    });
    submitMobileTitle(input, "Pinned task title");

    await waitFor(() => {
      expect(titleUpdateCalls(requesterFixture.messenger)).toEqual([
        {
          hostId: TITLE_TEST_PINNED_HOST_ID,
          epicId: EPIC_ID,
          title: "Pinned task title",
        },
      ]);
    });
    const poolPage = queryClient.getQueryData<ListTasksResponse>(
      cloudEpicTasksQueryKey(
        POOL_HOST_ID,
        TITLE_TEST_USER_ID,
        LIST_CLOUD_TASKS_REQUEST,
      ),
    );
    expect(
      poolPage?.tasks.find((task) => task.epic?.light?.id === EPIC_ID)?.epic
        ?.light?.title,
    ).toBe("Task title");
  });

  it("keeps the existing no-peer error and sends nothing when detached without evidence", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const requesterFixture = createTitleRequesterFixture();
    titleRequesterState.client = requesterFixture.client;
    mountPoolServingWithHomeOffline();
    const session = registerEditableEpicSession({
      epicId: EPIC_ID,
      title: "Task title",
      userId: TITLE_TEST_USER_ID,
      hostId: TITLE_TEST_HOME_HOST_ID,
      writes: [],
    });
    handleHostIds.set(session.handle, TITLE_TEST_HOME_HOST_ID);
    const tabRef = openFocusedEpicTab();
    const projection = renderHook(() => useHeaderTabForRef(tabRef));
    renderTitle(queryClient);
    const input = openMobileTitleEdit();
    const failureToast = vi.spyOn(toast, "error");

    act(() => {
      session.release();
    });
    await waitFor(() => {
      expect(projection.result.current).toMatchObject({
        kind: "epic",
        hostId: null,
      });
      expect(screen.getByTestId("mobile-epic-header-title-input")).toBe(input);
    });
    submitMobileTitle(input, "No evidence title");

    await waitFor(() => {
      expect(failureToast).toHaveBeenCalledWith("Couldn't rename epic.");
    });
    expect(titleUpdateCalls(requesterFixture.messenger)).toEqual([]);
  });

  it("keeps the existing live-session queue ahead of any addressed unary", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const requesterFixture = createTitleRequesterFixture();
    titleRequesterState.client = requesterFixture.client;
    const writes: EpicWriteCommandIntent[] = [];
    registerEditableEpicSession({
      epicId: EPIC_ID,
      title: "Task title",
      userId: TITLE_TEST_USER_ID,
      hostId: TITLE_TEST_HOME_HOST_ID,
      writes,
    });
    openFocusedEpicTab();
    renderTitle(queryClient);
    const input = openMobileTitleEdit();
    submitMobileTitle(input, "Queued task title");

    await waitFor(() => {
      expect(writes).toMatchObject([
        { kind: "update-epic-title", title: "Queued task title" },
      ]);
    });
    expect(titleUpdateCalls(requesterFixture.messenger)).toEqual([]);
  });
});
