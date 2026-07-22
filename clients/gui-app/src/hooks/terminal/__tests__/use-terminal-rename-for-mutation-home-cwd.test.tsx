/**
 * Regression: optimistic rename + rollback must preserve top-level
 * `terminal.list@2.1` metadata (`homeCwd`). Session-row patches replace only
 * `sessions`; every other response field must survive mutate and onError.
 */
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import type {
  CanonicalTerminalSessionInfo,
  ListTerminalsResponseV21,
} from "@traycer/protocol/host/terminal/unary-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import type { RenameTerminalMutationContext } from "@/hooks/terminal/use-terminal-rename-for-mutation";
import { hostQueryKeys } from "@/lib/query-keys";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: vi.fn(),
}));

vi.mock("@/lib/analytics", () => ({
  Analytics: {
    getInstance: () => ({ track: vi.fn() }),
  },
  AnalyticsEvent: { TerminalRenamed: "terminal_renamed" },
}));

vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvasStore: {
    getState: () => ({
      updateTerminalNameSnapshots: vi.fn(),
    }),
  },
}));

const HOST_ID = "host-1";
const EPIC_ID = "epic-1";
const SESSION_ID = "term-1";
const HOME_CWD = "/Users/dev";
const ORIGINAL_TITLE = "Setup: repo";
const NEW_TITLE = "renamed shell";

const listKey = [
  ...hostQueryKeys.methodScope(HOST_ID, "terminal.list"),
  { scope: { kind: "epic", epicId: EPIC_ID } },
] as const;

function createBoundHostClient(): HostClient<HostRpcRegistry> {
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    handlers: {},
    requestId: () => "request-test",
  });
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    messenger,
    invalidator: { invalidateHostScope: () => {} },
  });
  client.bind({
    hostId: HOST_ID,
    label: "Test Host",
    kind: "mock",
    websocketUrl: "ws://host.test",
    version: "test",
    status: "available",
  });
  return client;
}

type RenameVariables = { sessionId: string; title: string };

type CapturedOptions = {
  onMutate?: (
    variables: RenameVariables,
  ) => Promise<RenameTerminalMutationContext> | RenameTerminalMutationContext;
  onError?: (
    error: unknown,
    variables: RenameVariables,
    context: RenameTerminalMutationContext | undefined,
  ) => void;
};

let capturedOptions: CapturedOptions = {};

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostMutation: (args: { options: CapturedOptions }) => {
    capturedOptions = args.options;
    return { mutate: vi.fn(), isPending: false };
  },
}));

import { useTerminalRenameFor } from "@/hooks/terminal/use-terminal-rename-for-mutation";

function sessionInfo(
  overrides: Partial<CanonicalTerminalSessionInfo>,
): CanonicalTerminalSessionInfo {
  return {
    sessionId: SESSION_ID,
    scope: { kind: "epic", epicId: EPIC_ID },
    sessionKind: "terminal",
    cwd: "/work/repo",
    shellCommand: "/bin/zsh",
    shellArgs: [],
    cols: 80,
    rows: 24,
    status: "running",
    exitCode: null,
    exitReason: null,
    createdAt: 1,
    title: ORIGINAL_TITLE,
    activeProcessName: null,
    ...overrides,
  };
}

function makeWrapper(
  queryClient: QueryClient,
): ({ children }: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

describe("useTerminalRenameFor homeCwd cache preservation", () => {
  beforeEach(() => {
    capturedOptions = {};
    vi.clearAllMocks();
  });

  it("keeps homeCwd when optimistically patching a session title", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const sibling = sessionInfo({
      sessionId: "term-other",
      title: "other",
    });
    queryClient.setQueryData<ListTerminalsResponseV21>(listKey, {
      sessions: [sessionInfo({}), sibling],
      homeCwd: HOME_CWD,
    });

    renderHook(() => useTerminalRenameFor(createBoundHostClient()), {
      wrapper: makeWrapper(queryClient),
    });

    const context = await capturedOptions.onMutate?.({
      sessionId: SESSION_ID,
      title: NEW_TITLE,
    });

    const data = queryClient.getQueryData<ListTerminalsResponseV21>(listKey);
    expect(data?.homeCwd).toBe(HOME_CWD);
    expect(
      data?.sessions.find((session) => session.sessionId === SESSION_ID)?.title,
    ).toBe(NEW_TITLE);
    expect(
      data?.sessions.find((session) => session.sessionId === "term-other"),
    ).toEqual(sibling);
    expect(context?.hostId).toBe(HOST_ID);
    expect(context?.previous).toEqual([
      [
        listKey,
        {
          sessions: [sessionInfo({}), sibling],
          homeCwd: HOME_CWD,
        },
      ],
    ]);
  });

  it("keeps homeCwd when rolling back a failed optimistic rename", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData<ListTerminalsResponseV21>(listKey, {
      sessions: [sessionInfo({})],
      homeCwd: HOME_CWD,
    });

    renderHook(() => useTerminalRenameFor(createBoundHostClient()), {
      wrapper: makeWrapper(queryClient),
    });

    const context = await capturedOptions.onMutate?.({
      sessionId: SESSION_ID,
      title: NEW_TITLE,
    });
    expect(
      queryClient.getQueryData<ListTerminalsResponseV21>(listKey)?.homeCwd,
    ).toBe(HOME_CWD);
    expect(
      queryClient
        .getQueryData<ListTerminalsResponseV21>(listKey)
        ?.sessions.find((session) => session.sessionId === SESSION_ID)?.title,
    ).toBe(NEW_TITLE);

    capturedOptions.onError?.(
      { code: "RPC_ERROR", message: "rename failed", fatalDetails: null },
      { sessionId: SESSION_ID, title: NEW_TITLE },
      context,
    );

    const rolledBack =
      queryClient.getQueryData<ListTerminalsResponseV21>(listKey);
    expect(rolledBack?.homeCwd).toBe(HOME_CWD);
    expect(
      rolledBack?.sessions.find((session) => session.sessionId === SESSION_ID)
        ?.title,
    ).toBe(ORIGINAL_TITLE);
  });
});
