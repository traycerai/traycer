import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { TaskHostRow } from "@traycer/protocol/host/task-host-summary";

interface TaskHostsState {
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: { readonly code: string } | null;
  readonly data: { readonly hosts: readonly TaskHostRow[] } | undefined;
  readonly refetch: () => Promise<void>;
}

const mocks = vi.hoisted(() => ({
  /** The Epic session's client: an identity the query is called with. */
  client: { kind: "epic-session-client" },
  cloudAuthorized: true,
  /** The signed-in viewer's id; empty when no one is signed in. */
  viewerId: "viewer-1",
  taskHosts: null as TaskHostsState | null,
  calls: [] as { client: object | null; taskId: string }[],
  refetch: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => mocks.client,
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatHasCloudAuthorization: () => mocks.cloudAuthorized,
  useCloudChatViewerId: () => mocks.viewerId,
}));
vi.mock("@/hooks/epic/use-task-hosts-query", () => ({
  useTaskHosts: (client: object | null, taskId: string) => {
    mocks.calls.push({ client, taskId });
    return mocks.taskHosts;
  },
}));

import { useTaskHostsView } from "@/hooks/epic/use-task-hosts-view";

const EPIC_ID = "epic-1";

const HOSTS: readonly TaskHostRow[] = [
  {
    hostId: "h-1",
    label: "laptop",
    principal: { kind: "user", id: "u-viewer" },
    reach: "same_principal",
    sandboxEnd: null,
  },
  {
    hostId: "h-2",
    label: null,
    principal: { kind: "team", id: "team-1" },
    reach: "other_principal",
    sandboxEnd: null,
  },
];

function answered(hosts: readonly TaskHostRow[]): TaskHostsState {
  return {
    isPending: false,
    isError: false,
    error: null,
    data: { hosts },
    refetch: mocks.refetch,
  };
}

function failedWithoutData(code: string): TaskHostsState {
  return {
    isPending: false,
    isError: true,
    error: { code },
    data: undefined,
    refetch: mocks.refetch,
  };
}

function failedOverData(
  code: string,
  hosts: readonly TaskHostRow[],
): TaskHostsState {
  return {
    isPending: false,
    isError: true,
    error: { code },
    data: { hosts },
    refetch: mocks.refetch,
  };
}

beforeEach(() => {
  mocks.cloudAuthorized = true;
  mocks.viewerId = "viewer-1";
  mocks.taskHosts = null;
  mocks.calls.length = 0;
  mocks.refetch.mockReset();
  mocks.refetch.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("useTaskHostsView", () => {
  it("reads the query through the Epic session's client and the epic id", () => {
    mocks.taskHosts = answered(HOSTS);
    renderHook(() => useTaskHostsView(EPIC_ID));

    expect(mocks.calls[0]).toEqual({ client: mocks.client, taskId: EPIC_ID });
  });

  it("is hosts, carrying the rows, when the query holds some", () => {
    mocks.taskHosts = answered(HOSTS);
    const { result } = renderHook(() => useTaskHostsView(EPIC_ID));

    expect(result.current).toEqual({ kind: "hosts", hosts: HOSTS });
  });

  it("is none with no viewer, even when the query holds hosts", () => {
    mocks.taskHosts = answered(HOSTS);
    mocks.viewerId = "";
    const { result } = renderHook(() => useTaskHostsView(EPIC_ID));

    expect(result.current).toEqual({ kind: "none" });
  });

  it("is none when the list is empty", () => {
    mocks.taskHosts = answered([]);
    const { result } = renderHook(() => useTaskHostsView(EPIC_ID));

    expect(result.current).toEqual({ kind: "none" });
  });

  it("is none while the query is pending", () => {
    mocks.taskHosts = {
      isPending: true,
      isError: false,
      error: null,
      data: undefined,
      refetch: mocks.refetch,
    };
    const { result } = renderHook(() => useTaskHostsView(EPIC_ID));

    expect(result.current).toEqual({ kind: "none" });
  });
});

describe("useTaskHostsView without cloud authorization", () => {
  it("withholds cached data: none, though the query holds hosts", () => {
    mocks.cloudAuthorized = false;
    mocks.taskHosts = answered(HOSTS);
    const { result } = renderHook(() => useTaskHostsView(EPIC_ID));

    expect(result.current).toEqual({ kind: "none" });
  });

  it("withholds a failure too: none, not an error to retry", () => {
    mocks.cloudAuthorized = false;
    mocks.taskHosts = failedWithoutData("E_HOST_TIMEOUT");
    const { result } = renderHook(() => useTaskHostsView(EPIC_ID));

    expect(result.current).toEqual({ kind: "none" });
  });

  it("serves the hosts again once the authorization returns", () => {
    mocks.cloudAuthorized = false;
    mocks.taskHosts = answered(HOSTS);
    const { result, rerender } = renderHook(() => useTaskHostsView(EPIC_ID));
    expect(result.current).toEqual({ kind: "none" });

    mocks.cloudAuthorized = true;
    rerender();

    expect(result.current).toEqual({ kind: "hosts", hosts: HOSTS });
  });
});

describe("useTaskHostsView when a refetch fails over data", () => {
  it("keeps the hosts shown after a failed refetch", () => {
    mocks.taskHosts = failedOverData("E_HOST_TIMEOUT", HOSTS);
    const { result } = renderHook(() => useTaskHostsView(EPIC_ID));

    expect(result.current).toEqual({ kind: "hosts", hosts: HOSTS });
  });

  it("keeps the hosts when the refusal is E_HOST_UNSUPPORTED too: the data wins", () => {
    mocks.taskHosts = failedOverData("E_HOST_UNSUPPORTED", HOSTS);
    const { result } = renderHook(() => useTaskHostsView(EPIC_ID));

    expect(result.current).toEqual({ kind: "hosts", hosts: HOSTS });
  });

  it("is none when the data it kept is an empty list", () => {
    mocks.taskHosts = failedOverData("E_HOST_TIMEOUT", []);
    const { result } = renderHook(() => useTaskHostsView(EPIC_ID));

    expect(result.current).toEqual({ kind: "none" });
  });
});

describe("useTaskHostsView with no data", () => {
  it("is none for a host that predates the surface (E_HOST_UNSUPPORTED)", () => {
    mocks.taskHosts = failedWithoutData("E_HOST_UNSUPPORTED");
    const { result } = renderHook(() => useTaskHostsView(EPIC_ID));

    expect(result.current).toEqual({ kind: "none" });
  });

  it("is an error for any other failure, and retry refetches the query", () => {
    mocks.taskHosts = failedWithoutData("E_HOST_TIMEOUT");
    const { result } = renderHook(() => useTaskHostsView(EPIC_ID));

    expect(result.current.kind).toBe("error");
    if (result.current.kind !== "error") {
      throw new Error("expected an error view");
    }
    expect(mocks.refetch).not.toHaveBeenCalled();
    result.current.retry();
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });

  it("is an error for a refusal that is not a missing method either", () => {
    mocks.taskHosts = failedWithoutData("FORBIDDEN");
    const { result } = renderHook(() => useTaskHostsView(EPIC_ID));

    expect(result.current.kind).toBe("error");
  });
});
