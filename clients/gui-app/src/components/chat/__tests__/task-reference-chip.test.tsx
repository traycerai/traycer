/**
 * A complete task id in a message is a chip with the task's title that opens
 * the task (Tracy Bots, decision 100): drawn through the real markdown path
 * (`TextSegment` -> `AgentReferenceMarkdown` -> the reference plugin), with the
 * title read from the real query cache and `epic.getTaskContexts` answered by a
 * stub host. An agent of the open epic still wins the id; anything that names
 * nothing stays as written.
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
} from "@traycer/protocol/host/epic/unary-schemas";
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
import {
  EpicSessionContext,
  handleHostIds,
} from "@/lib/registries/epic-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";

const HOST_ID = "host-test";
const USER_ID = "user-test";
const TASK_ID = "6f1c2a9e-4b7d-4e21-9c3a-1d2e3f4a5b6c";
const AGENT_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

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
    records: [] as ReadonlyArray<{
      readonly id: string;
      readonly type: string;
      readonly name: string;
    }>,
  };
});

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => mocks.client,
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

vi.mock("@/lib/tab-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
  activateTabIntent: mocks.activateTabIntent,
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

  it("leaves an 8-character prefix that names no agent as text, and looks nothing up", () => {
    answerLookups({ [TASK_ID]: "Ship the release" });
    const prefix = TASK_ID.slice(0, 8);
    const container = renderMarkdown(`Fixed in ${prefix}.`);

    expect(container.textContent).toBe(`Fixed in ${prefix}.`);
    expect(screen.queryByRole("button")).toBeNull();
    expect(lookedUpIds()).toEqual([]);
  });

  it("leaves a complete id that names nothing the person can open as text", async () => {
    answerLookups({});
    const container = renderMarkdown(`Gone: ${TASK_ID}.`);

    await waitFor(() => {
      expect(
        queryClient.getQueryState(
          queryKeys.hostEpicTaskContexts(HOST_ID, USER_ID, [TASK_ID]),
        )?.status,
      ).toBe("success");
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

  it("is the chip on first render when a task list the window holds names it", () => {
    mocks.request.mockImplementation(() => new Promise(() => undefined));
    // Another surface's lookup (the tab strip's, over every open tab) already
    // answered for this task.
    queryClient.setQueryData(
      queryKeys.hostEpicTaskContexts(HOST_ID, USER_ID, [TASK_ID, AGENT_ID]),
      lookupAnswer({ [TASK_ID]: "Ship the release" }, { taskIds: [TASK_ID] }),
    );
    renderMarkdown(`In flight: ${TASK_ID}.`);

    expect(
      screen.getByRole("button", { name: "Ship the release" }),
    ).toBeTruthy();
  });
});

describe("a task id in a bot's row", () => {
  const PRESENTATION: ChatBotPresentation = {
    botTitle: "Tracy",
    scrollToMessage: null,
    replyFollowsPost: null,
    threadLine: null,
    openThread: null,
    openAnnouncementThread: null,
    chooseOption: null,
    failedRequest: null,
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
});
