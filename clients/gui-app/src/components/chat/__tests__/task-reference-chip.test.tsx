/**
 * A complete task id in a message is a chip with the task's title that opens
 * the task (Tracy Bots, decision 100): drawn through the real markdown path
 * (`TextSegment` -> `AgentReferenceMarkdown` -> the reference plugin), with the
 * title read from the real query cache and `epic.getTaskContexts` answered by a
 * stub host. An agent of the open epic still wins the id; anything that names
 * nothing stays as written. A shorter id-shaped token is the chip of the one
 * task the window already holds whose id it begins, and is read from no host.
 */
import { StrictMode, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GetTaskContextsResponse,
  ListTaskLight,
  ListTasksResponse,
  TaskContextResult,
} from "@traycer/protocol/host/epic/unary-schemas";
import { TracyTranscriptOriginScope } from "@/components/bots/tracy-transcript-origin-scope";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { makeMessage } from "@/components/chat/__tests__/chat-message-fixtures";
import {
  ChatBotPresentationContext,
  type ChatBotPresentation,
} from "@/components/chat/chat-bot-presentation-context";
import { ChatMessage } from "@/components/chat/chat-message";
import { TextSegment } from "@/components/chat/segments/text-segment";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { TabActivationIntent } from "@/lib/tab-navigation";
import { queryKeys } from "@/lib/query-keys";
import { taskReferenceLookupKey } from "@/lib/query-keys/__tests__/task-reference-lookup-key";
import {
  recheckTaskContextAnswers,
  removeDeletedEpicsFromCloudTaskCaches,
} from "@/lib/cloud-epic-tasks-query/cache";
import {
  LIST_CLOUD_TASKS_REQUEST,
  cloudEpicTasksQueryKey,
} from "@/lib/cloud-epic-tasks-query";
import {
  recordTaskLoss,
  taskLossFor,
  useTaskLossRegister,
} from "@/stores/epics/task-loss-register-store";
import {
  EpicSessionContext,
  getOpenEpicRegistry,
  handleHostIds,
} from "@/lib/registries/epic-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type {
  EpicStreamClientFactory,
  OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";

const HOST_ID = "host-test";
const USER_ID = "user-test";
const SIBLING_HOST_ID = "host-sibling";
const TASK_ID = "6f1c2a9e-4b7d-4e21-9c3a-1d2e3f4a5b6c";
const AGENT_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
/** A task whose id shares its first 8 characters with `AGENT_ID`. */
const TWIN_TASK_ID = `${AGENT_ID.slice(0, 8)}-1111-4222-8333-444455556666`;
/** A second task whose id shares its first 8 characters with `TASK_ID`. */
const SIBLING_TASK_ID = `${TASK_ID.slice(0, 8)}-aaaa-4bbb-8ccc-ddddeeeeffff`;
/** A task whose id no token in these cases begins. */
const UNRELATED_TASK_ID = "c0ffee00-1111-4222-8333-444455556666";
/** Another unrelated task, for a change to the window's list. */
const OTHER_UNRELATED_TASK_ID = "d1ce5eed-1111-4222-8333-444455556666";
/** The chip's own lookup of `TASK_ID`. */
const OWN_LOOKUP_KEY = taskReferenceLookupKey(HOST_ID, USER_ID, TASK_ID);
/** History's first page of tasks. */
const LIST_KEY = cloudEpicTasksQueryKey(
  HOST_ID,
  USER_ID,
  LIST_CLOUD_TASKS_REQUEST,
);
/** Another surface's lookup (the tab strip's, over every open tab). */
const OTHER_LOOKUP_KEY = queryKeys.hostEpicTaskContexts(HOST_ID, USER_ID, [
  TASK_ID,
  AGENT_ID,
]);

const mocks = vi.hoisted(() => {
  const request =
    vi.fn<(method: string, params: unknown) => Promise<unknown>>();
  return {
    request,
    client: {
      getActiveHostId: () => "host-test",
      getRequestContextUserId: () => "user-test",
      onChange: () => () => undefined,
      request,
      requestWithSignal: request,
    },
    activateTabIntent: vi.fn<(navigate: unknown, intent: unknown) => void>(),
    openEpicInBackground:
      vi.fn<
        (epicId: string, title: string | undefined, source: string) => void
      >(),
    records: [] as ReadonlyArray<{
      readonly id: string;
      readonly type: string;
      readonly name: string;
    }>,
    // Each host query operation the chip's lookups run, from the request
    // through `mapResponse`, captured when it starts.
    operations: [] as Array<Promise<unknown>>,
  };
});

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useOptionalHostClient: () => mocks.client,
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: "host-test",
    isReady: true,
    hasRpcEndpoint: true,
    canExecute: true,
    requestContextUserId: "user-test",
  }),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
  useRouter: () => ({ state: { location: { pathname: "/epics" } } }),
}));

// Runs the real boundary unchanged and keeps the operation it returns, so a
// test can await a lookup's whole run - the host's answer, then its mapping
// and admission - even after the query that started it was cancelled.
vi.mock("@/lib/query/host-query-error-boundary", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/lib/query/host-query-error-boundary")
    >();
  return {
    ...original,
    withHostQueryErrorBoundary: <T,>(
      method: string,
      run: () => Promise<T>,
    ): Promise<T> => {
      const operation = original.withHostQueryErrorBoundary(method, run);
      mocks.operations.push(operation);
      return operation;
    },
  };
});

vi.mock("@/lib/tab-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
  activateTabIntent: mocks.activateTabIntent,
}));

vi.mock("@/lib/commands/actions/open-epic-in-background", () => ({
  openEpicInBackground: mocks.openEpicInBackground,
}));

vi.mock("@/components/ui/tooltip-wrapper", () => ({
  TooltipWrapper: (props: {
    readonly label: string;
    readonly children: ReactNode;
  }) => <span data-tooltip={props.label}>{props.children}</span>,
}));

// The open epic's agents; the rest of the module (a mounted task's live
// title among it) is the real one.
vi.mock("@/lib/epic-selectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/epic-selectors")>()),
  useEpicArtifactRecords: () => mocks.records,
  useEpicAgentRoleClaimsByAgentId: () => ({}),
  useOpenEpicId: () => "epic-1",
  useEpicChatHarnessId: () => null,
  useMaybeEpicTuiAgentHarnessId: () => null,
}));

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: vi.fn() }),
}));

vi.mock("@/hooks/epic/use-epic-agent-open-ref", () => ({
  useEpicAgentOpenRef: () => () => ({ id: "agent", type: "chat" }),
}));

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function listTaskLight(id: string, title: string): ListTaskLight {
  return {
    epic: {
      light: {
        id,
        title,
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "draft",
        createdAt: 0,
        updatedAt: 0,
        createdBy: USER_ID,
        version: "1.0.0",
      },
      permission: null,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
    pinned: false,
  };
}

/** The window's task list holds `tasks`, as History's first page would. */
function holdTasksInList(tasks: ReadonlyArray<ListTaskLight>): void {
  queryClient.setQueryData<ListTasksResponse>(LIST_KEY, {
    tasks: [...tasks],
    hasMore: false,
    facets: { repos: [], workspaces: [], ownershipScopes: [] },
  });
}

/**
 * `count` distinct 8-character tokens, none the start of a held task's id.
 */
function unheldPrefixes(count: number): ReadonlyArray<string> {
  return Array.from({ length: count }, (_, index) =>
    index.toString(16).padStart(8, "a"),
  );
}

/** The host names each asked id from `titles`, and finds no other. */
function answerLookups(titles: Readonly<Record<string, string>>): void {
  mocks.request.mockImplementation((method, params) => {
    if (method !== "epic.getTaskContexts") {
      return Promise.reject(new Error(`unexpected method: ${method}`));
    }
    return Promise.resolve(lookupAnswer(titles, params));
  });
}

function lookupAnswer(
  titles: Readonly<Record<string, string>>,
  params: unknown,
): GetTaskContextsResponse {
  const { taskIds } = params as { readonly taskIds: readonly string[] };
  const tasks: GetTaskContextsResponse["tasks"] = {};
  for (const id of taskIds) {
    tasks[id] = Object.hasOwn(titles, id)
      ? { status: "found", task: listTaskLight(id, titles[id]) }
      : { status: "confirmed-absent" };
  }
  return { tasks };
}

function lookedUpIds(): ReadonlyArray<string> {
  return mocks.request.mock.calls.flatMap(([method, params]) =>
    method === "epic.getTaskContexts"
      ? (params as { readonly taskIds: readonly string[] }).taskIds
      : [],
  );
}

let queryClient: QueryClient;

/** The task's deletion as the deleting window publishes it. */
function deleteTask(): void {
  removeDeletedEpicsFromCloudTaskCaches(
    queryClient,
    { hostId: null, userId: USER_ID },
    [TASK_ID],
  );
}

/** Every lookup started so far has run to its end, response mapping included. */
async function lookupsCompleted(): Promise<void> {
  await act(async () => {
    await Promise.allSettled(mocks.operations);
  });
}

function Providers(props: { readonly children: ReactNode }): ReactNode {
  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>{props.children}</TooltipProvider>
      </QueryClientProvider>
    </StrictMode>
  );
}

function renderMarkdown(markdown: string): HTMLElement {
  return render(
    <TextSegment
      findUnitId={null}
      markdown={markdown}
      isStreaming={false}
      nextStepActions={null}
    />,
    { wrapper: Providers },
  ).container;
}

/** An open epic behind the markdown, whose agents are `mocks.records`. */
function renderInOpenEpic(markdown: string): HTMLElement {
  const handle = {} as OpenEpicStoreHandle;
  handleHostIds.set(handle, HOST_ID);
  return render(
    <EpicSessionContext value={handle}>
      <TextSegment
        findUnitId={null}
        markdown={markdown}
        isStreaming={false}
        nextStepActions={null}
      />
    </EpicSessionContext>,
    { wrapper: Providers },
  ).container;
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  mocks.records = [];
  mocks.operations.length = 0;
  useTaskLossRegister.setState({ byUserId: {} });
  useAuthStore
    .getState()
    .setSignedIn(
      { userId: USER_ID, userName: "U", email: "u@example.com" },
      { userId: USER_ID, username: "U" },
      [],
    );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.request.mockReset();
  useAuthStore.getState().setSignedOut();
});

describe("a task id in a message", () => {
  it("is a chip with the task's title and no visible id, which opens the task", async () => {
    answerLookups({ [TASK_ID]: "Ship the release" });
    const container = renderMarkdown(`In flight: ${TASK_ID} today.`);

    const chip = await screen.findByRole("button", {
      name: "Ship the release",
    });
    expect(chip.getAttribute("data-task-reference")).toBe(TASK_ID);
    expect(container.textContent).toBe("In flight: Ship the release today.");
    expect(chip.closest("[data-tooltip]")?.getAttribute("data-tooltip")).toBe(
      `Ship the release\n${TASK_ID}`,
    );

    fireEvent.click(chip);

    expect(mocks.activateTabIntent).toHaveBeenCalledTimes(1);
    const intent = mocks.activateTabIntent.mock.calls[0]?.[1] as Extract<
      TabActivationIntent,
      { kind: "open-epic" }
    >;
    expect(intent).toMatchObject({
      kind: "open-epic",
      epicId: TASK_ID,
      name: "Ship the release",
      tracyOrigin: null,
    });
  });

  it("hands the controller the transcript's bot when the chip is drawn inside a Tracy transcript", async () => {
    answerLookups({ [TASK_ID]: "Ship the release" });
    render(
      <TracyTranscriptOriginScope botId="bot-1">
        <TextSegment
          findUnitId={null}
          markdown={`In flight: ${TASK_ID} today.`}
          isStreaming={false}
          nextStepActions={null}
        />
      </TracyTranscriptOriginScope>,
      { wrapper: Providers },
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Ship the release" }),
    );

    expect(mocks.activateTabIntent.mock.calls[0]?.[1]).toMatchObject({
      kind: "open-epic",
      epicId: TASK_ID,
      tracyOrigin: { botId: "bot-1" },
    });
  });

  it("is the task's chip inside an open epic whose agents do not claim it", async () => {
    answerLookups({ [TASK_ID]: "Ship the release" });
    mocks.records = [{ id: AGENT_ID, type: "chat", name: "Planner" }];
    renderInOpenEpic(`See ${TASK_ID}.`);

    expect(
      await screen.findByRole("button", { name: "Ship the release" }),
    ).toBeTruthy();
  });

  it("stays the agent's chip when an agent of the open epic has that id", () => {
    answerLookups({ [AGENT_ID]: "A task by the same id" });
    mocks.records = [{ id: AGENT_ID, type: "chat", name: "Planner" }];
    renderInOpenEpic(`Ask ${AGENT_ID}.`);

    const chip = screen.getByRole("button", { name: "Planner" });
    expect(chip.getAttribute("data-agent-reference")).toBe(AGENT_ID);
    expect(screen.queryByText("A task by the same id")).toBeNull();
    expect(lookedUpIds()).toEqual([]);
  });

  it("leaves a complete id that names nothing the person can open as text", async () => {
    answerLookups({});
    const container = renderMarkdown(`Gone: ${TASK_ID}.`);

    await waitFor(() => {
      expect(queryClient.getQueryState(OWN_LOOKUP_KEY)?.status).toBe("success");
    });
    expect(lookedUpIds()).toEqual([TASK_ID]);
    expect(container.textContent).toBe(`Gone: ${TASK_ID}.`);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps a task id in a code span as code", () => {
    answerLookups({ [TASK_ID]: "Ship the release" });
    renderMarkdown(`Run \`${TASK_ID}\`.`);

    expect(screen.getByText(TASK_ID).tagName).toBe("CODE");
    expect(screen.queryByRole("button")).toBeNull();
    expect(lookedUpIds()).toEqual([]);
  });

  it("is the id as text until the title arrives, then the chip, in the same paragraph", async () => {
    let answer: (response: GetTaskContextsResponse) => void = () => undefined;
    mocks.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const container = renderMarkdown(`In flight: ${TASK_ID}.`);
    const paragraph = container.querySelector("p");
    expect(paragraph?.textContent).toBe(`In flight: ${TASK_ID}.`);
    expect(screen.queryByRole("button")).toBeNull();
    await waitFor(() => {
      expect(lookedUpIds()).toContain(TASK_ID);
    });

    act(() => {
      answer(
        lookupAnswer({ [TASK_ID]: "Ship the release" }, { taskIds: [TASK_ID] }),
      );
    });

    expect(
      await screen.findByRole("button", { name: "Ship the release" }),
    ).toBeTruthy();
    expect(container.querySelector("p")).toBe(paragraph);
  });

  it("is the chip on first render when a lookup the window holds names it, and asks nothing", async () => {
    answerLookups({ [TASK_ID]: "Ship the release" });
    queryClient.setQueryData(
      OTHER_LOOKUP_KEY,
      lookupAnswer({ [TASK_ID]: "Ship the release" }, { taskIds: [TASK_ID] }),
    );
    renderMarkdown(`In flight: ${TASK_ID}.`);

    expect(
      screen.getByRole("button", { name: "Ship the release" }),
    ).toBeTruthy();
    await lookupsCompleted();
    expect(lookedUpIds()).toEqual([]);
  });

  it("goes back to text when its own lookup finds the task gone or out of reach, whatever an older lookup says", async () => {
    const outcomes: ReadonlyArray<TaskContextResult> = [
      { status: "confirmed-absent" },
      { status: "unknown", reason: "denied" },
    ];
    for (const outcome of outcomes) {
      queryClient.clear();
      queryClient.setQueryData(
        OTHER_LOOKUP_KEY,
        lookupAnswer({ [TASK_ID]: "Ship the release" }, { taskIds: [TASK_ID] }),
      );
      const container = renderMarkdown(`In flight: ${TASK_ID}.`);
      expect(
        screen.getByRole("button", { name: "Ship the release" }),
      ).toBeTruthy();

      act(() => {
        queryClient.setQueryData<GetTaskContextsResponse>(OWN_LOOKUP_KEY, {
          tasks: { [TASK_ID]: outcome },
        });
      });

      await waitFor(() => {
        expect(screen.queryByRole("button")).toBeNull();
      });
      expect(container.textContent).toBe(`In flight: ${TASK_ID}.`);
      cleanup();
    }
  });

  it("goes back to text and asks nothing more once the task is deleted", async () => {
    answerLookups({ [TASK_ID]: "Ship the release" });
    renderMarkdown(`In flight: ${TASK_ID}.`);
    await screen.findByRole("button", { name: "Ship the release" });

    act(() => {
      deleteTask();
    });

    await waitFor(() => {
      expect(screen.queryByRole("button")).toBeNull();
    });
    await lookupsCompleted();
    expect(lookedUpIds()).toEqual([TASK_ID]);
  });

  it("draws a task the window lists as its chip with no read, and its raw id once the task is deleted", async () => {
    answerLookups({ [TASK_ID]: "Ship the release" });
    queryClient.setQueryData<ListTasksResponse>(LIST_KEY, {
      tasks: [listTaskLight(TASK_ID, "Ship the release")],
      hasMore: false,
      facets: { repos: [], workspaces: [], ownershipScopes: [] },
    });
    const container = renderMarkdown(`In flight: ${TASK_ID}.`);
    expect(
      screen.getByRole("button", { name: "Ship the release" }),
    ).toBeTruthy();

    act(() => {
      deleteTask();
    });

    await waitFor(() => {
      expect(container.textContent).toBe(`In flight: ${TASK_ID}.`);
    });
    await lookupsCompleted();
    expect(screen.queryByRole("button")).toBeNull();
    expect(lookedUpIds()).toEqual([]);
  });

  it("does not let an answer to a read sent before the deletion make the task reachable again", async () => {
    let answer: (response: GetTaskContextsResponse) => void = () => undefined;
    mocks.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const container = renderMarkdown(`In flight: ${TASK_ID}.`);
    await waitFor(() => {
      expect(lookedUpIds()).toEqual([TASK_ID]);
    });

    act(() => {
      deleteTask();
      answer(
        lookupAnswer({ [TASK_ID]: "Ship the release" }, { taskIds: [TASK_ID] }),
      );
    });
    await lookupsCompleted();

    expect(container.textContent).toBe(`In flight: ${TASK_ID}.`);
    expect(screen.queryByRole("button")).toBeNull();

    // A read after the deletion answering from a page that predates it. The
    // chip no longer asks, so the read is forced through the query itself.
    answerLookups({ [TASK_ID]: "Ship the release" });
    await act(async () => {
      await queryClient
        .getQueryCache()
        .find({ queryKey: OWN_LOOKUP_KEY, exact: true })
        ?.fetch();
    });
    expect(lookedUpIds()).toEqual([TASK_ID, TASK_ID]);

    expect(container.textContent).toBe(`In flight: ${TASK_ID}.`);
    expect(screen.queryByRole("button")).toBeNull();
    expect(
      queryClient.getQueryData<GetTaskContextsResponse>(OWN_LOOKUP_KEY)?.tasks[
        TASK_ID
      ],
    ).toEqual({ status: "confirmed-absent" });
  });

  it("asks again when the person may have lost the task, and stays the chip when they still reach it", async () => {
    answerLookups({ [TASK_ID]: "Ship the release" });
    renderMarkdown(`In flight: ${TASK_ID}.`);
    await screen.findByRole("button", { name: "Ship the release" });

    // An open task's session losing access: a moved room raises it as a
    // revoke does.
    act(() => {
      recheckTaskContextAnswers(
        queryClient,
        { hostId: null, userId: USER_ID },
        [TASK_ID],
      );
    });

    await waitFor(() => {
      expect(lookedUpIds()).toEqual([TASK_ID, TASK_ID]);
    });
    expect(
      await screen.findByRole("button", { name: "Ship the release" }),
    ).toBeTruthy();
  });

  it("asks again when the person may have lost a task the window lists, and goes back to text when it is out of reach", async () => {
    mocks.request.mockImplementation(() =>
      Promise.resolve({
        tasks: { [TASK_ID]: { status: "unknown", reason: "denied" } },
      } satisfies GetTaskContextsResponse),
    );
    queryClient.setQueryData<ListTasksResponse>(LIST_KEY, {
      tasks: [listTaskLight(TASK_ID, "Ship the release")],
      hasMore: false,
      facets: { repos: [], workspaces: [], ownershipScopes: [] },
    });
    const container = renderMarkdown(`In flight: ${TASK_ID}.`);
    expect(
      screen.getByRole("button", { name: "Ship the release" }),
    ).toBeTruthy();

    act(() => {
      recheckTaskContextAnswers(
        queryClient,
        { hostId: null, userId: USER_ID },
        [TASK_ID],
      );
    });

    await waitFor(() => {
      expect(container.textContent).toBe(`In flight: ${TASK_ID}.`);
    });
    expect(lookedUpIds()).toEqual([TASK_ID]);
  });

  it("reads again when the person may have lost the task while its first lookup is pending, and settles on that answer", async () => {
    const answers: Array<(response: GetTaskContextsResponse) => void> = [];
    mocks.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          answers.push(resolve);
        }),
    );
    const container = renderMarkdown(`In flight: ${TASK_ID}.`);
    await waitFor(() => {
      expect(lookedUpIds()).toEqual([TASK_ID]);
    });

    act(() => {
      recheckTaskContextAnswers(
        queryClient,
        { hostId: null, userId: USER_ID },
        [TASK_ID],
      );
    });
    await waitFor(() => {
      expect(lookedUpIds()).toEqual([TASK_ID, TASK_ID]);
    });
    // The read sent before the signal answers found; the one sent after it
    // answers that the task is out of reach.
    act(() => {
      answers[0]?.(
        lookupAnswer({ [TASK_ID]: "Ship the release" }, { taskIds: [TASK_ID] }),
      );
      answers[1]?.({
        tasks: { [TASK_ID]: { status: "unknown", reason: "denied" } },
      });
    });
    await lookupsCompleted();

    expect(container.textContent).toBe(`In flight: ${TASK_ID}.`);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("does not admit a found answer to a read sent before a possible loss, whatever ends that read", async () => {
    let answer: (response: GetTaskContextsResponse) => void = () => undefined;
    mocks.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const container = renderMarkdown(`In flight: ${TASK_ID}.`);
    await waitFor(() => {
      expect(lookedUpIds()).toEqual([TASK_ID]);
    });

    // The loss recorded with nothing cancelling the read in flight.
    act(() => {
      recordTaskLoss({ hostId: null, userId: USER_ID }, [TASK_ID], "recheck");
      answer(
        lookupAnswer({ [TASK_ID]: "Ship the release" }, { taskIds: [TASK_ID] }),
      );
    });
    await waitFor(() => {
      expect(queryClient.getQueryState(OWN_LOOKUP_KEY)?.status).toBe("success");
    });

    expect(container.textContent).toBe(`In flight: ${TASK_ID}.`);
    expect(
      queryClient.getQueryData<GetTaskContextsResponse>(OWN_LOOKUP_KEY)?.tasks,
    ).toEqual({});
    expect(queryClient.getQueryState(OWN_LOOKUP_KEY)?.isInvalidated).toBe(
      false,
    );
    expect(
      queryClient
        .getQueryCache()
        .find({ queryKey: OWN_LOOKUP_KEY, exact: true })
        ?.isStale(),
    ).toBe(true);
  });

  it("keeps a task deleted on its host as text when every host is asked to read it again, and a sibling host is untouched", async () => {
    mocks.request.mockImplementation(() =>
      Promise.resolve({
        tasks: { [TASK_ID]: { status: "unknown", reason: "transport" } },
      } satisfies GetTaskContextsResponse),
    );
    // Another host's list still names the task.
    queryClient.setQueryData<ListTasksResponse>(
      cloudEpicTasksQueryKey(
        SIBLING_HOST_ID,
        USER_ID,
        LIST_CLOUD_TASKS_REQUEST,
      ),
      {
        tasks: [listTaskLight(TASK_ID, "Ship the release")],
        hasMore: false,
        facets: { repos: [], workspaces: [], ownershipScopes: [] },
      },
    );
    removeDeletedEpicsFromCloudTaskCaches(
      queryClient,
      { hostId: HOST_ID, userId: USER_ID },
      [TASK_ID],
    );
    const container = renderMarkdown(`In flight: ${TASK_ID}.`);
    expect(container.textContent).toBe(`In flight: ${TASK_ID}.`);

    act(() => {
      recheckTaskContextAnswers(
        queryClient,
        { hostId: null, userId: USER_ID },
        [TASK_ID],
      );
    });
    await waitFor(() => {
      expect(
        taskLossFor(
          useTaskLossRegister.getState(),
          USER_ID,
          SIBLING_HOST_ID,
          TASK_ID,
        )?.loss,
      ).toBe("recheck");
    });
    await lookupsCompleted();

    expect(container.textContent).toBe(`In flight: ${TASK_ID}.`);
    expect(screen.queryByRole("button")).toBeNull();
    expect(lookedUpIds()).toEqual([]);
  });

  it("keeps a settled answer through host reconnects instead of reading it again", async () => {
    answerLookups({});
    renderMarkdown(`Gone: ${TASK_ID}.`);
    await waitFor(() => {
      expect(queryClient.getQueryState(OWN_LOOKUP_KEY)?.status).toBe("success");
    });

    // Two reconnects' recovery sweeps over the host's reads.
    for (let sweep = 0; sweep < 2; sweep += 1) {
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ["host", HOST_ID] });
      });
    }

    expect(lookedUpIds()).toEqual([TASK_ID]);
  });

  it("keeps its lookup for the session, so a row drawn again later is the chip at once and asks nothing more", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      answerLookups({ [TASK_ID]: "Ship the release" });
      renderMarkdown(`In flight: ${TASK_ID}.`);
      await screen.findByRole("button", { name: "Ship the release" });
      cleanup();
      // Past every title lookup's stale window.
      vi.setSystemTime(Date.now() + 60 * 60_000);

      renderMarkdown(`In flight: ${TASK_ID}.`);

      expect(
        screen.getByRole("button", { name: "Ship the release" }),
      ).toBeTruthy();
      await lookupsCompleted();
      expect(lookedUpIds()).toEqual([TASK_ID]);
      expect(
        queryClient.getQueryCache().find({ queryKey: OWN_LOOKUP_KEY })?.gcTime,
      ).toBe(Infinity);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens the task in a background tab on a Cmd/Ctrl-click or a middle click, and in place on a plain click", async () => {
    answerLookups({ [TASK_ID]: "Ship the release" });
    renderMarkdown(`In flight: ${TASK_ID}.`);
    const chip = await screen.findByRole("button", {
      name: "Ship the release",
    });

    fireEvent.click(chip, { metaKey: true });
    fireEvent.click(chip, { ctrlKey: true });
    fireEvent(
      chip,
      new MouseEvent("auxclick", {
        bubbles: true,
        cancelable: true,
        button: 1,
      }),
    );

    expect(mocks.openEpicInBackground.mock.calls).toEqual([
      [TASK_ID, "Ship the release", "message_task_chip"],
      [TASK_ID, "Ship the release", "message_task_chip"],
      [TASK_ID, "Ship the release", "message_task_chip"],
    ]);
    expect(mocks.activateTabIntent).not.toHaveBeenCalled();

    fireEvent.click(chip);

    expect(mocks.activateTabIntent).toHaveBeenCalledTimes(1);
    expect(mocks.openEpicInBackground).toHaveBeenCalledTimes(3);
  });
});

describe("a task id prefix in a message", () => {
  afterEach(() => {
    getOpenEpicRegistry().disposeAll();
  });

  it("is the chip of the one task the window lists, on first render, and asks nothing", async () => {
    answerLookups({ [TASK_ID]: "Ship the release" });
    holdTasksInList([listTaskLight(TASK_ID, "Ship the release")]);
    const prefix = TASK_ID.slice(0, 8);
    const container = renderMarkdown(`Fixed in ${prefix}.`);

    const chip = screen.getByRole("button", { name: "Ship the release" });
    expect(chip.getAttribute("data-task-reference")).toBe(TASK_ID);
    expect(container.querySelector("p")?.textContent).toBe(
      "Fixed in Ship the release.",
    );
    expect(chip.closest("[data-tooltip]")?.getAttribute("data-tooltip")).toBe(
      `Ship the release\n${TASK_ID}`,
    );

    fireEvent.click(chip);

    expect(mocks.activateTabIntent).toHaveBeenCalledTimes(1);
    const intent = mocks.activateTabIntent.mock.calls[0]?.[1] as Extract<
      TabActivationIntent,
      { kind: "open-epic" }
    >;
    expect(intent).toMatchObject({ kind: "open-epic", epicId: TASK_ID });
    await lookupsCompleted();
    expect(lookedUpIds()).toEqual([]);
  });

  it("is the chip of a task a cached title lookup found, for a prefix running past the first group", async () => {
    answerLookups({ [TASK_ID]: "Ship the release" });
    queryClient.setQueryData(
      OTHER_LOOKUP_KEY,
      lookupAnswer({ [TASK_ID]: "Ship the release" }, { taskIds: [TASK_ID] }),
    );
    renderMarkdown(`Fixed in ${TASK_ID.slice(0, 13)}.`);

    const chip = screen.getByRole("button", { name: "Ship the release" });
    expect(chip.getAttribute("data-task-reference")).toBe(TASK_ID);
    await lookupsCompleted();
    expect(lookedUpIds()).toEqual([]);
  });

  it("matches the task whatever the case of the prefix", async () => {
    answerLookups({ [TASK_ID]: "Ship the release" });
    holdTasksInList([listTaskLight(TASK_ID, "Ship the release")]);
    renderMarkdown(`Fixed in ${TASK_ID.slice(0, 8).toUpperCase()}.`);

    const chip = screen.getByRole("button", { name: "Ship the release" });
    expect(chip.getAttribute("data-task-reference")).toBe(TASK_ID);
    await lookupsCompleted();
    expect(lookedUpIds()).toEqual([]);
  });

  it("stays the agent's chip when an agent of the open epic and a held task share the prefix", async () => {
    answerLookups({ [TWIN_TASK_ID]: "A task by the same prefix" });
    holdTasksInList([listTaskLight(TWIN_TASK_ID, "A task by the same prefix")]);
    mocks.records = [{ id: AGENT_ID, type: "chat", name: "Planner" }];
    renderInOpenEpic(`Ask ${AGENT_ID.slice(0, 8)}.`);

    const chip = screen.getByRole("button", { name: "Planner" });
    expect(chip.getAttribute("data-agent-reference")).toBe(AGENT_ID);
    expect(screen.queryByText("A task by the same prefix")).toBeNull();
    await lookupsCompleted();
    expect(lookedUpIds()).toEqual([]);
  });

  it("is the prefix as written until the title of a mounted task, read by its full id, arrives", async () => {
    let answer: (response: GetTaskContextsResponse) => void = () => undefined;
    mocks.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const handle = openStoreForTest({
      epicId: TASK_ID,
      userId: null,
      factories: {
        streamClientFactory: noopStreamClientFactory,
        laneSelection: null,
      },
      writeCommand: null,
    });
    act(() => {
      getOpenEpicRegistry().acquireMounted(TASK_ID, () => handle);
    });
    const prefix = TASK_ID.slice(0, 8);
    const container = renderMarkdown(`Fixed in ${prefix}.`);
    const paragraph = container.querySelector("p");
    expect(paragraph?.textContent).toBe(`Fixed in ${prefix}.`);
    expect(screen.queryByRole("button")).toBeNull();
    await waitFor(() => {
      expect(lookedUpIds()).toEqual([TASK_ID]);
    });

    act(() => {
      answer(
        lookupAnswer({ [TASK_ID]: "Ship the release" }, { taskIds: [TASK_ID] }),
      );
    });

    const chip = await screen.findByRole("button", {
      name: "Ship the release",
    });
    expect(chip.getAttribute("data-task-reference")).toBe(TASK_ID);
    expect(container.querySelector("p")).toBe(paragraph);
    await lookupsCompleted();
    expect(lookedUpIds()).toEqual([TASK_ID]);
  });

  it("scans the query cache once for all the prefixes in a message, and once more per change to what it reads", async () => {
    const scansAfterRender = async (
      tokenCount: number,
    ): Promise<{ readonly scans: () => number }> => {
      queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      holdTasksInList([listTaskLight(UNRELATED_TASK_ID, "Unrelated")]);
      const spy = vi.spyOn(queryClient, "getQueriesData");
      renderMarkdown(`Fixed in ${unheldPrefixes(tokenCount).join(" ")}.`);
      await lookupsCompleted();
      return { scans: () => spy.mock.calls.length };
    };

    const one = await scansAfterRender(1);
    const scansForOne = one.scans();
    cleanup();
    const twenty = await scansAfterRender(20);

    expect(scansForOne).toBeGreaterThan(0);
    expect(twenty.scans()).toBe(scansForOne);
    expect(screen.queryByRole("button")).toBeNull();

    act(() => {
      holdTasksInList([listTaskLight(OTHER_UNRELATED_TASK_ID, "Unrelated")]);
    });

    expect(twenty.scans()).toBe(scansForOne * 2);
    expect(lookedUpIds()).toEqual([]);
  });

  it("resolves a prefix once a title lookup the window holds comes to find its task, after the index was built", async () => {
    answerLookups({ [TASK_ID]: "Ship the release" });
    holdTasksInList([listTaskLight(UNRELATED_TASK_ID, "Unrelated")]);
    const prefix = TASK_ID.slice(0, 8);
    const container = renderMarkdown(`Fixed in ${prefix}.`);
    const paragraph = container.querySelector("p");
    expect(paragraph?.textContent).toBe(`Fixed in ${prefix}.`);
    expect(screen.queryByRole("button")).toBeNull();

    act(() => {
      queryClient.setQueryData(
        OTHER_LOOKUP_KEY,
        lookupAnswer({ [TASK_ID]: "Ship the release" }, { taskIds: [TASK_ID] }),
      );
    });

    expect(
      await screen.findByRole("button", { name: "Ship the release" }),
    ).toBeTruthy();
    expect(container.querySelector("p")).toBe(paragraph);
    await lookupsCompleted();
    expect(lookedUpIds()).toEqual([]);
  });

  it("does not resolve a prefix against another person's cached tasks", async () => {
    answerLookups({ [TASK_ID]: "Ship the release" });
    queryClient.setQueryData<ListTasksResponse>(
      cloudEpicTasksQueryKey(HOST_ID, "someone-else", LIST_CLOUD_TASKS_REQUEST),
      {
        tasks: [listTaskLight(TASK_ID, "Ship the release")],
        hasMore: false,
        facets: { repos: [], workspaces: [], ownershipScopes: [] },
      },
    );
    const prefix = TASK_ID.slice(0, 8);
    const container = renderMarkdown(`Fixed in ${prefix}.`);

    await lookupsCompleted();
    expect(container.textContent).toBe(`Fixed in ${prefix}.`);
    expect(screen.queryByRole("button")).toBeNull();
    expect(lookedUpIds()).toEqual([]);
  });

  it("is drawn as written when the window holds two tasks it begins", async () => {
    answerLookups({ [TASK_ID]: "Ship the release" });
    holdTasksInList([
      listTaskLight(TASK_ID, "Ship the release"),
      listTaskLight(SIBLING_TASK_ID, "Ship the patch"),
    ]);
    const prefix = TASK_ID.slice(0, 8);
    const container = renderMarkdown(`Fixed in ${prefix}.`);

    await lookupsCompleted();
    expect(container.textContent).toBe(`Fixed in ${prefix}.`);
    expect(screen.queryByRole("button")).toBeNull();
    expect(lookedUpIds()).toEqual([]);
  });

  it("is drawn as written when the window holds no task it begins, and no title lookup is ever issued for it", async () => {
    answerLookups({ [TASK_ID]: "Ship the release" });
    const prefix = TASK_ID.slice(0, 8);
    const container = renderMarkdown(`Fixed in ${prefix}.`);

    await lookupsCompleted();
    expect(container.textContent).toBe(`Fixed in ${prefix}.`);
    expect(screen.queryByRole("button")).toBeNull();
    expect(
      mocks.request.mock.calls.filter(
        ([method]) => method === "epic.getTaskContexts",
      ),
    ).toEqual([]);
    expect(
      queryClient
        .getQueryCache()
        .findAll()
        .filter((query) => query.queryKey[2] === "epic.getTaskContexts"),
    ).toEqual([]);
    expect(useTaskLossRegister.getState().byUserId).toEqual({});
  });

  it("is the chip in the same paragraph once the window comes to hold the task", async () => {
    answerLookups({ [TASK_ID]: "Ship the release" });
    const prefix = TASK_ID.slice(0, 8);
    const container = renderMarkdown(`Fixed in ${prefix}.`);
    const paragraph = container.querySelector("p");
    expect(paragraph?.textContent).toBe(`Fixed in ${prefix}.`);
    expect(screen.queryByRole("button")).toBeNull();

    act(() => {
      holdTasksInList([listTaskLight(TASK_ID, "Ship the release")]);
    });

    expect(
      await screen.findByRole("button", { name: "Ship the release" }),
    ).toBeTruthy();
    expect(container.querySelector("p")).toBe(paragraph);
    await lookupsCompleted();
    expect(lookedUpIds()).toEqual([]);
  });

  it("keeps a held task's prefix in a code span as code", async () => {
    answerLookups({ [TASK_ID]: "Ship the release" });
    holdTasksInList([listTaskLight(TASK_ID, "Ship the release")]);
    const prefix = TASK_ID.slice(0, 8);
    renderMarkdown(`Run \`${prefix}\`.`);

    expect(screen.getByText(prefix).tagName).toBe("CODE");
    expect(screen.queryByRole("button")).toBeNull();
    await lookupsCompleted();
    expect(lookedUpIds()).toEqual([]);
  });

  it("goes back to the prefix as written, not the full id, once the task is deleted", async () => {
    answerLookups({ [TASK_ID]: "Ship the release" });
    holdTasksInList([listTaskLight(TASK_ID, "Ship the release")]);
    const prefix = TASK_ID.slice(0, 8);
    const container = renderMarkdown(`Fixed in ${prefix}.`);
    expect(
      screen.getByRole("button", { name: "Ship the release" }),
    ).toBeTruthy();

    act(() => {
      deleteTask();
    });

    await waitFor(() => {
      expect(container.textContent).toBe(`Fixed in ${prefix}.`);
    });
    await lookupsCompleted();
    expect(screen.queryByRole("button")).toBeNull();
    expect(lookedUpIds()).toEqual([]);
  });
});

describe("a task id in a bot's row", () => {
  const PRESENTATION: ChatBotPresentation = {
    botTitle: "Tracy",
    threadLine: null,
    openThread: null,
    openAnnouncementThread: null,
    threadAnchorKinds: [],
    chooseOption: null,
    reply: null,
    questions: null,
    failedRequest: null,
    failedRecovery: null,
    replyReceipt: null,
    requestReceipt: null,
  };

  function botRow(markdown: string): ChatMessageModel {
    return {
      ...makeMessage(1, "assistant"),
      segments: [
        { id: "message-1:text", kind: "text", markdown, isStreaming: false },
      ],
    };
  }

  it("draws `**<id>** Title: detail` as the chip followed by the text, with no bold id", async () => {
    answerLookups({ [TASK_ID]: "Ship the release" });
    render(
      <ChatExpansionTestProviders tileInstanceId="tile-1">
        <ChatBotPresentationContext.Provider value={PRESENTATION}>
          <ChatMessage
            message={botRow(`- **${TASK_ID}** Ship the release: CI is green`)}
            actions={null}
            backgroundToolBlockIds={new Set()}
            nextStepActions={null}
          />
        </ChatBotPresentationContext.Provider>
      </ChatExpansionTestProviders>,
      { wrapper: Providers },
    );

    const row = screen.getByTestId("bot-reply-row");
    const chip = await within(row).findByRole("button", {
      name: "Ship the release",
    });
    const item = row.querySelector("li");
    expect(item?.textContent).toBe(
      "Ship the release Ship the release: CI is green",
    );
    expect(item?.contains(chip)).toBe(true);
    expect(row.textContent).not.toContain(TASK_ID);
  });

  it("draws `**<prefix>** Title: detail` as the chip followed by the text, with no bold prefix", async () => {
    answerLookups({ [TASK_ID]: "Ship the release" });
    holdTasksInList([listTaskLight(TASK_ID, "Ship the release")]);
    const prefix = TASK_ID.slice(0, 8);
    render(
      <ChatExpansionTestProviders tileInstanceId="tile-1">
        <ChatBotPresentationContext.Provider value={PRESENTATION}>
          <ChatMessage
            message={botRow(`- **${prefix}** Ship the release: CI is green`)}
            actions={null}
            backgroundToolBlockIds={new Set()}
            nextStepActions={null}
          />
        </ChatBotPresentationContext.Provider>
      </ChatExpansionTestProviders>,
      { wrapper: Providers },
    );

    const row = screen.getByTestId("bot-reply-row");
    const chip = within(row).getByRole("button", { name: "Ship the release" });
    const item = row.querySelector("li");
    expect(item?.textContent).toBe(
      "Ship the release Ship the release: CI is green",
    );
    expect(item?.contains(chip)).toBe(true);
    expect(row.textContent).not.toContain(prefix);
    await lookupsCompleted();
    expect(lookedUpIds()).toEqual([]);
  });
});
