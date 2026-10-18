/**
 * Ticket E17 checkpoint 6, cold-review fix (the owning-team readers follow the
 * cached task lists when a list is REMOVED, not only when one is written).
 *
 * The hooks read the person's cached task lists through a cache subscription.
 * A removed query is no longer in the cache by the time its event arrives, so
 * a subscription that resolves the event's query by hash after the fact never
 * sees the removal and the hook keeps answering from a list that is gone.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type {
  ListTaskLight,
  ListTasksResponse,
  PermissionDto,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  LIST_CLOUD_TASKS_REQUEST,
  cloudEpicTasksQueryKey,
} from "@/lib/cloud-epic-tasks-query";
import {
  useEpicOwningTeamId,
  usePersonHasTeamTask,
} from "@/hooks/epics/use-epic-owning-team";
import { useAuthStore } from "@/stores/auth/auth-store";

const USER_ID = "user-1";
const HOST_ID = "host-a";

const TEAM_PERMISSION: PermissionDto = {
  accessType: "organization",
  organizationId: "t1",
  role: "owner",
  grantedBy: "user-2",
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

const TASKS_KEY = cloudEpicTasksQueryKey(
  HOST_ID,
  USER_ID,
  LIST_CLOUD_TASKS_REQUEST,
);

function seed(
  queryClient: QueryClient,
  tasks: ReadonlyArray<ListTaskLight>,
): void {
  queryClient.setQueryData<ListTasksResponse>(TASKS_KEY, {
    tasks: [...tasks],
    hasMore: false,
  });
}

function wrapperFor(
  queryClient: QueryClient,
): (props: { readonly children: ReactNode }) => ReactNode {
  return function Wrapper(props: { readonly children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  };
}

describe("useEpicOwningTeamId and usePersonHasTeamTask", () => {
  beforeEach(() => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: USER_ID, username: "viewer" },
      shareableTeams: [],
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

  it("reads the owning team of a cached epic", () => {
    const queryClient = new QueryClient();
    seed(queryClient, [epicTask("e-team", TEAM_PERMISSION)]);

    const { result } = renderHook(() => useEpicOwningTeamId("e-team"), {
      wrapper: wrapperFor(queryClient),
    });

    expect(result.current).toBe("t1");
  });

  it("drops the team when the cached list is removed, with no other re-render", () => {
    const queryClient = new QueryClient();
    seed(queryClient, [epicTask("e-team", TEAM_PERMISSION)]);
    const { result } = renderHook(() => useEpicOwningTeamId("e-team"), {
      wrapper: wrapperFor(queryClient),
    });
    expect(result.current).toBe("t1");

    act(() => {
      queryClient.removeQueries({ queryKey: TASKS_KEY });
    });

    expect(result.current).toBeNull();
  });

  it("picks up an epic that a list written after mount adds", () => {
    const queryClient = new QueryClient();
    seed(queryClient, [epicTask("e-other", null)]);
    const { result } = renderHook(() => useEpicOwningTeamId("e-team"), {
      wrapper: wrapperFor(queryClient),
    });
    expect(result.current).toBeNull();

    act(() => {
      seed(queryClient, [
        epicTask("e-other", null),
        epicTask("e-team", TEAM_PERMISSION),
      ]);
    });

    expect(result.current).toBe("t1");
  });

  it("answers null while nothing is cached and for no epic id", () => {
    const queryClient = new QueryClient();
    const { result } = renderHook(() => useEpicOwningTeamId(""), {
      wrapper: wrapperFor(queryClient),
    });

    expect(result.current).toBeNull();
  });

  it("drops the person's team task when the cached list is removed", () => {
    const queryClient = new QueryClient();
    seed(queryClient, [epicTask("e-team", TEAM_PERMISSION)]);
    const { result } = renderHook(() => usePersonHasTeamTask("t1"), {
      wrapper: wrapperFor(queryClient),
    });
    expect(result.current).toBe(true);

    act(() => {
      queryClient.removeQueries({ queryKey: TASKS_KEY });
    });

    expect(result.current).toBe(false);
  });
});
