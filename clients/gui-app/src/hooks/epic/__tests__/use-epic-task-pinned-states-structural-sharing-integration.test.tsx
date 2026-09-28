import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type {
  GetTaskContextsResponse,
  ListTaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";

/**
 * PR 2150 cold-review test gap: the `structuralSharing` merge
 * (`keepAnsweredOverTransientUnknown`) is unit-tested against plain objects
 * elsewhere, but nothing drove it through TanStack's REAL `useQueries` +
 * `combine` pipeline, where it actually has to run as the option TanStack
 * calls on every settled fetch. This is that drive: a real host client fake
 * (same shape as `use-epic-task-pinned-states-unverified-probe.test.tsx`'s
 * `makeClient`), a REAL `useHostQueries` (not mocked away, unlike that
 * probe's harness), and the real `useEpicTaskPinnedStates` +
 * `useRetryUnansweredTaskPinReading` pair.
 *
 * No local-homed epics are registered, so `useLocalHomedOpenTaskRows` and
 * `overlayLocalHomedPinnedStates` both run over an empty population and are
 * inert - this drives the CLOUD arm alone, which is what the fix touches.
 */

const HOST_ID = "host-1";
const USER_ID = "user-1";

interface GetTaskContextsParams {
  readonly taskIds: ReadonlyArray<string>;
}

const transport = vi.hoisted(() => {
  const state: {
    dispatched: Array<{ taskIds: ReadonlyArray<string> }>;
  } = { dispatched: [] };
  return state;
});

let respondFirst: ((value: GetTaskContextsResponse) => void) | null = null;

function listTaskLight(epicId: string, pinned: boolean): ListTaskLight {
  return {
    epic: {
      light: {
        id: epicId,
        title: epicId,
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
    pinned,
  };
}

function response(
  entries: Readonly<Record<string, { pinned: boolean } | "unknown">>,
): GetTaskContextsResponse {
  const tasks: GetTaskContextsResponse["tasks"] = {};
  for (const [epicId, value] of Object.entries(entries)) {
    tasks[epicId] =
      value === "unknown"
        ? { status: "unknown", reason: "transport" }
        : { status: "found", task: listTaskLight(epicId, value.pinned) };
  }
  return { tasks, localHomedTaskIds: undefined };
}

const mockClient = {
  getActiveHostId: () => HOST_ID,
  getRequestContextUserId: () => USER_ID,
  requestWithSignal: (
    _method: string,
    params: unknown,
  ): Promise<GetTaskContextsResponse> => {
    const { taskIds } = params as GetTaskContextsParams;
    transport.dispatched.push({ taskIds });
    if (transport.dispatched.length === 1) {
      // The strip's first read: epic-a resolves, epic-b does not. Held open
      // so the ABSENT-while-in-flight assertion below has a real window to
      // land in, rather than racing the same microtask that started it.
      return new Promise<GetTaskContextsResponse>((resolve) => {
        respondFirst = resolve;
      });
    }
    // The retry's re-ask: epic-b now resolves, and epic-a - already
    // answered - comes back transiently `unknown`. This is exactly the
    // structural-sharing case: epic-a's earlier `found` must survive it.
    return Promise.resolve(
      response({ "epic-a": "unknown", "epic-b": { pinned: true } }),
    );
  },
};

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useHostClient: () => mockClient,
    useHostBinding: () => ({
      hostId: HOST_ID,
      hostClient: {
        ...mockClient,
        createRequesterForHostId: () => null,
      },
    }),
  };
});

import {
  useEpicTaskPinnedStates,
  useRetryUnansweredTaskPinReading,
} from "@/hooks/epic/use-epic-task-pinned-states-query";
import { useAuthStore } from "@/stores/auth/auth-store";

const PROFILE = { userId: USER_ID, userName: "U", email: "u@example.com" };
const CONTEXT = { userId: USER_ID, username: "U" };

function makeWrapper(
  queryClient: QueryClient,
): ({ children }: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

describe("useEpicTaskPinnedStates + useRetryUnansweredTaskPinReading - real useQueries, structural-sharing integration", () => {
  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    transport.dispatched.length = 0;
    respondFirst = null;
  });

  it("keeps epic-a's earlier `found` reading across a retry that answers epic-b but re-asks epic-a as `unknown`", async () => {
    useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const epicIds = ["epic-a", "epic-b"];

    const { result } = renderHook(
      () => ({
        pinnedStates: useEpicTaskPinnedStates(epicIds),
        retry: useRetryUnansweredTaskPinReading(epicIds),
      }),
      { wrapper: makeWrapper(queryClient) },
    );

    // In flight: the batch has not settled, so both ids are absent - not a
    // `pinnedKnown: false` filler, which is reserved for a SETTLED miss.
    expect(result.current.pinnedStates.get("epic-a")).toBeUndefined();
    expect(result.current.pinnedStates.get("epic-b")).toBeUndefined();
    expect(transport.dispatched).toHaveLength(1);

    respondFirst?.(
      response({ "epic-a": { pinned: true }, "epic-b": "unknown" }),
    );

    await waitFor(() => {
      expect(result.current.pinnedStates.get("epic-a")?.pinnedKnown).toBe(true);
    });
    expect(result.current.pinnedStates.get("epic-a")).toEqual({
      pinned: true,
      home: undefined,
      hostId: null,
      pinnedKnown: true,
    });
    // Settled without an answer for epic-b: the unanswered filler, not
    // absence.
    expect(result.current.pinnedStates.get("epic-b")).toEqual({
      pinned: false,
      home: undefined,
      hostId: null,
      pinnedKnown: false,
    });

    // The menu-open retry for epic-b, whose re-ask answers epic-b but comes
    // back `unknown` for the already-answered epic-a.
    result.current.retry("epic-b");

    await waitFor(() => {
      expect(result.current.pinnedStates.get("epic-b")?.pinnedKnown).toBe(true);
    });
    expect(result.current.pinnedStates.get("epic-b")).toEqual({
      pinned: true,
      home: undefined,
      hostId: null,
      pinnedKnown: true,
    });
    // The structural-sharing merge: epic-a's reading survives the transient
    // `unknown` the retry's OWN response carried for it.
    expect(result.current.pinnedStates.get("epic-a")).toEqual({
      pinned: true,
      home: undefined,
      hostId: null,
      pinnedKnown: true,
    });
    expect(transport.dispatched).toHaveLength(2);
  });
});
