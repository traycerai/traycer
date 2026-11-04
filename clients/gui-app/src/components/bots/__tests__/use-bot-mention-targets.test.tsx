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
import type {
  ListTaskLight,
  ListTasksCompleteness,
  PermissionDto,
} from "@traycer/protocol/host/epic/unary-schemas";
import { useBotMentionTargets } from "@/components/bots/use-bot-mention-targets";
import { buildHomeBotsModel } from "@/lib/home-bots/bots-model";
import { tracyRecord } from "@/lib/home-bots/__tests__/standalone-bots-fixtures";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useStandaloneBotsStore } from "@/stores/bots/standalone-bots-store";

const VIEWER = "user-1";
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
  /** Whether Home's first page is still pending, and the error it failed with. */
  homePending: false,
  homeError: null as Error | null,
  /** Whether Home presents a cached page, and whether its cloud half is pending. */
  homeCached: false,
  homeCloudPending: false,
  homeCompleteness: null as ListTasksCompleteness | null,
  /** The stream task contexts read's pending flag and error. */
  contextsPending: false,
  contextsError: null as Error | null,
}));

vi.mock("@/hooks/epic/use-epic-get-task-contexts-query", () => ({
  useEpicGetTaskContexts: (ids: ReadonlyArray<string>) => {
    mocks.asked.push(ids);
    return {
      tasksById: mocks.contexts,
      isPending: mocks.contextsPending,
      error: mocks.contextsError,
    };
  },
}));
vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", () => ({
  useCloudEpicTasksQuery: () => ({
    tasks: mocks.homeTasks,
    firstPagePending: mocks.homePending,
    firstPageError: mocks.homeError,
    presentsCachedPage: mocks.homeCached,
    isCloudPagePending: mocks.homeCloudPending,
    completeness: mocks.homeCompleteness,
  }),
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

/** A Home row with no owner environment, carrying the viewer's `permission` on it. */
function rowWithPermission(
  id: string,
  title: string,
  permission: PermissionDto,
): ListTaskLight {
  const base = taskLight(id, title, undefined);
  const epic = base.epic;
  if (epic === null || epic === undefined) {
    throw new Error("the fixture row is an epic");
  }
  return { ...base, epic: { ...epic, permission } };
}

function permissionOf(overrides: Partial<PermissionDto>): PermissionDto {
  return {
    role: "owner",
    accessType: "direct",
    userId: VIEWER,
    grantedBy: VIEWER,
    grantedAt: 0,
    ...overrides,
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
  mocks.homePending = false;
  mocks.homeError = null;
  mocks.homeCached = false;
  mocks.homeCloudPending = false;
  mocks.homeCompleteness = null;
  mocks.contextsPending = false;
  mocks.contextsError = null;
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

function targetsOf(
  environmentId: string,
  tasks: ReadonlyArray<BotTaskEntry>,
  personal: boolean | null,
) {
  return renderHook(() =>
    useBotMentionTargets({ environmentId, tasks, personal }),
  );
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

    expect(targetsOf(TEAM_ENV, [], false).result.current.bots).toEqual([
      { id: "bot_01HZY8V6K3Q9W2E4R5T6Y7V8M0", name: "Tracy" },
      { id: "bot_01HZY8V6K3Q9W2E4R5T6Y7V8M1", name: "Triage" },
    ]);
  });

  it("has none until the directory answered, and an empty list once it did with nothing for the environment", () => {
    const { result } = targetsOf("env-unlisted", [], false);
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

    const { result } = targetsOf(TEAM_ENV, [streamTask(STREAM_TASK)], false);

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

    const { result } = targetsOf(
      TEAM_ENV,
      [streamTask(STREAM_TASK), streamTask(UNTITLED_STREAM_TASK)],
      false,
    );

    expect(mocks.asked.at(-1)).toEqual([STREAM_TASK, UNTITLED_STREAM_TASK]);
    expect(result.current.tasks.map((task) => task.id)).toEqual([
      STREAM_TASK,
      HOME_TASK,
    ]);
  });

  it("names a task with no title as an untitled task", () => {
    mocks.homeTasks = [taskLight(HOME_TASK, "", TEAM_ENV)];

    expect(targetsOf(TEAM_ENV, [], false).result.current.tasks).toEqual([
      { id: HOME_TASK, name: "Untitled task" },
    ]);
  });

  it("is unsettled while Home's first page is pending, and settled once it answered with no cached page, pending cloud half or completeness reported", () => {
    mocks.homePending = true;
    const { result, rerender } = targetsOf(TEAM_ENV, [], false);

    expect(result.current.tasksSettled).toBe(false);

    mocks.homePending = false;
    rerender();

    expect(result.current.tasksSettled).toBe(true);
  });

  it("is unsettled while the stream's task contexts are pending, and when either read failed", () => {
    mocks.contextsPending = true;
    const { result, rerender } = targetsOf(
      TEAM_ENV,
      [streamTask(STREAM_TASK)],
      false,
    );
    expect(result.current.tasksSettled).toBe(false);

    mocks.contextsPending = false;
    mocks.contextsError = new Error("host unreachable");
    rerender();
    expect(result.current.tasksSettled).toBe(false);

    mocks.contextsError = null;
    mocks.homeError = new Error("cloud down");
    rerender();
    expect(result.current.tasksSettled).toBe(false);
  });

  it("is unsettled while Home presents a cached page, whose cloud half has not answered", () => {
    mocks.homeCached = true;

    expect(targetsOf(TEAM_ENV, [], false).result.current.tasksSettled).toBe(
      false,
    );
  });

  it("is unsettled while a local-first snapshot waits on the cloud's half", () => {
    mocks.homeCloudPending = true;

    expect(targetsOf(TEAM_ENV, [], false).result.current.tasksSettled).toBe(
      false,
    );
  });

  it("is unsettled when the cloud's page is unavailable, and settled when it settled", () => {
    mocks.homeCompleteness = {
      cloudPage: "unavailable",
      facets: "server",
      localRows: "none",
      sort: "server",
    };
    const { result, rerender } = targetsOf(TEAM_ENV, [], false);
    expect(result.current.tasksSettled).toBe(false);

    mocks.homeCompleteness = {
      cloudPage: "settled",
      facets: "server",
      localRows: "none",
      sort: "server",
    };
    rerender();
    expect(result.current.tasksSettled).toBe(true);
  });

  it("is unsettled until the environment list has said whose environment this is", () => {
    const UNREAD_ENVIRONMENT: { readonly personal: boolean | null } = {
      personal: null,
    };
    const { result, rerender } = renderHook(
      (props: { readonly personal: boolean | null }) =>
        useBotMentionTargets({
          environmentId: TEAM_ENV,
          tasks: [],
          personal: props.personal,
        }),
      { initialProps: UNREAD_ENVIRONMENT },
    );
    expect(result.current.tasksSettled).toBe(false);

    rerender({ personal: false });
    expect(result.current.tasksSettled).toBe(true);
  });
});

describe("useBotMentionTargets tasks of a personal environment", () => {
  it("lists a Home row the viewer owns directly, which names no owner environment", () => {
    mocks.homeTasks = [
      rowWithPermission(HOME_TASK, "Roadmap", permissionOf({})),
    ];

    expect(targetsOf(PERSONAL_ENV, [], true).result.current.tasks).toEqual([
      { id: HOME_TASK, name: "Roadmap" },
    ]);
  });

  it("lists no such row for a team bot", () => {
    mocks.homeTasks = [
      rowWithPermission(HOME_TASK, "Roadmap", permissionOf({})),
    ];

    expect(targetsOf(TEAM_ENV, [], false).result.current.tasks).toEqual([]);
  });

  it("lists no row the viewer does not own directly: another person's, an organization's, or an editor's", () => {
    mocks.homeTasks = [
      rowWithPermission(
        OTHER_ENV_TASK,
        "Theirs",
        permissionOf({ userId: "user-2" }),
      ),
      rowWithPermission(
        UNOWNED_TASK,
        "Org's",
        permissionOf({ accessType: "organization" }),
      ),
      rowWithPermission(
        UNTITLED_STREAM_TASK,
        "Shared with me",
        permissionOf({ role: "editor" }),
      ),
    ];

    expect(targetsOf(PERSONAL_ENV, [], true).result.current.tasks).toEqual([]);
  });
});
