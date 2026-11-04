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
  /** The tab host's client: what `useTabHostClient()` answers. */
  tabClient: { stub: "tab-host-client" },
  /** `epic.getTaskContexts`' found rows by id on the TAB's host. */
  contexts: new Map<string, ListTaskLight>(),
  /** What the TAB host's two task reads report: both answered, unless a case says otherwise. */
  tabRead: {
    contextsPending: false,
    contextsError: null as Error | null,
    homeCached: false,
    homePending: false,
    homeError: null as Error | null,
  },
  /** The ids each render asked it for. */
  asked: [] as Array<ReadonlyArray<string>>,
  /** Home's `epic.listTasks` rows on the TAB's host. */
  homeTasks: [] as ListTaskLight[],
  /** The same reads on the host the app has active, which `useHostClient()` stands for. */
  activeContexts: new Map<string, ListTaskLight>(),
  activeHomeTasks: [] as ListTaskLight[],
  /** The same reads on any host that is neither the tab's nor the active one. */
  otherContexts: new Map<string, ListTaskLight>(),
  otherHomeTasks: [] as ListTaskLight[],
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.tabClient,
}));
vi.mock("@/hooks/epic/use-epic-get-task-contexts-query", () => ({
  // The app's active host.
  useEpicGetTaskContexts: () => ({
    tasksById: mocks.activeContexts,
    isPending: false,
    error: null,
  }),
  useEpicGetTaskContextsForClient: (
    client: object | null,
    ids: ReadonlyArray<string>,
  ) => {
    mocks.asked.push(ids);
    const tab = client === mocks.tabClient;
    return {
      tasksById: tab ? mocks.contexts : mocks.otherContexts,
      isPending: tab ? mocks.tabRead.contextsPending : false,
      error: tab ? mocks.tabRead.contextsError : null,
    };
  },
}));
vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", () => ({
  useCloudEpicTasksQuery: () => ({ tasks: mocks.activeHomeTasks }),
  useCloudEpicTasksQueryForClient: (client: object | null) => {
    const tab = client === mocks.tabClient;
    return {
      tasks: tab ? mocks.homeTasks : mocks.otherHomeTasks,
      presentsCachedPage: tab ? mocks.tabRead.homeCached : false,
      firstPagePending: tab ? mocks.tabRead.homePending : false,
      firstPageError: tab ? mocks.tabRead.homeError : null,
    };
  },
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

function seedBots(
  bots: ReadonlyArray<BotRecord>,
  flags: { readonly settled: boolean; readonly botsListed: boolean },
): void {
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
      settled: flags.settled,
      botsListed: flags.botsListed,
    });
  });
}

beforeEach(() => {
  mocks.contexts = new Map();
  mocks.asked = [];
  mocks.homeTasks = [];
  mocks.tabRead.contextsPending = false;
  mocks.tabRead.contextsError = null;
  mocks.tabRead.homeCached = false;
  mocks.tabRead.homePending = false;
  mocks.tabRead.homeError = null;
  mocks.activeContexts = new Map();
  mocks.activeHomeTasks = [];
  mocks.otherContexts = new Map();
  mocks.otherHomeTasks = [];
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
    botsListed: false,
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
  const ROSTER = [
    bot("bot_01HZY8V6K3Q9W2E4R5T6Y7V8M0", TEAM_ENV, "Tracy"),
    bot("bot_01HZY8V6K3Q9W2E4R5T6Y7V8M1", TEAM_ENV, "Triage"),
    bot("bot_01HZY8V6K3Q9W2E4R5T6Y7V8M2", PERSONAL_ENV, "Mine"),
  ];

  it("lists the bots of the bot's own environment by title, and none of another's, once the bot list answered", () => {
    seedBots(ROSTER, { settled: true, botsListed: true });

    expect(targetsOf(TEAM_ENV, [], false).result.current.bots).toEqual([
      { id: "bot_01HZY8V6K3Q9W2E4R5T6Y7V8M0", name: "Tracy" },
      { id: "bot_01HZY8V6K3Q9W2E4R5T6Y7V8M1", name: "Triage" },
    ]);
  });

  it("has none on a cold load, where the environment's group exists with no bots read yet", () => {
    seedBots([], { settled: false, botsListed: false });

    expect(targetsOf(TEAM_ENV, [], false).result.current.bots).toBeNull();
  });

  it("has none after a read that failed or ran out of time, though the directory is settled", () => {
    seedBots([], { settled: true, botsListed: false });

    expect(targetsOf(TEAM_ENV, [], false).result.current.bots).toBeNull();
  });

  it("has none for an environment the answered bot list has no group for", () => {
    seedBots(ROSTER, { settled: true, botsListed: true });

    expect(targetsOf("env-unlisted", [], false).result.current.bots).toBeNull();
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

  it("reads its tasks from the tab's host, not from the host the app has active or any other", () => {
    mocks.contexts.set(
      STREAM_TASK,
      taskLight(STREAM_TASK, "Tab host stream task", undefined),
    );
    mocks.homeTasks = [taskLight(HOME_TASK, "Tab host Home task", TEAM_ENV)];
    mocks.activeContexts.set(
      STREAM_TASK,
      taskLight(STREAM_TASK, "Active host stream task", undefined),
    );
    mocks.activeHomeTasks = [
      taskLight(OTHER_ENV_TASK, "Active host Home task", TEAM_ENV),
    ];
    mocks.otherContexts.set(
      STREAM_TASK,
      taskLight(STREAM_TASK, "Other host stream task", undefined),
    );
    mocks.otherHomeTasks = [
      taskLight(UNOWNED_TASK, "Other host Home task", TEAM_ENV),
    ];

    const { result } = targetsOf(TEAM_ENV, [streamTask(STREAM_TASK)], false);

    expect(result.current.tasks).toEqual([
      { id: STREAM_TASK, name: "Tab host stream task" },
      { id: HOME_TASK, name: "Tab host Home task" },
    ]);
  });

  it("names a task with no title as an untitled task", () => {
    mocks.homeTasks = [taskLight(HOME_TASK, "", TEAM_ENV)];

    expect(targetsOf(TEAM_ENV, [], false).result.current.tasks).toEqual([
      { id: HOME_TASK, name: "Untitled task" },
    ]);
  });
});

describe("useBotMentionTargets tasksAnswered", () => {
  it("is true once both task reads have answered without an error", () => {
    expect(targetsOf(TEAM_ENV, [], false).result.current.tasksAnswered).toBe(
      true,
    );
  });

  it.each([
    {
      source: "the stream's task contexts are pending",
      set: () => {
        mocks.tabRead.contextsPending = true;
      },
    },
    {
      source: "the stream's task contexts failed",
      set: () => {
        mocks.tabRead.contextsError = new Error("host unreachable");
      },
    },
    {
      source: "Home presents a cached page",
      set: () => {
        mocks.tabRead.homeCached = true;
      },
    },
    {
      source: "Home's first page is pending",
      set: () => {
        mocks.tabRead.homePending = true;
      },
    },
    {
      source: "Home's first page failed",
      set: () => {
        mocks.tabRead.homeError = new Error("cloud down");
      },
    },
  ])("is false while $source", ({ set }) => {
    set();

    expect(targetsOf(TEAM_ENV, [], false).result.current.tasksAnswered).toBe(
      false,
    );
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
