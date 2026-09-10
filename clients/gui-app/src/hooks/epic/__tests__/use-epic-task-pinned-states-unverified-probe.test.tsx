import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type {
  ListTaskLight,
  ListTasksResponse,
} from "@traycer/protocol/host/epic/unary-schemas";

/**
 * R1 - a COLD unverified tab obtains a pin reading.
 *
 * The defect this pins: pin state for the tab strip came only from
 * `epic.getTaskContexts`, which is gated on the cloud verdict, so an
 * `unverified` session got no answer at all - and since `epic.setPinned@1.1`
 * made a local-homed row pinnable, "no answer" became a rendered "Pin" for an
 * epic that may already be pinned, inverted by the click. The fix reads the pin
 * off the host's own `epic.listTasks` local rows, the line that same session is
 * already admitted on.
 *
 * This is the REAL hook: its gating (`enabled: true` on the pin-reading
 * queries, deliberately not `cloudAuthorized`), the real
 * `epicPinReadingListQueryOptions`, real TanStack `useQueries` + `combine`, and
 * the real overlay. Stubbed are exactly two seams - the transport
 * (`fetchCloudEpicTasksFirstPageByHostId`) and the session registry that says
 * which open epics are local-homed and on which host. Both are inputs to the
 * behaviour under test, not part of it.
 *
 * `unverified` is the subject; `verified` is the control that the same read
 * works when a verdict exists (so a red unverified row means the GATE, not a
 * broken fixture); and a cloud-homed row is the control that stays unknown -
 * nothing answered for it, and `pinnedKnown: false` says so.
 */

const EPIC_LOCAL = "epic-local";
const EPIC_CLOUD = "epic-cloud";
const OWNING_HOST_ID = "host-owning";
const USER_ID = "user-1";

const registryState = vi.hoisted(() => {
  const state: {
    localHomedEpicIds: ReadonlySet<string>;
    localHomedByHost: ReadonlyMap<string, string>;
  } = { localHomedEpicIds: new Set(), localHomedByHost: new Map() };
  return state;
});

const fetchFirstPage = vi.hoisted(() => vi.fn());

vi.mock("@/lib/registries/epic-session-registry", () => ({
  useLocalHomedOpenEpicIds: () => registryState.localHomedEpicIds,
  useLocalHomedOpenEpicHostIds: () => registryState.localHomedByHost,
}));

vi.mock("@/lib/cloud-epic-tasks-query/query", () => ({
  fetchCloudEpicTasksFirstPageByHostId: fetchFirstPage,
  // `epicPinReadingListQueryOptions` is the real one, and it imports this
  // module's request constant alongside the fetcher.
  LIST_CLOUD_TASKS_REQUEST: {
    limit: 25,
    filters: { taskType: "epic" as const },
    extensionPhaseVersion: "1",
    extensionEpicVersion: "1",
  },
}));

// The cloud batch. Under an unverified session the hook must not dispatch it at
// all; this records whether it was enabled so the probe can say so.
const hostQueriesCalls: Array<{ enabled: boolean }> = [];

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQueries: (args: { options: { enabled: boolean } }) => {
    hostQueriesCalls.push({ enabled: args.options.enabled });
    return new Map();
  },
}));

vi.mock("@/lib/host/runtime", () => ({
  useHostClient: () => ({
    getActiveHostId: () => "host-window",
    getRequestContextUserId: () => USER_ID,
  }),
}));

import { useEpicTaskPinnedStates } from "@/hooks/epic/use-epic-task-pinned-states-query";
import { useAuthStore } from "@/stores/auth/auth-store";

const PROFILE = { userId: USER_ID, userName: "U", email: "u@example.com" };
const CONTEXT = { userId: USER_ID, username: "U" };

function localRow(epicId: string, pinned: boolean): ListTaskLight {
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
    home: "local",
  };
}

function page(tasks: readonly ListTaskLight[]): ListTasksResponse {
  return { tasks: [...tasks], hasMore: false };
}

function makeWrapper(
  queryClient: QueryClient,
): ({ children }: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

function renderPinnedStates(epicIds: ReadonlyArray<string>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderHook(() => useEpicTaskPinnedStates(epicIds), {
    wrapper: makeWrapper(queryClient),
  });
}

describe("useEpicTaskPinnedStates - the unverified pin reading (R1)", () => {
  beforeEach(() => {
    hostQueriesCalls.length = 0;
    fetchFirstPage.mockReset();
    // The session knows this epic is local-homed on the owning host; it is the
    // epic's own stream that says so, independent of any cloud read.
    registryState.localHomedEpicIds = new Set([EPIC_LOCAL]);
    registryState.localHomedByHost = new Map([[EPIC_LOCAL, OWNING_HOST_ID]]);
    fetchFirstPage.mockResolvedValue(page([localRow(EPIC_LOCAL, true)]));
    // `contextMetadata.userId` is present under BOTH statuses - it admits the
    // local plane and is deliberately not the spend gate.
    useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
  });

  afterEach(() => {
    useAuthStore.getState().setSignedOut();
  });

  it("reads the pin off the owning host's local rows under an unverified session", async () => {
    useAuthStore.setState({ status: "unverified" });

    const { result } = renderPinnedStates([EPIC_LOCAL]);

    await waitFor(() => {
      expect(result.current.get(EPIC_LOCAL)?.pinnedKnown).toBe(true);
    });
    expect(result.current.get(EPIC_LOCAL)).toEqual({
      pinned: true,
      home: "local",
      hostId: OWNING_HOST_ID,
      pinnedKnown: true,
    });
    // The reading came off the OWNING host, not the window's.
    expect(fetchFirstPage.mock.calls[0]?.[0]).toBe(OWNING_HOST_ID);
    expect(fetchFirstPage.mock.calls[0]?.[1]).toBe(USER_ID);
    // And the cloud batch stayed shut the whole time - this read spends no
    // cloud capability, which is why it is admissible with no verdict.
    expect(hostQueriesCalls.every((call) => !call.enabled)).toBe(true);
  });

  it("reads an UNPINNED local row as a real `false`, not as filler", async () => {
    useAuthStore.setState({ status: "unverified" });
    fetchFirstPage.mockResolvedValue(page([localRow(EPIC_LOCAL, false)]));

    const { result } = renderPinnedStates([EPIC_LOCAL]);

    await waitFor(() => {
      expect(result.current.get(EPIC_LOCAL)?.pinnedKnown).toBe(true);
    });
    expect(result.current.get(EPIC_LOCAL)?.pinned).toBe(false);
  });

  it("control - the same read works for a verified session", async () => {
    const { result } = renderPinnedStates([EPIC_LOCAL]);

    await waitFor(() => {
      expect(result.current.get(EPIC_LOCAL)?.pinnedKnown).toBe(true);
    });
    expect(result.current.get(EPIC_LOCAL)?.pinned).toBe(true);
  });

  it("control - a cloud-homed row stays unknown, with no host named", async () => {
    useAuthStore.setState({ status: "unverified" });
    // No session reports this epic local-homed, and the owning host's page
    // carries no row for it either.
    registryState.localHomedEpicIds = new Set();
    registryState.localHomedByHost = new Map();

    const { result } = renderPinnedStates([EPIC_CLOUD]);

    // Nothing can answer: the cloud batch is shut and there is no local row.
    await waitFor(() => {
      expect(fetchFirstPage).not.toHaveBeenCalled();
    });
    expect(result.current.get(EPIC_CLOUD)).toBeUndefined();
  });

  it("control - a local-homed row the host's page omits stays unknown", async () => {
    useAuthStore.setState({ status: "unverified" });
    // Two local-homed tabs on the one host, and the host's page carries a row
    // for only ONE of them. The answered epic is the settle signal - asserting
    // it in the SAME rendered state is what makes "still unknown" mean "the
    // query resolved and said nothing about this row", rather than "the query
    // had not come back yet", which is the way this control goes vacuous.
    registryState.localHomedEpicIds = new Set([EPIC_LOCAL, "epic-answered"]);
    registryState.localHomedByHost = new Map([
      [EPIC_LOCAL, OWNING_HOST_ID],
      ["epic-answered", OWNING_HOST_ID],
    ]);
    fetchFirstPage.mockResolvedValue(page([localRow("epic-answered", true)]));

    const { result } = renderPinnedStates([EPIC_LOCAL, "epic-answered"]);

    await waitFor(() => {
      expect(result.current.get("epic-answered")?.pinnedKnown).toBe(true);
    });
    expect(result.current.get(EPIC_LOCAL)).toEqual({
      pinned: false,
      home: "local",
      hostId: OWNING_HOST_ID,
      pinnedKnown: false,
    });
  });
});
