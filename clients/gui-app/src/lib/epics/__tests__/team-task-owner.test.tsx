import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import type {
  ListTaskLight,
  ListTasksResponse,
  PermissionDto,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  EMPTY_LOCAL_HOMED_TASK_IDS,
  buildHistoryItemsFromTasks,
} from "@/components/home/data/home-page.data";
import { TeamTaskChip } from "@/components/epics/team-task-chip";
import {
  LIST_CLOUD_TASKS_REQUEST,
  cloudEpicTasksQueryKey,
} from "@/lib/cloud-epic-tasks-query";
import { readEpicOwningTeamIdFromCloudTaskCaches } from "@/lib/cloud-epic-tasks-query/cache";
import {
  UNKNOWN_TEAM_LABEL,
  taskOwningTeamId,
  tasksIncludeTeamTask,
  teamTaskLabel,
} from "@/lib/epics/team-task-owner";
import type { EpicShareableTeam } from "@/stores/auth/auth-store";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Ticket E17 checkpoint 6 (part A, the team that owns a task): read off the
 * viewer's permission row, carried onto History rows, found again in the
 * cached task lists, and named by a chip.
 */

const ACME: EpicShareableTeam = {
  teamId: "t1",
  slug: "acme",
  avatarUrl: null,
};
const BETA: EpicShareableTeam = {
  teamId: "t2",
  slug: "beta",
  avatarUrl: null,
};
const USER_ID = "user-1";
const NOW_MS = Date.parse("2026-10-16T12:00:00.000Z");

const TEAM_PERMISSION: PermissionDto = {
  accessType: "organization",
  organizationId: "t1",
  role: "owner",
  grantedBy: "user-2",
  grantedAt: 1,
};
const DIRECT_PERMISSION: PermissionDto = {
  accessType: "direct",
  userId: USER_ID,
  role: "owner",
  grantedBy: USER_ID,
  grantedAt: 1,
};

function epicTask(
  epicId: string,
  permission: PermissionDto | null,
): ListTaskLight {
  return {
    epic: {
      light: {
        id: epicId,
        title: `Epic ${epicId}`,
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "draft",
        createdAt: Date.parse("2026-10-16T10:00:00.000Z"),
        updatedAt: Date.parse("2026-10-16T11:00:00.000Z"),
        createdBy: USER_ID,
        version: "1.0.0",
      },
      permission,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
    phase: null,
    pinned: false,
  };
}

function phaseTask(
  phaseId: string,
  permission: PermissionDto | null,
): ListTaskLight {
  return {
    epic: null,
    phase: {
      light: {
        id: phaseId,
        title: `Phase ${phaseId}`,
        userQuery: "Do phase work",
        phaseLength: 1,
        status: "ready",
        createdAt: Date.parse("2026-10-16T10:00:00.000Z"),
        updatedAt: Date.parse("2026-10-16T11:00:00.000Z"),
        createdBy: USER_ID,
        version: "1.0.0",
      },
      permission,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
    pinned: false,
  };
}

describe("taskOwningTeamId", () => {
  it("is the organization of an organization permission", () => {
    expect(taskOwningTeamId(TEAM_PERMISSION)).toBe("t1");
  });

  it.each(["direct", "link"] as const)(
    "is null for a %s permission, even one that names an organization",
    (accessType) => {
      expect(
        taskOwningTeamId({
          ...TEAM_PERMISSION,
          accessType,
          organizationId: "t1",
        }),
      ).toBeNull();
    },
  );

  it("is null for an organization permission with no organization", () => {
    expect(
      taskOwningTeamId({
        accessType: "organization",
        role: "editor",
        grantedBy: "user-2",
        grantedAt: 1,
      }),
    ).toBeNull();
  });

  it("is null for an organization permission with an empty organization", () => {
    expect(
      taskOwningTeamId({ ...TEAM_PERMISSION, organizationId: "" }),
    ).toBeNull();
  });

  it("is null for no permission", () => {
    expect(taskOwningTeamId(null)).toBeNull();
    expect(taskOwningTeamId(undefined)).toBeNull();
  });

  it("is null for a task merely shared with a team (organization editor grant)", () => {
    expect(
      taskOwningTeamId({
        accessType: "organization",
        organizationId: "org-1",
        role: "editor",
        grantedBy: "u",
        grantedAt: 0,
      }),
    ).toBeNull();
  });

  it("control: is the organization for an organization owner grant", () => {
    expect(
      taskOwningTeamId({
        accessType: "organization",
        organizationId: "org-1",
        role: "owner",
        grantedBy: "u",
        grantedAt: 0,
      }),
    ).toBe("org-1");
  });
});

describe("teamTaskLabel", () => {
  it("names a team the person is in by its slug", () => {
    expect(teamTaskLabel("t1", [ACME, BETA])).toBe("acme");
    expect(teamTaskLabel("t2", [ACME, BETA])).toBe("beta");
  });

  it("calls a team the person cannot name A team", () => {
    expect(UNKNOWN_TEAM_LABEL).toBe("A team");
    expect(teamTaskLabel("t-other", [ACME, BETA])).toBe("A team");
    expect(teamTaskLabel("t1", [])).toBe("A team");
  });
});

describe("tasksIncludeTeamTask", () => {
  it("is true when some task is owned by the team", () => {
    expect(
      tasksIncludeTeamTask(
        [epicTask("e1", DIRECT_PERMISSION), epicTask("e2", TEAM_PERMISSION)],
        "t1",
      ),
    ).toBe(true);
  });

  it("is false when the only team task belongs to another team", () => {
    expect(
      tasksIncludeTeamTask(
        [epicTask("e1", { ...TEAM_PERMISSION, organizationId: "t2" })],
        "t1",
      ),
    ).toBe(false);
  });

  it("is false for direct and permissionless tasks", () => {
    expect(
      tasksIncludeTeamTask(
        [epicTask("e1", DIRECT_PERMISSION), epicTask("e2", null)],
        "t1",
      ),
    ).toBe(false);
  });

  it("is false for a phase-only row, however it is owned", () => {
    expect(tasksIncludeTeamTask([phaseTask("p1", TEAM_PERMISSION)], "t1")).toBe(
      false,
    );
  });

  it("is false for no tasks", () => {
    expect(tasksIncludeTeamTask([], "t1")).toBe(false);
  });
});

describe("readEpicOwningTeamIdFromCloudTaskCaches", () => {
  function seed(
    queryClient: QueryClient,
    userId: string,
    tasks: ReadonlyArray<ListTaskLight>,
  ): void {
    queryClient.setQueryData<ListTasksResponse>(
      cloudEpicTasksQueryKey("host-a", userId, LIST_CLOUD_TASKS_REQUEST),
      { tasks: [...tasks], hasMore: false },
    );
  }

  function read(queryClient: QueryClient, epicId: string): string | null {
    return readEpicOwningTeamIdFromCloudTaskCaches(
      queryClient,
      { hostId: null, userId: USER_ID },
      epicId,
    );
  }

  it("finds the team that owns a cached epic", () => {
    const queryClient = new QueryClient();
    seed(queryClient, USER_ID, [
      epicTask("e-direct", DIRECT_PERMISSION),
      epicTask("e-team", TEAM_PERMISSION),
    ]);

    expect(read(queryClient, "e-team")).toBe("t1");
  });

  it("is null for a cached epic no team owns", () => {
    const queryClient = new QueryClient();
    seed(queryClient, USER_ID, [
      epicTask("e-direct", DIRECT_PERMISSION),
      epicTask("e-team", TEAM_PERMISSION),
    ]);

    expect(read(queryClient, "e-direct")).toBeNull();
  });

  it("is null for an epic no cache holds", () => {
    const queryClient = new QueryClient();
    seed(queryClient, USER_ID, [epicTask("e-team", TEAM_PERMISSION)]);

    expect(read(queryClient, "e-missing")).toBeNull();
  });

  it("is null when nothing is cached", () => {
    expect(read(new QueryClient(), "e-team")).toBeNull();
  });

  it("does not read another account's cache", () => {
    const queryClient = new QueryClient();
    seed(queryClient, "user-2", [epicTask("e-team", TEAM_PERMISSION)]);

    expect(read(queryClient, "e-team")).toBeNull();
  });
});

describe("buildHistoryItemsFromTasks", () => {
  function build(tasks: ReadonlyArray<ListTaskLight>) {
    return buildHistoryItemsFromTasks(
      tasks,
      NOW_MS,
      USER_ID,
      EMPTY_LOCAL_HOMED_TASK_IDS,
    );
  }

  it("carries the owning team onto a team task's row", () => {
    const [item] = build([epicTask("e-team", TEAM_PERMISSION)]);

    expect(item.teamId).toBe("t1");
  });

  it("leaves a direct task's row with no team", () => {
    const [item] = build([epicTask("e-direct", DIRECT_PERMISSION)]);

    expect(item.teamId).toBeNull();
  });

  it("leaves a permissionless task's row with no team", () => {
    const [item] = build([epicTask("e-none", null)]);

    expect(item.teamId).toBeNull();
  });
});

describe("<TeamTaskChip />", () => {
  beforeEach(() => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: USER_ID, username: "viewer" },
      shareableTeams: [ACME],
    });
  });
  afterEach(() => {
    cleanup();
    useAuthStore.setState({
      status: "signed-out",
      contextMetadata: null,
      shareableTeams: [],
    });
  });

  it("names the team by its slug", () => {
    render(<TeamTaskChip teamId="t1" />);

    expect(screen.getByTestId("team-task-chip").textContent).toBe("acme");
  });

  it("calls a team the person is not in A team", () => {
    render(<TeamTaskChip teamId="t-other" />);

    expect(screen.getByTestId("team-task-chip").textContent).toBe("A team");
  });
});
