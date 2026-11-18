/**
 * A bot channel's message text through the REAL markdown path
 * (`AgentReferenceMarkdown` over `TraycerMarkdown`): a `<@userId>` token is
 * the member's chip where `BotMentionsContext` names them, `<#botId>` the
 * bot's chip that opens its channel, and `<~epicId>` the task's chip that
 * opens the task, titled only from the directory's task list. A bot token
 * nothing names stays as written, or says the bot is removed once the bots
 * directory lacks it; a task outside the directory is never read by id and
 * never called removed (the listing is not complete), so another
 * environment's is never named and the id stays on the unlisted chip.
 */
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GetTaskContextsResponse,
  ListTaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  BotMentionsContext,
  type BotMentionDirectory,
  type BotMentioned,
} from "@/components/bots/bot-mentions-context";
import { TracyTranscriptOriginScope } from "@/components/bots/tracy-transcript-origin-scope";
import { AgentReferenceMarkdown } from "@/components/chat/segments/agent-reference-markdown";
import {
  fromTracyTranscript,
  openEpicFromListIntent,
} from "@/lib/tab-navigation/intents";
import { useAuthStore } from "@/stores/auth/auth-store";

const VIEWER = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const ANN = "user-ann";
const STRANGER = "user-stranger";
const TRIAGE_BOT = "bot_01HZY8V6K3Q9W2E4R5T6Y7V8M1";
const REMOVED_BOT = "bot_01HZY8V6K3Q9W2E4R5T6Y7V8M2";
const RELEASE_TASK = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const FOREIGN_TASK = "0b9d7c1e-2a3f-4b5c-8d6e-7f8091a2b3c4";
const USER_ID = "user-test";

const MEMBERS: Record<string, BotMentioned> = {
  [VIEWER]: { name: "Olive", self: true },
  [ANN]: { name: "Ann", self: false },
};

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
    navigate: vi.fn<() => void>(),
    openBotChannel:
      vi.fn<(navigate: unknown, botId: string, options: unknown) => boolean>(),
    navigateToTabIntent:
      vi.fn<(navigate: unknown, intent: unknown, options: unknown) => void>(),
  };
});

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => mocks.client,
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
vi.mock("@/hooks/host/use-connectable-host-ids", () => ({
  useConnectableHostIds: () => ({ resolved: false, hostIds: [] }),
}));
vi.mock("@/lib/bots/open-bot-channel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bots/open-bot-channel")>()),
  openBotChannel: mocks.openBotChannel,
}));
vi.mock("@/lib/tab-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
  navigateToTabIntent: mocks.navigateToTabIntent,
}));

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
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

function taskLight(id: string, title: string): ListTaskLight {
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
    const { taskIds } = params as { readonly taskIds: readonly string[] };
    const tasks: GetTaskContextsResponse["tasks"] = {};
    for (const id of taskIds) {
      tasks[id] = Object.hasOwn(titles, id)
        ? { status: "found", task: taskLight(id, titles[id]) }
        : { status: "confirmed-absent" };
    }
    const response: GetTaskContextsResponse = { tasks };
    return Promise.resolve(response);
  });
}

function askedTaskIds(): ReadonlyArray<string> {
  return mocks.request.mock.calls.flatMap(([method, params]) =>
    method === "epic.getTaskContexts"
      ? (params as { readonly taskIds: readonly string[] }).taskIds
      : [],
  );
}

const DIRECTORY: BotMentionDirectory = {
  person: (userId) => (Object.hasOwn(MEMBERS, userId) ? MEMBERS[userId] : null),
  bots: [{ id: TRIAGE_BOT, name: "Triage" }],
  tasks: [{ id: RELEASE_TASK, name: "Release notes" }],
  tasksAnswered: true,
};

function body(markdown: string) {
  return (
    <AgentReferenceMarkdown
      isStreaming={false}
      markdown={markdown}
      proseSize="compact"
      quotable={false}
      components={null}
    />
  );
}

function Providers(props: { readonly children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

function renderIn(
  markdown: string,
  directory: BotMentionDirectory,
): HTMLElement {
  const { container } = render(
    <BotMentionsContext value={directory}>{body(markdown)}</BotMentionsContext>,
    { wrapper: Providers },
  );
  return container;
}

describe("a bot message's mentions", () => {
  it("draws a member's token as their chip, marked for the viewer", () => {
    renderIn(`<@${ANN}> and <@${VIEWER}> please look`, DIRECTORY);

    const chips = screen.getAllByTestId("bot-mention");
    expect(chips.map((chip) => chip.textContent)).toEqual(["@Ann", "@Olive"]);
    expect(chips.map((chip) => chip.getAttribute("data-self"))).toEqual([
      "false",
      "true",
    ]);
  });

  it("leaves the token as written for someone who is not a member", () => {
    const container = renderIn(`hello <@${STRANGER}>`, DIRECTORY);

    expect(screen.queryByTestId("bot-mention")).toBeNull();
    expect(container.textContent).toContain(`<@${STRANGER}>`);
  });

  it("leaves every kind of token as written outside any provider", () => {
    const { container } = render(
      body(`hello <@${ANN}> <#${TRIAGE_BOT}> <~${RELEASE_TASK}>`),
      { wrapper: Providers },
    );

    expect(screen.queryByTestId("bot-mention")).toBeNull();
    expect(screen.queryByTestId("bot-mention-bot")).toBeNull();
    expect(screen.queryByTestId("bot-mention-task")).toBeNull();
    expect(container.textContent).toContain(
      `<@${ANN}> <#${TRIAGE_BOT}> <~${RELEASE_TASK}>`,
    );
  });

  it("draws a person, a bot and a task in one row as three chips", () => {
    renderIn(
      `<@${ANN}> asked <#${TRIAGE_BOT}> about <~${RELEASE_TASK}>`,
      DIRECTORY,
    );

    expect(screen.getByTestId("bot-mention").textContent).toBe("@Ann");
    expect(screen.getByTestId("bot-mention-bot").textContent).toBe("@Triage");
    expect(screen.getByTestId("bot-mention-task").textContent).toBe(
      "@Release notes",
    );
  });
});

describe("a bot's chip", () => {
  it("opens that bot's channel", () => {
    renderIn(`ask <#${TRIAGE_BOT}>`, DIRECTORY);

    fireEvent.click(screen.getByTestId("bot-mention-bot"));

    expect(mocks.openBotChannel).toHaveBeenCalledTimes(1);
    expect(mocks.openBotChannel).toHaveBeenCalledWith(
      mocks.navigate,
      TRIAGE_BOT,
      { landing: null, isConnectable: null, onRejected: null },
    );
  });

  it("says a removed bot for one the environment's bots do not list", () => {
    renderIn(`ask <#${REMOVED_BOT}>`, DIRECTORY);

    expect(screen.getByTestId("bot-mention-bot-removed").textContent).toBe(
      "a removed bot",
    );
    expect(screen.queryByTestId("bot-mention-bot")).toBeNull();
  });

  it("leaves the token as written while the environment's bots are unread", () => {
    const container = renderIn(`ask <#${TRIAGE_BOT}>`, {
      ...DIRECTORY,
      bots: null,
    });

    expect(screen.queryByTestId("bot-mention-bot")).toBeNull();
    expect(screen.queryByTestId("bot-mention-bot-removed")).toBeNull();
    expect(container.textContent).toContain(`<#${TRIAGE_BOT}>`);
  });
});

describe("a task's chip", () => {
  it("is titled from the directory without a read, and opens the task", () => {
    renderIn(`see <~${RELEASE_TASK}>`, DIRECTORY);

    const chip = screen.getByTestId("bot-mention-task");
    expect(chip.textContent).toBe("@Release notes");
    fireEvent.click(chip);

    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
    expect(mocks.navigateToTabIntent).toHaveBeenCalledWith(
      mocks.navigate,
      openEpicFromListIntent({
        epicId: RELEASE_TASK,
        focus: undefined,
        name: "Release notes",
        replaceEmptyDraftId: null,
      }),
      undefined,
    );
    expect(askedTaskIds()).toEqual([]);
  });

  it("hands the controller the transcript's bot when drawn inside a Tracy transcript", () => {
    render(
      <BotMentionsContext value={DIRECTORY}>
        <TracyTranscriptOriginScope botId={TRIAGE_BOT}>
          {body(`see <~${RELEASE_TASK}>`)}
        </TracyTranscriptOriginScope>
      </BotMentionsContext>,
      { wrapper: Providers },
    );

    fireEvent.click(screen.getByTestId("bot-mention-task"));

    expect(mocks.navigateToTabIntent).toHaveBeenCalledWith(
      mocks.navigate,
      fromTracyTranscript(
        openEpicFromListIntent({
          epicId: RELEASE_TASK,
          focus: undefined,
          name: "Release notes",
          replaceEmptyDraftId: null,
        }),
        { botId: TRIAGE_BOT },
      ),
      undefined,
    );
  });

  it("says only 'a task' for one the directory does not list, even one the host would title, keeping its id: a task that fell off Home's first page stays unresolved, never removed", () => {
    answerLookups({ [FOREIGN_TASK]: "Another team's roadmap" });
    const container = renderIn(`see <~${FOREIGN_TASK}>`, DIRECTORY);

    const unlisted = screen.getByTestId("bot-mention-task-unlisted");
    expect(unlisted.textContent).toBe("a task");
    expect(unlisted.getAttribute("data-task-id")).toBe(FOREIGN_TASK);
    expect(unlisted.tagName).toBe("SPAN");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByTestId("bot-mention-task")).toBeNull();
    expect(container.textContent).not.toContain("removed");
    expect(container.textContent).not.toContain("Another team's roadmap");
    expect(askedTaskIds()).toEqual([]);
  });
});
