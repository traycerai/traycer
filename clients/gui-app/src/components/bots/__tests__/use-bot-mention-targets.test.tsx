/**
 * What a bot's channel can name besides its people (decision 177): the bots
 * of the bot's own environment from the standalone bots directory (the real
 * store, over the real `HomeBotsModel` builder), and its tasks - the ones the
 * bot's stream lists, then Home's task list rows the environment owns. The
 * two host reads behind the tasks are scripted at their hooks.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BotRecord,
  BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentDescriptor } from "@traycer/protocol/host/environment/contracts";
import type { ListTaskLight } from "@traycer/protocol/host/epic/unary-schemas";
import { useBotMentionTargets } from "@/components/bots/use-bot-mention-targets";
import { buildHomeBotsModel } from "@/lib/home-bots/bots-model";
import { tracyRecord } from "@/lib/home-bots/__tests__/standalone-bots-fixtures";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useStandaloneBotsStore } from "@/stores/bots/standalone-bots-store";

const TEAM_ENV = "env-team";
const PERSONAL_ENV = "env-me";
const STREAM_TASK = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const UNTITLED_STREAM_TASK = "11111111-2222-4333-8444-555555555555";
const HOME_TASK = "0b9d7c1e-2a3f-4b5c-8d6e-7f8091a2b3c4";
const OTHER_ENV_TASK = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
const UNOWNED_TASK = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const mocks = vi.hoisted(() => ({
  /** `epic.getTaskContexts`' found rows by id. */
  contexts: new Map<string, ListTaskLight>(),
  /** The ids each render asked it for. */
  asked: [] as Array<ReadonlyArray<string>>,
  /** Home's `epic.listTasks` rows. */
  homeTasks: [] as ListTaskLight[],
}));

vi.mock("@/hooks/epic/use-epic-get-task-contexts-query", () => ({
  useEpicGetTaskContexts: (ids: ReadonlyArray<string>) => {
    mocks.asked.push(ids);
    return { tasksById: mocks.contexts, isPending: false, error: null };
  },
}));
vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", () => ({
  useCloudEpicTasksQuery: () => ({ tasks: mocks.homeTasks }),
}));

const ENVIRONMENTS: ReadonlyArray<EnvironmentDescriptor> = [
  {
    environmentId: PERSONAL_ENV,
    label: "Personal",
    ownerKind: "user",
    ownerId: "user-1",
    roomId: "room-me",
  },
  {
    environmentId: TEAM_ENV,
    label: "Acme",
    ownerKind: "organization",
    ownerId: "org-1",
    roomId: "room-team",
  },
];

function bot(botId: string, environmentId: string, title: string): BotRecord {
  return { ...tracyRecord(botId, environmentId), title };
}

function taskLight(
  id: string,
  title: string,
  ownerEnvironmentId: string | undefined,
): ListTaskLight {
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
        createdBy: "user-1",
        version: "1.0.0",
      },
      permission: null,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
    pinned: false,
    ownerEnvironmentId,
  };
}

function streamTask(taskId: string): BotTaskEntry {
  return {
    taskId,
    cadence: { kind: "on-completion" },
    lastCheckinAt: null,
    lastCheckin: null,
    nextAt: null,
    state: "tracking",
    endedReason: null,
    createdByUserId: null,
    spun: null,
    label: null,
    originRequestId: null,
    createdByChatId: null,
    checkins: null,
    inputNeeded: null,
    pause: null,
    stop: null,
    runRequest: null,
  };
}

function settleBots(bots: ReadonlyArray<BotRecord>, settled: boolean): void {
  act(() => {
    useStandaloneBotsStore.setState({
      directory: {
        model: buildHomeBotsModel({
          environments: ENVIRONMENTS,
          bots,
          mainBotIds: {},
        }),
        setups: [],
      },
      settled,
    });
  });
}

beforeEach(() => {
  mocks.contexts = new Map();
  mocks.asked = [];
  mocks.homeTasks = [];
  useAuthStore.setState({
    profile: {
      userId: "user-1",
      userName: "U",
      email: "u@example.com",
      avatarUrl: null,
    },
  });
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ profile: null });
  useStandaloneBotsStore.setState({
    directory: { model: { groups: [], botCount: 0 }, setups: [] },
    settled: false,
  });
});

function targetsOf(environmentId: string, tasks: ReadonlyArray<BotTaskEntry>) {
  return renderHook(() => useBotMentionTargets({ environmentId, tasks }));
}

describe("useBotMentionTargets bots", () => {
  it("lists the bots of the bot's own environment by title, and none of another's", () => {
    settleBots(
      [
        bot("bot_01HZY8V6K3Q9W2E4R5T6Y7V8M0", TEAM_ENV, "Tracy"),
        bot("bot_01HZY8V6K3Q9W2E4R5T6Y7V8M1", TEAM_ENV, "Triage"),
        bot("bot_01HZY8V6K3Q9W2E4R5T6Y7V8M2", PERSONAL_ENV, "Mine"),
      ],
      true,
    );

    expect(targetsOf(TEAM_ENV, []).result.current.bots).toEqual([
      { id: "bot_01HZY8V6K3Q9W2E4R5T6Y7V8M0", name: "Tracy" },
      { id: "bot_01HZY8V6K3Q9W2E4R5T6Y7V8M1", name: "Triage" },
    ]);
  });

  it("has none until the directory answered, and an empty list once it did with nothing for the environment", () => {
    const { result } = targetsOf("env-unlisted", []);
    expect(result.current.bots).toBeNull();

    settleBots([], true);

    expect(result.current.bots).toEqual([]);
  });
});

describe("useBotMentionTargets tasks", () => {
  it("lists the stream's tasks by their contexts' titles, then Home's rows the environment owns, once each", () => {
    mocks.contexts.set(
      STREAM_TASK,
      taskLight(STREAM_TASK, "Release notes", undefined),
    );
    mocks.homeTasks = [
      taskLight(OTHER_ENV_TASK, "Their plan", PERSONAL_ENV),
      taskLight(UNOWNED_TASK, "Nobody's", undefined),
      taskLight(HOME_TASK, "Roadmap", TEAM_ENV),
      // The stream's task is on Home's list too.
      taskLight(STREAM_TASK, "Release notes", TEAM_ENV),
    ];

    const { result } = targetsOf(TEAM_ENV, [streamTask(STREAM_TASK)]);

    expect(result.current.tasks).toEqual([
      { id: STREAM_TASK, name: "Release notes" },
      { id: HOME_TASK, name: "Roadmap" },
    ]);
  });

  it("asks for the titles of the stream's tasks only, and leaves out one whose title is not read", () => {
    mocks.contexts.set(
      STREAM_TASK,
      taskLight(STREAM_TASK, "Release notes", undefined),
    );
    mocks.homeTasks = [taskLight(HOME_TASK, "Roadmap", TEAM_ENV)];

    const { result } = targetsOf(TEAM_ENV, [
      streamTask(STREAM_TASK),
      streamTask(UNTITLED_STREAM_TASK),
    ]);

    expect(mocks.asked.at(-1)).toEqual([STREAM_TASK, UNTITLED_STREAM_TASK]);
    expect(result.current.tasks.map((task) => task.id)).toEqual([
      STREAM_TASK,
      HOME_TASK,
    ]);
  });

  it("names a task with no title as an untitled task", () => {
    mocks.homeTasks = [taskLight(HOME_TASK, "", TEAM_ENV)];

    expect(targetsOf(TEAM_ENV, []).result.current.tasks).toEqual([
      { id: HOME_TASK, name: "Untitled task" },
    ]);
  });
});
