import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ListTasksResponse,
  TaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  LIST_CLOUD_TASKS_REQUEST,
  cloudEpicTasksQueryKey,
  type ListCloudTasksRequest,
} from "@/lib/cloud-epic-tasks-query";
import { useEpicCreateForClient } from "@/hooks/epic/use-epic-create-mutation";
import { useHostClient } from "@/lib/host";
import {
  composerHostLabel,
  createWithoutCloudVerdictMessage,
} from "@/lib/composer/landing-placement";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { toast } from "sonner";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  EPIC_CREATE_SEED_HOLD_TIMEOUT_MS,
  clearEpicCreateSeedPending,
  markEpicCreateSeedPending,
  readEpicCreateSeed,
} from "@/lib/worktree/pending-epic-create-seeds";
import {
  HostMethodVersionUnsatisfiedError,
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
  type IHostMessenger,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { createRetryingMessenger } from "@traycer-clients/shared/host-transport/retrying-messenger";
import { z } from "zod";
import {
  defineRpcContract,
  defineVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { EpicExistenceVerdict } from "@/lib/epics/epic-existence-poll";

const pollMocks = vi.hoisted(() => ({
  pollEpicExistence: vi.fn<(input: unknown) => Promise<EpicExistenceVerdict>>(),
}));

vi.mock("@/lib/epics/epic-existence-poll", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/epics/epic-existence-poll")>();
  return {
    ...actual,
    pollEpicExistence: pollMocks.pollEpicExistence,
  };
});

interface TaskWorkspaceInput {
  readonly hostId: string;
  readonly workspacePath: string;
}

interface MakeTaskInput {
  readonly id: string;
  readonly title: string;
  readonly createdBy: string;
  readonly updatedAt: number;
  readonly repos: readonly string[];
  readonly workspaces: readonly TaskWorkspaceInput[];
}

interface CreateEpicMutationContext {
  readonly hostId: string | null;
  readonly userId: string | null;
}

/**
 * The slice of `epic.create`'s variables this suite's captured callbacks
 * actually read.
 *
 * `epic` is NOT optional here even though nothing below asserts on it: the
 * success path arms the create's binding-seed hold timer from `epic.id`, and a
 * hand-rolled variables shape that omits a field the source reads turns a real
 * call into a `TypeError` at run time while compiling clean. Name every field
 * the callbacks touch.
 */
interface CapturedCreateVariables {
  readonly epic: { readonly id: string };
  readonly chat: { readonly chatId: string } | null;
  readonly workspaces: readonly unknown[];
}

interface CapturedCreateOptions {
  readonly onMutate: (
    variables: CapturedCreateVariables,
  ) => CreateEpicMutationContext;
  readonly onSuccess: (
    response: { readonly task: TaskLight | null | undefined },
    variables: CapturedCreateVariables,
    ctx: CreateEpicMutationContext,
  ) => void;
  readonly onError: (
    error: HostRpcError,
    variables: CapturedCreateVariables,
    ctx: CreateEpicMutationContext | undefined,
  ) => void;
}

const testState = vi.hoisted(() => ({
  activeHostId: "host-1",
  requestContextUserId: "user-1",
  capturedOptions: null as CapturedCreateOptions | null,
  directoryEntries: [] as readonly HostDirectoryEntry[],
  capturedMapDispatchError: null as ((cause: unknown) => unknown) | null,
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => ({
    getActiveHostId: () => testState.activeHostId,
    getRequestContextUserId: () => testState.requestContextUserId,
  }),
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostMutation: (args: {
    readonly options: CapturedCreateOptions;
    readonly mapDispatchError: (cause: unknown) => unknown;
  }) => {
    testState.capturedOptions = args.options;
    testState.capturedMapDispatchError = args.mapDispatchError;
    return { mutate: vi.fn(), isPending: false };
  },
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: testState.directoryEntries }),
}));

vi.mock("sonner", () => {
  const base = vi.fn();
  return {
    toast: Object.assign(base, {
      error: vi.fn(),
      success: vi.fn(),
    }),
  };
});

/**
 * The error the real retrying messenger hands back when a keyed `epic.create`
 * was sent and its answer lost, and the retry was then refused with
 * `refusal` (thread TEUc).
 */
async function episodeEndedByRefusal(
  refusal: HostRpcError,
): Promise<HostRpcError> {
  const createV10 = defineRpcContract({
    method: "epic.create",
    schemaVersion: { major: 1, minor: 0 } as const,
    requestSchema: z.object({ epicId: z.string() }),
    responseSchema: z.object({ ok: z.boolean() }),
  });
  const registry = defineVersionedRpcRegistry({
    "epic.create": {
      1: {
        latestMinor: 0,
        versions: {
          0: { contract: createV10, upgradeFromPreviousVersion: null },
        },
        downgradePathsFromLatest: {},
      },
    },
  });
  const outcomes: HostRpcError[] = [
    new RetryableTransportError({
      replaySafetyFromKey: true,
      code: "RPC_ERROR",
      message: "connection dropped after dispatch",
      requestId: "req-1",
      method: "epic.create",
      fatalDetails: null,
    }),
    refusal,
  ];
  const request = vi
    .fn()
    .mockImplementation(() =>
      Promise.reject(outcomes.shift() ?? new Error("no outcome queued")),
    );
  const inner: IHostMessenger<typeof registry> = {
    request,
    requestWithResponseTimeout: request,
  };
  const episodeError = await createRetryingMessenger(inner, {
    maxRetries: 2,
    initialDelayMs: 0,
    maxDelayMs: 0,
    sleep: () => Promise.resolve(),
    random: () => 0.5,
  })
    .request(
      "epic.create",
      { epicId: "epic-held" },
      {
        idempotencyKey: "create-key",
        authority: {
          endpoint: { hostId: "host-1", websocketUrl: "ws://host-1/rpc" },
          bearer: {
            identity: { userId: "user-1" },
            getBearerToken: () => "token",
          },
          abortSignal: new AbortController().signal,
        },
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
      },
    )
    .then(
      () => null,
      (error: unknown) => error,
    );
  if (!(episodeError instanceof HostRpcError)) {
    throw new Error("expected the episode to end in a HostRpcError");
  }
  return episodeError;
}

function makeWrapper(
  queryClient: QueryClient,
): ({ children }: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function makeTask(input: MakeTaskInput): TaskLight {
  return {
    epic: {
      light: {
        id: input.id,
        title: input.title,
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "draft",
        createdAt: input.updatedAt,
        updatedAt: input.updatedAt,
        createdBy: input.createdBy,
        version: "1",
      },
      permission: null,
      repos: input.repos.map((repo) => {
        const [owner, repoName] = repo.split("/");
        return {
          task: { taskId: input.id, taskType: "epic" as const },
          repoIdentifier: {
            owner,
            repo: repoName,
          },
          createdAt: input.updatedAt,
          createdBy: input.createdBy,
        };
      }),
      workspaces: input.workspaces.map((workspace) => ({
        task: { taskId: input.id, taskType: "epic" as const },
        hostId: workspace.hostId,
        workspacePath: workspace.workspacePath,
        createdAt: input.updatedAt,
      })),
      roomInfo: null,
    },
    phase: null,
  };
}

function taskIds(response: ListTasksResponse | undefined): readonly string[] {
  return response?.tasks.map((task) => task.epic?.light?.id ?? "") ?? [];
}

function repoFacetLabels(
  response: ListTasksResponse | undefined,
): readonly string[] {
  return (
    response?.facets?.repos.map(
      (facet) => `${facet.repoIdentifier.owner}/${facet.repoIdentifier.repo}`,
    ) ?? []
  );
}

describe("useEpicCreateForClient", () => {
  beforeEach(() => {
    testState.activeHostId = "host-1";
    testState.requestContextUserId = "user-1";
    testState.capturedOptions = null;
  });

  it("patches every matching cloud task cache for the active host and user", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const defaultRequest: ListCloudTasksRequest = LIST_CLOUD_TASKS_REQUEST;
    const mineRequest: ListCloudTasksRequest = {
      ...LIST_CLOUD_TASKS_REQUEST,
      filters: { ownershipScopes: ["mine"] },
    };
    const sharedRequest: ListCloudTasksRequest = {
      ...LIST_CLOUD_TASKS_REQUEST,
      filters: { ownershipScopes: ["shared"] },
    };
    const queryRequest: ListCloudTasksRequest = {
      ...LIST_CLOUD_TASKS_REQUEST,
      filters: { query: "unmatched" },
      sort: "relevance",
    };
    const oldTask = makeTask({
      id: "old",
      title: "Old epic",
      createdBy: "user-1",
      updatedAt: 1,
      repos: [],
      workspaces: [],
    });
    const createdTask = makeTask({
      id: "new",
      title: "New epic",
      createdBy: "user-1",
      updatedAt: 2,
      repos: [],
      workspaces: [],
    });

    for (const request of [
      defaultRequest,
      mineRequest,
      sharedRequest,
      queryRequest,
    ]) {
      queryClient.setQueryData<ListTasksResponse>(
        cloudEpicTasksQueryKey("host-1", "user-1", request),
        { tasks: [oldTask], hasMore: false },
      );
    }

    renderHook(() => useEpicCreateForClient(useHostClient()), {
      wrapper: makeWrapper(queryClient),
    });
    const options = testState.capturedOptions;
    if (options === null) throw new Error("expected mutation options");

    const track = vi.spyOn(Analytics.getInstance(), "track");
    track.mockClear();
    const stagedVariables = {
      epic: { id: "epic-1" },
      chat: null,
      workspaces: [],
    };
    options.onSuccess(
      { task: createdTask },
      stagedVariables,
      options.onMutate(stagedVariables),
    );

    // The started/created pair must agree on the mode derived from the SAME
    // variables - a mismatch would corrupt the task-creation funnel.
    expect(track).toHaveBeenCalledWith(AnalyticsEvent.TaskCreationStarted, {
      source: "direct_ui",
      mode: "terminal_agent",
      workspace_count: 0,
    });
    expect(track).toHaveBeenCalledWith(AnalyticsEvent.TaskCreated, {
      mode: "terminal_agent",
    });
    track.mockRestore();

    expect(
      taskIds(
        queryClient.getQueryData(
          cloudEpicTasksQueryKey("host-1", "user-1", defaultRequest),
        ),
      ),
    ).toEqual(["new", "old"]);
    expect(
      taskIds(
        queryClient.getQueryData(
          cloudEpicTasksQueryKey("host-1", "user-1", mineRequest),
        ),
      ),
    ).toEqual(["new", "old"]);
    expect(
      taskIds(
        queryClient.getQueryData(
          cloudEpicTasksQueryKey("host-1", "user-1", sharedRequest),
        ),
      ),
    ).toEqual(["old"]);
    expect(
      taskIds(
        queryClient.getQueryData(
          cloudEpicTasksQueryKey("host-1", "user-1", queryRequest),
        ),
      ),
    ).toEqual(["old"]);
  });

  it("keeps pinned cached tasks ahead of a newly created task", () => {
    const queryClient = new QueryClient();
    const pinnedTask = {
      ...makeTask({
        id: "pinned",
        title: "Pinned epic",
        createdBy: "user-1",
        updatedAt: 1,
        repos: [],
        workspaces: [],
      }),
      pinned: true,
    };
    const createdTask = makeTask({
      id: "new",
      title: "New epic",
      createdBy: "user-1",
      updatedAt: 2,
      repos: [],
      workspaces: [],
    });
    const queryKey = cloudEpicTasksQueryKey(
      "host-1",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    queryClient.setQueryData<ListTasksResponse>(queryKey, {
      tasks: [pinnedTask],
      hasMore: false,
    });
    renderHook(() => useEpicCreateForClient(useHostClient()), {
      wrapper: makeWrapper(queryClient),
    });
    const options = testState.capturedOptions;
    if (options === null) throw new Error("expected mutation options");

    const stagedVariables = {
      epic: { id: "epic-1" },
      chat: null,
      workspaces: [],
    };
    options.onSuccess(
      { task: createdTask },
      stagedVariables,
      options.onMutate(stagedVariables),
    );

    expect(taskIds(queryClient.getQueryData(queryKey))).toEqual([
      "pinned",
      "new",
    ]);
  });

  it("patches cached facets only when the created task matches the cache request", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const defaultRequest: ListCloudTasksRequest = LIST_CLOUD_TASKS_REQUEST;
    const repoFilteredRequest: ListCloudTasksRequest = {
      ...LIST_CLOUD_TASKS_REQUEST,
      filters: {
        repoIdentifiers: [{ owner: "traycer", repo: "gui-app" }],
        repoMatchMode: "any",
      },
    };
    const oldTask = makeTask({
      id: "old",
      title: "Old epic",
      createdBy: "user-1",
      updatedAt: 1,
      repos: ["traycer/gui-app"],
      workspaces: [],
    });
    const createdTask = makeTask({
      id: "new",
      title: "New epic",
      createdBy: "user-1",
      updatedAt: 2,
      repos: ["traycer/host"],
      workspaces: [{ hostId: "host-1", workspacePath: "/Users/me/host" }],
    });
    const initialFacets: NonNullable<ListTasksResponse["facets"]> = {
      repos: [
        {
          repoIdentifier: { owner: "traycer", repo: "gui-app" },
          count: 1,
        },
      ],
      workspaces: [],
      ownershipScopes: [
        { value: "mine", count: 1 },
        { value: "shared", count: 0 },
      ],
    };

    queryClient.setQueryData<ListTasksResponse>(
      cloudEpicTasksQueryKey("host-1", "user-1", defaultRequest),
      { tasks: [oldTask], hasMore: false, facets: initialFacets },
    );
    queryClient.setQueryData<ListTasksResponse>(
      cloudEpicTasksQueryKey("host-1", "user-1", repoFilteredRequest),
      { tasks: [oldTask], hasMore: false, facets: initialFacets },
    );

    renderHook(() => useEpicCreateForClient(useHostClient()), {
      wrapper: makeWrapper(queryClient),
    });
    const options = testState.capturedOptions;
    if (options === null) throw new Error("expected mutation options");

    const stagedVariables = {
      epic: { id: "epic-1" },
      chat: null,
      workspaces: [],
    };
    options.onSuccess(
      { task: createdTask },
      stagedVariables,
      options.onMutate(stagedVariables),
    );

    const defaultResponse = queryClient.getQueryData<ListTasksResponse>(
      cloudEpicTasksQueryKey("host-1", "user-1", defaultRequest),
    );
    expect(taskIds(defaultResponse)).toEqual(["new", "old"]);
    expect(repoFacetLabels(defaultResponse)).toEqual([
      "traycer/gui-app",
      "traycer/host",
    ]);
    expect(defaultResponse?.facets?.workspaces).toEqual([
      {
        workspaceIdentifier: {
          hostId: "host-1",
          workspacePath: "/Users/me/host",
        },
        count: 1,
      },
    ]);
    expect(defaultResponse?.facets?.ownershipScopes).toEqual([
      { value: "mine", count: 2 },
      { value: "shared", count: 0 },
    ]);

    const repoFilteredResponse = queryClient.getQueryData<ListTasksResponse>(
      cloudEpicTasksQueryKey("host-1", "user-1", repoFilteredRequest),
    );
    expect(taskIds(repoFilteredResponse)).toEqual(["old"]);
    expect(repoFacetLabels(repoFilteredResponse)).toEqual(["traycer/gui-app"]);
    expect(repoFilteredResponse?.facets?.workspaces).toEqual([]);
    expect(repoFilteredResponse?.facets?.ownershipScopes).toEqual([
      { value: "mine", count: 1 },
      { value: "shared", count: 0 },
    ]);
  });

  it("preserves an existing generated title when the live epic session is gone", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const cachedGeneratedTask = makeTask({
      id: "new",
      title: "Generated history title",
      createdBy: "user-1",
      updatedAt: 2,
      repos: [],
      workspaces: [],
    });
    const staleCreateResponseTask = makeTask({
      id: "new",
      title: "Initial user prompt",
      createdBy: "user-1",
      updatedAt: 2,
      repos: [],
      workspaces: [],
    });
    const queryKey = cloudEpicTasksQueryKey(
      "host-1",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    queryClient.setQueryData<ListTasksResponse>(queryKey, {
      tasks: [cachedGeneratedTask],
      hasMore: false,
    });

    renderHook(() => useEpicCreateForClient(useHostClient()), {
      wrapper: makeWrapper(queryClient),
    });
    const options = testState.capturedOptions;
    if (options === null) throw new Error("expected mutation options");

    const stagedVariables = {
      epic: { id: "epic-1" },
      chat: null,
      workspaces: [],
    };
    options.onSuccess(
      { task: staleCreateResponseTask },
      stagedVariables,
      options.onMutate(stagedVariables),
    );

    expect(
      queryClient.getQueryData<ListTasksResponse>(queryKey)?.tasks[0]?.epic
        ?.light?.title,
    ).toBe("Generated history title");
  });
});

describe("useEpicCreateForClient seed hold", () => {
  afterEach(() => {
    vi.useRealTimers();
    clearEpicCreateSeedPending("epic-held", "chat-held");
    clearEpicCreateSeedPending("epic-other", "chat-other");
    vi.mocked(toast).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  it("onSuccess arms the pair's timer even when ctx.hostId is null, and the timer still fires a release", () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const released: number[] = [];
    markEpicCreateSeedPending("epic-held", "chat-held", {
      hostId: "host-1",
      seededMessageId: "msg-1",
      seedRows: true,
      heldForDeferredCreate: true,
      release: () => {
        released.push(1);
      },
    });
    renderHook(() => useEpicCreateForClient(useHostClient()), {
      wrapper: makeWrapper(queryClient),
    });
    const options = testState.capturedOptions;
    if (options === null) throw new Error("expected mutation options");

    options.onSuccess(
      { task: null },
      {
        epic: { id: "epic-held" },
        chat: { chatId: "chat-held" },
        workspaces: [],
      },
      { hostId: null, userId: null },
    );
    expect(released).toEqual([]);
    expect(readEpicCreateSeed("epic-held", "chat-held")).not.toBeNull();

    vi.advanceTimersByTime(EPIC_CREATE_SEED_HOLD_TIMEOUT_MS);
    expect(released).toEqual([1]);
    expect(readEpicCreateSeed("epic-held", "chat-held")).toBeNull();
  });

  it("onSuccess invalidation skips a held epic and still invalidates every other epic on the host", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const heldKey = hostQueryKeys.method(
      "host-1",
      "worktree.listBindingsForEpic",
      { epicId: "epic-held" },
    );
    const otherKey = hostQueryKeys.method(
      "host-1",
      "worktree.listBindingsForEpic",
      { epicId: "epic-other" },
    );
    queryClient.setQueryData(heldKey, { rows: [{ runningDir: "/seed" }] });
    queryClient.setQueryData(otherKey, { rows: [] });
    markEpicCreateSeedPending("epic-held", "chat-held", {
      hostId: "host-1",
      seededMessageId: "msg-1",
      seedRows: true,
      heldForDeferredCreate: true,
      release: () => undefined,
    });

    renderHook(() => useEpicCreateForClient(useHostClient()), {
      wrapper: makeWrapper(queryClient),
    });
    const options = testState.capturedOptions;
    if (options === null) throw new Error("expected mutation options");

    options.onSuccess(
      { task: null },
      {
        epic: { id: "epic-held" },
        chat: { chatId: "chat-held" },
        workspaces: [],
      },
      { hostId: "host-1", userId: "user-1" },
    );

    expect(queryClient.getQueryState(heldKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(true);
  });

  describe("onError - the new poll-first contract for a decidable outcome", () => {
    afterEach(() => {
      pollMocks.pollEpicExistence.mockReset();
    });

    function renderOptions(): CapturedCreateOptions {
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });
      renderHook(() => useEpicCreateForClient(useHostClient()), {
        wrapper: makeWrapper(queryClient),
      });
      const options = testState.capturedOptions;
      if (options === null) throw new Error("expected mutation options");
      return options;
    }

    const chatVariables: CapturedCreateVariables = {
      epic: { id: "epic-held" },
      chat: { chatId: "chat-held" },
      workspaces: [],
    };

    const terminalAgentVariables: CapturedCreateVariables = {
      epic: { id: "epic-held" },
      chat: null,
      workspaces: [],
    };

    const ambiguousDrop = new HostTransportFailureError({
      code: "RPC_ERROR",
      message: "WebSocket closed before next frame",
      requestId: "req-drop",
      method: "epic.create",
      fatalDetails: null,
    });

    it("raises NO immediate notice for an ambiguous drop on a chat create, and stays silent when the poll finds the epic", async () => {
      pollMocks.pollEpicExistence.mockResolvedValue("exists");
      const options = renderOptions();

      options.onError(ambiguousDrop, chatVariables, {
        hostId: "host-1",
        userId: "user-1",
      });

      // No toast at the moment of the error - the whole point.
      expect(toast).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
      expect(pollMocks.pollEpicExistence).toHaveBeenCalledWith(
        expect.objectContaining({ hostId: "host-1", epicId: "epic-held" }),
      );

      await vi.waitFor(() => {
        expect(pollMocks.pollEpicExistence).toHaveBeenCalledTimes(1);
      });
      // A found epic settles the ambiguity silently: no notice ever appears.
      expect(toast).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    });

    it("toasts the neutral notice once the poll answers 'absent'", async () => {
      pollMocks.pollEpicExistence.mockResolvedValue("absent");
      const options = renderOptions();

      options.onError(ambiguousDrop, chatVariables, {
        hostId: "host-1",
        userId: "user-1",
      });
      expect(toast).not.toHaveBeenCalled();

      await vi.waitFor(() => {
        expect(toast).toHaveBeenCalled();
      });
      expect(toast.error).not.toHaveBeenCalled();
    });

    it("toasts the neutral notice once the poll answers 'unknown'", async () => {
      pollMocks.pollEpicExistence.mockResolvedValue("unknown");
      const options = renderOptions();

      options.onError(ambiguousDrop, chatVariables, {
        hostId: "host-1",
        userId: "user-1",
      });
      expect(toast).not.toHaveBeenCalled();

      await vi.waitFor(() => {
        expect(toast).toHaveBeenCalled();
      });
      expect(toast.error).not.toHaveBeenCalled();
    });

    it("still toasts the neutral notice when the poll itself rejects", async () => {
      pollMocks.pollEpicExistence.mockRejectedValue(new Error("poll failed"));
      const options = renderOptions();

      options.onError(ambiguousDrop, chatVariables, {
        hostId: "host-1",
        userId: "user-1",
      });

      await vi.waitFor(() => {
        expect(toast).toHaveBeenCalled();
      });
      expect(toast.error).not.toHaveBeenCalled();
    });

    it("a terminal-agent create (chat: null) keeps the immediate notice even for an ambiguous drop - a found epic does not mean the launch succeeded", () => {
      const options = renderOptions();

      options.onError(ambiguousDrop, terminalAgentVariables, {
        hostId: "host-1",
        userId: "user-1",
      });

      expect(toast).toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
      expect(pollMocks.pollEpicExistence).not.toHaveBeenCalled();
    });

    it("a keyReuseConflict on a chat create takes the poll rather than the immediate toast", () => {
      pollMocks.pollEpicExistence.mockResolvedValue("exists");
      const options = renderOptions();
      const keyReuseConflict = new HostRpcError({
        code: "RPC_ERROR",
        message: "The idempotency key was already used with different params",
        requestId: "req-reuse",
        method: "epic.create",
        fatalDetails: null,
      });

      options.onError(keyReuseConflict, chatVariables, {
        hostId: "host-1",
        userId: "user-1",
      });

      expect(toast).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
      expect(pollMocks.pollEpicExistence).toHaveBeenCalledTimes(1);
    });

    it("a plain HostRpcError toasts the red refusal immediately, without polling", () => {
      const options = renderOptions();

      options.onError(
        new HostRpcError({
          code: "RPC_ERROR",
          message: "host refused",
          requestId: "req-refuse",
          method: "epic.create",
          fatalDetails: null,
        }),
        chatVariables,
        { hostId: "host-1", userId: "user-1" },
      );

      expect(toast.error).toHaveBeenCalled();
      expect(pollMocks.pollEpicExistence).not.toHaveBeenCalled();
    });

    // Thread TEUc: the create's first attempt was sent and its answer lost;
    // the retry reconnected to a host below the call's method floor and was
    // refused before dispatch. The first attempt may have created the epic,
    // so the error the retrying messenger hands the hook must poll.
    it("polls when a retry episode's later attempt was refused after its first was sent and dropped", async () => {
      pollMocks.pollEpicExistence.mockResolvedValue("exists");
      const episodeError = await episodeEndedByRefusal(
        new HostMethodVersionUnsatisfiedError({
          requirement: {
            method: "epic.create",
            version: { major: 1, minor: 2 },
          },
          negotiated: { major: 1, minor: 0 },
          requestId: "req-2",
          method: "epic.create",
          hostId: "host-1",
        }),
      );
      const options = renderOptions();

      options.onError(episodeError, chatVariables, {
        hostId: "host-1",
        userId: "user-1",
      });

      expect(toast).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
      expect(pollMocks.pollEpicExistence).toHaveBeenCalledWith(
        expect.objectContaining({ hostId: "host-1", epicId: "epic-held" }),
      );
      await vi.waitFor(() => {
        expect(pollMocks.pollEpicExistence).toHaveBeenCalledTimes(1);
      });
    });

    // An `absent` poll is the last observation at the end of its budget, not
    // proof the earlier send never ran: a create still in flight can publish
    // after it. So the outcome stays unknown - and the refusal that ended the
    // retry episode is said beside it, labelled as the retry's, when it
    // carries guidance of its own.
    function toastText(): string {
      return JSON.stringify([
        vi.mocked(toast).mock.calls,
        vi.mocked(toast.error).mock.calls,
      ]);
    }

    function forbidden(): HostRpcError {
      return new HostRpcError({
        code: "FORBIDDEN",
        message: "not allowed",
        requestId: "req-2",
        method: "epic.create",
        fatalDetails: null,
      });
    }

    it("keeps the outcome unknown and labels the retry's refusal when the poll finds no epic", async () => {
      pollMocks.pollEpicExistence.mockResolvedValue("absent");
      const episodeError = await episodeEndedByRefusal(forbidden());
      const options = renderOptions();

      options.onError(episodeError, chatVariables, {
        hostId: "host-1",
        userId: "user-1",
      });

      await vi.waitFor(() => {
        expect(toastText()).toContain("may or may not have gone through");
      });
      expect(toastText()).toContain("it may still appear");
      expect(toastText()).toContain(
        "The retry was refused: You don't have permission to do that.",
      );
      // Never the definite failure: nobody verified the create did not run.
      expect(toastText()).not.toContain("Couldn't create epic.");
    });

    function createFloorRefusal(): HostMethodVersionUnsatisfiedError {
      return new HostMethodVersionUnsatisfiedError({
        requirement: {
          method: "epic.create",
          version: { major: 1, minor: 1 },
        },
        negotiated: { major: 1, minor: 0 },
        requestId: "req-floor",
        method: "epic.create",
        hostId: "host-1",
      });
    }

    function toastFloorRefusal(ctxHostId: string | null): void {
      const options = renderOptions();
      const mapDispatchError = testState.capturedMapDispatchError;
      if (mapDispatchError === null) {
        throw new Error("expected the dispatch error mapper");
      }
      const refused = mapDispatchError(createFloorRefusal());
      if (!(refused instanceof HostRpcError)) {
        throw new Error("expected the mapper to return a HostRpcError");
      }
      options.onError(refused, chatVariables, {
        hostId: ctxHostId,
        userId: "user-1",
      });
    }

    it("gives a create refused at the epic.create@1.1 floor the composer's sentence for that device as the toast description", () => {
      testState.directoryEntries = [
        {
          hostId: "host-1",
          label: "Work Mac",
          kind: "local",
          websocketUrl: "ws://127.0.0.1:1/rpc",
          version: null,
          transportDialability: "dialable",
        },
      ];
      toastFloorRefusal("host-1");

      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't create epic.",
        expect.objectContaining({
          description: createWithoutCloudVerdictMessage(
            composerHostLabel(testState.directoryEntries, "host-1"),
          ),
        }),
      );
      expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).toContain(
        "Work Mac can't create epics",
      );
      expect(pollMocks.pollEpicExistence).not.toHaveBeenCalled();
    });

    it("names the device the composer's way when the create was dispatched without a host id", () => {
      testState.directoryEntries = [];
      toastFloorRefusal(null);

      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't create epic.",
        expect.objectContaining({
          description: createWithoutCloudVerdictMessage(
            composerHostLabel([], null),
          ),
        }),
      );
    });

    it("says the sign-in remedy beside the uncertainty when the retry was refused at the epic.create@1.1 floor", async () => {
      pollMocks.pollEpicExistence.mockResolvedValue("absent");
      const episodeError = await episodeEndedByRefusal(createFloorRefusal());
      const options = renderOptions();

      options.onError(episodeError, chatVariables, {
        hostId: "host-1",
        userId: "user-1",
      });

      await vi.waitFor(() => {
        expect(toastText()).toContain("may or may not have gone through");
      });
      expect(toastText()).toContain(
        "The retry was refused: Traycer couldn't confirm your sign-in on the device that answered. Sign in again, or update that device, then check your epics before trying again.",
      );
    });

    it("says the uncertainty alone when the retry's refusal is itself an unknown outcome", async () => {
      pollMocks.pollEpicExistence.mockResolvedValue("absent");
      const episodeError = await episodeEndedByRefusal(
        new HostRpcError({
          code: "E_IDEMPOTENCY_OUTCOME_UNKNOWN",
          message: "the original attempt's outcome is not known",
          requestId: "req-2",
          method: "epic.create",
          fatalDetails: null,
        }),
      );
      const options = renderOptions();

      options.onError(episodeError, chatVariables, {
        hostId: "host-1",
        userId: "user-1",
      });

      await vi.waitFor(() => {
        expect(toastText()).toContain("may or may not have gone through");
      });
      expect(toastText()).not.toContain("The retry was refused");
      expect(toastText()).not.toContain("Couldn't create epic.");
    });

    // A poll that cannot tell, or one that rejects, leaves the outcome as
    // unknown as `absent` does - and the retry's refusal is just as true, so
    // its guidance is said beside the uncertainty there too.
    it("keeps the outcome unknown and labels the retry's refusal when the poll cannot tell", async () => {
      pollMocks.pollEpicExistence.mockResolvedValue("unknown");
      const episodeError = await episodeEndedByRefusal(forbidden());
      const options = renderOptions();

      options.onError(episodeError, chatVariables, {
        hostId: "host-1",
        userId: "user-1",
      });

      await vi.waitFor(() => {
        expect(toastText()).toContain("may or may not have gone through");
      });
      expect(toastText()).toContain(
        "The retry was refused: You don't have permission to do that.",
      );
      expect(toastText()).not.toContain("Couldn't create epic.");
    });

    it("keeps the outcome unknown and labels the retry's refusal when the poll rejects", async () => {
      pollMocks.pollEpicExistence.mockRejectedValue(new Error("poll failed"));
      const episodeError = await episodeEndedByRefusal(forbidden());
      const options = renderOptions();

      options.onError(episodeError, chatVariables, {
        hostId: "host-1",
        userId: "user-1",
      });

      await vi.waitFor(() => {
        expect(toastText()).toContain("may or may not have gone through");
      });
      expect(toastText()).toContain(
        "The retry was refused: You don't have permission to do that.",
      );
      expect(toastText()).not.toContain("Couldn't create epic.");
    });

    // The error the retrying messenger hands back when attempt 1 was sent
    // and dropped and every retry then timed out with the host attesting no
    // dispatch: attested, but carrying the episode's earlier send. The create
    // may have committed, so the production hook must poll, not toast.
    it("polls, rather than toasting, after a keyed sent-and-dropped attempt whose retries the host attested were never dispatched", async () => {
      pollMocks.pollEpicExistence.mockResolvedValue("exists");
      const options = renderOptions();

      options.onError(
        new RetryableTransportError({
          replaySafetyFromKey: true,
          code: "RPC_ERROR",
          message: "Host timed out awaiting the request frame",
          requestId: "req-exhausted",
          method: "epic.create",
          fatalDetails: {
            code: "RPC_REQUEST_TIMEOUT",
            reason: "Host timed out awaiting the request frame",
            incompatibleMethods: null,
            upgradeGuidance: null,
            retryable: true,
          },
        }),
        chatVariables,
        { hostId: "host-1", userId: "user-1" },
      );

      expect(toast).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
      expect(pollMocks.pollEpicExistence).toHaveBeenCalledWith(
        expect.objectContaining({ hostId: "host-1", epicId: "epic-held" }),
      );
      await vi.waitFor(() => {
        expect(pollMocks.pollEpicExistence).toHaveBeenCalledTimes(1);
      });
      expect(toast).not.toHaveBeenCalled();
    });

    it("a RetryableTransportError keeps the pre-send notice immediately, without polling", () => {
      const options = renderOptions();

      options.onError(
        new RetryableTransportError({
          replaySafetyFromKey: false,
          code: "RPC_ERROR",
          message: "Dial failed before the request was sent",
          requestId: "req-retryable",
          method: "epic.create",
          fatalDetails: null,
        }),
        chatVariables,
        { hostId: "host-1", userId: "user-1" },
      );

      expect(toast.error).not.toHaveBeenCalled();
      expect(toast).toHaveBeenCalled();
      expect(pollMocks.pollEpicExistence).not.toHaveBeenCalled();
    });
  });
});
