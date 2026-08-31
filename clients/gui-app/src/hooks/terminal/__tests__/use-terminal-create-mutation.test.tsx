import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { CanonicalTerminalSessionInfo } from "@traycer/protocol/host/terminal/unary-schemas";
import { useTerminalCreate } from "@/hooks/terminal/use-terminal-create-mutation";
import { exactTerminalListQueryKey } from "@/lib/terminals/refresh-host-terminal-list";

const toastFromHostError = vi.hoisted(() =>
  vi.fn<(error: HostRpcError, fallbackMessage: string) => void>(),
);

vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: (error: HostRpcError, fallbackMessage: string): void =>
    toastFromHostError(error, fallbackMessage),
}));

const HOST_ID = "host-1";
const SCOPE = { kind: "epic" as const, epicId: "epic-1" };
const SESSION_ID = "term-1";

const CREATE_REQUEST = {
  scope: SCOPE,
  sessionKind: "terminal" as const,
  tuiHarnessId: null,
  cwd: "/repo",
  shellCommand: null,
  shellArgs: null,
  cols: 80,
  rows: 24,
  desiredSessionId: SESSION_ID,
  worktreeBusyPaths: [] as string[],
  themeHint: null,
};

function runningSession(sessionId: string): CanonicalTerminalSessionInfo {
  return {
    sessionId,
    scope: SCOPE,
    sessionKind: "terminal",
    cwd: "/repo",
    shellCommand: "/bin/zsh",
    shellArgs: [],
    cols: 80,
    rows: 24,
    status: "running",
    exitCode: null,
    createdAt: 0,
    title: "stale-cache",
  };
}

function createError(): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: "lost response",
    requestId: "req-create",
    method: "terminal.create",
    fatalDetails: null,
  });
}

function listError(): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: "list failed",
    requestId: "req-list",
    method: "terminal.list",
    fatalDetails: null,
  });
}

describe("useTerminalCreate lost-response recovery", () => {
  let queryClient: QueryClient;
  const hostRequest =
    vi.fn<(method: string, params: unknown) => Promise<unknown>>();

  beforeEach(() => {
    toastFromHostError.mockReset();
    hostRequest.mockReset();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  });

  afterEach(() => {
    queryClient.clear();
  });

  function renderCreate() {
    const client = {
      request: hostRequest,
      getActiveHostId: () => HOST_ID,
    } as never;
    const wrapper = (props: { readonly children: ReactNode }) =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        props.children,
      );
    return renderHook(() => useTerminalCreate(client), { wrapper });
  }

  it("does not treat a stale cached row as proof when create and isolated list fail", async () => {
    const listKey = exactTerminalListQueryKey(HOST_ID, SCOPE);
    queryClient.setQueryData(listKey, {
      sessions: [runningSession(SESSION_ID)],
      homeCwd: "/stale-home",
    });
    hostRequest.mockImplementation((method) => {
      if (method === "terminal.create") return Promise.reject(createError());
      if (method === "terminal.list") return Promise.reject(listError());
      return Promise.reject(new Error(`unexpected method ${method}`));
    });

    const { result } = renderCreate();
    await expect(result.current.mutateAsync(CREATE_REQUEST)).rejects.toThrow(
      "lost response",
    );
    await waitFor(() => expect(toastFromHostError).toHaveBeenCalled());
    expect(
      queryClient.getQueryData<{
        readonly sessions: ReadonlyArray<{ readonly title: string | null }>;
        readonly homeCwd: string | null;
      }>(listKey),
    ).toEqual({
      sessions: [runningSession(SESSION_ID)],
      homeCwd: "/stale-home",
    });
  });

  it("publishes an isolated matching snapshot and suppresses the toast", async () => {
    const listKey = exactTerminalListQueryKey(HOST_ID, SCOPE);
    queryClient.setQueryData(listKey, {
      sessions: [],
      homeCwd: "/old-home",
    });
    const discovered = { ...runningSession(SESSION_ID), title: "from-list" };
    hostRequest.mockImplementation((method) => {
      if (method === "terminal.create") return Promise.reject(createError());
      if (method === "terminal.list") {
        return Promise.resolve({
          sessions: [discovered],
          homeCwd: "/fresh-home",
        });
      }
      return Promise.reject(new Error(`unexpected method ${method}`));
    });

    const { result } = renderCreate();
    await expect(result.current.mutateAsync(CREATE_REQUEST)).rejects.toThrow(
      "lost response",
    );
    await waitFor(() =>
      expect(
        queryClient.getQueryData<{
          readonly homeCwd: string | null;
        }>(listKey)?.homeCwd,
      ).toBe("/fresh-home"),
    );
    expect(toastFromHostError).not.toHaveBeenCalled();
  });
});
