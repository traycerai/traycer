import { describe, expect, it } from "vitest";
import {
  epicCreateV12,
  epicListTasksV17,
  epicListTasksV18,
  epicUpdateTitleV10,
} from "@traycer/protocol/host/epic/contracts";
import {
  earlyMetaEpicSchema,
  snapshotMetaEpicSchema,
  snapshotMetaEpicSchemaV10,
} from "@traycer/protocol/host/epic/snapshot-meta";
import {
  organizationHistoryV10,
  organizationHistoryV11,
} from "@traycer/protocol/host/organization/contracts";

/**
 * Only the task picker reads the html, canvas and file counts, through
 * `epic.listTasks@1.8`. Every other method that carries the epic light keeps
 * the pre-html shape, and a plain z.object strips the three keys it does not
 * name. The strip is the contract: a released peer never sees a key it did
 * not agree to, and a count written by a newer producer cannot leak onto a
 * frozen line.
 */

const COUNTS = { htmlCount: 2, canvasCount: 3, fileCount: 4 };
const COUNT_KEYS = ["htmlCount", "canvasCount", "fileCount"] as const;

const EPIC_LIGHT = {
  id: "epic-1",
  title: "Epic",
  initialUserPrompt: "Do the thing",
  ticketCount: 1,
  specCount: 2,
  storyCount: 3,
  reviewCount: 4,
  status: "in_progress",
  createdAt: 1000,
  updatedAt: 1000,
  createdBy: "user-1",
  version: "1",
};

function pageOf(row: object) {
  return { tasks: [row], hasMore: false };
}

function taskRowWithCounts() {
  return {
    epic: {
      light: { ...EPIC_LIGHT, ...COUNTS },
      permission: null,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
  };
}

function taskRowWithoutCounts() {
  return {
    epic: {
      light: EPIC_LIGHT,
      permission: null,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
  };
}

// A light parsed from a row that carried counts must come out without them.
function expectNoCountKeys(light: object | null | undefined): void {
  expect(light).toBeTruthy();
  for (const key of COUNT_KEYS) {
    expect(light).not.toHaveProperty(key);
  }
}

describe("epic.listTasks task light counts", () => {
  it("@1.8 keeps htmlCount, canvasCount and fileCount on the epic light", () => {
    const parsed = epicListTasksV18.responseSchema.parse(
      pageOf(taskRowWithCounts()),
    );
    expect(parsed.tasks[0]?.epic?.light).toMatchObject(COUNTS);
  });

  it("@1.8 accepts a row from a producer that sends no counts", () => {
    const parsed = epicListTasksV18.responseSchema.parse(
      pageOf(taskRowWithoutCounts()),
    );
    expectNoCountKeys(parsed.tasks[0]?.epic?.light);
  });

  it("@1.8 refuses a count that is not a number", () => {
    const row = taskRowWithCounts();
    const malformed = {
      epic: { ...row.epic, light: { ...row.epic.light, htmlCount: "2" } },
    };
    expect(
      epicListTasksV18.responseSchema.safeParse(pageOf(malformed)).success,
    ).toBe(false);
  });

  it("@1.7 strips the counts and keeps every pre-html field", () => {
    const parsed = epicListTasksV17.responseSchema.parse(
      pageOf(taskRowWithCounts()),
    );
    const light = parsed.tasks[0]?.epic?.light;
    expectNoCountKeys(light);
    expect(light).toMatchObject(EPIC_LIGHT);
  });
});

describe("epic.create@1.2 response task light", () => {
  it("strips the counts from the created task row", () => {
    const parsed = epicCreateV12.responseSchema.parse({
      roomInfo: null,
      task: taskRowWithCounts(),
    });
    expectNoCountKeys(parsed.task?.epic?.light);
    expect(parsed.task?.epic?.light).toMatchObject(EPIC_LIGHT);
  });
});

describe("epic.updateTitle epic delta", () => {
  it("strips the counts from the delta the host accepts", () => {
    const parsed = epicUpdateTitleV10.requestSchema.parse({
      epicDelta: { id: "epic-1", title: "Renamed", updatedAt: 5, ...COUNTS },
    });
    expectNoCountKeys(parsed.epicDelta);
    expect(parsed.epicDelta).toMatchObject({ id: "epic-1", title: "Renamed" });
  });
});

describe("organization.history task light", () => {
  it.each([
    ["@1.0", organizationHistoryV10.responseSchema],
    ["@1.1", organizationHistoryV11.responseSchema],
  ])("%s strips the counts from each history row", (_label, schema) => {
    const parsed = schema.parse(pageOf(taskRowWithCounts()));
    const light = parsed.tasks[0]?.epic?.light;
    expectNoCountKeys(light);
    expect(light).toMatchObject(EPIC_LIGHT);
  });
});

describe("epic.subscribe snapshot meta epic light", () => {
  const metaBody = {
    permissionRole: null,
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
  };
  const epicLightWithCounts = { ...EPIC_LIGHT, ...COUNTS };

  it("strips the counts from the latest snapshot meta", () => {
    const parsed = snapshotMetaEpicSchema.parse({
      ...metaBody,
      schemaVersion: "4.0.0",
      epicLight: epicLightWithCounts,
      hostStateVectorBase64: "",
    });
    expectNoCountKeys(parsed.epicLight);
  });

  it("strips the counts from the frozen 1.0 snapshot meta", () => {
    const parsed = snapshotMetaEpicSchemaV10.parse({
      ...metaBody,
      schemaVersion: "4.0.0",
      epicLight: epicLightWithCounts,
      hostStateVectorBase64: "",
    });
    expectNoCountKeys(parsed.epicLight);
  });

  it("strips the counts from the early meta", () => {
    const parsed = earlyMetaEpicSchema.parse({
      ...metaBody,
      epicLight: epicLightWithCounts,
    });
    expectNoCountKeys(parsed.epicLight);
  });
});
