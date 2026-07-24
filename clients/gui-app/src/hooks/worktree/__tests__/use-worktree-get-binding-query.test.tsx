import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  focusManager,
  QueryClientProvider,
  type Query,
  type QueryClient,
} from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { WORKTREE_SETUP_IN_FLIGHT_POLL_LANE } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createAppQueryClient } from "@/lib/query-client";
import { getConditionPollEpisodeCoordinator } from "@/lib/query/condition-poll-episode-coordinator";
import { useWorktreeGetBinding } from "@/hooks/worktree/use-worktree-get-binding-query";

const guiAppSrc = path.resolve(import.meta.dirname, "../../..");

type SetupState = "pending" | "running" | "succeeded";

function bindingResponse(setupState: SetupState) {
  return {
    binding: {
      entries: [
        {
          workspacePath: "/repo",
          mode: "worktree" as const,
          repoIdentifier: null,
          worktreePath: "/repo/.worktrees/a",
          branch: "feature",
          isPrimary: true,
          isImported: false,
          setupState,
          setupTerminalSessionId: null,
          setupExitCode: null,
          setupFailedAt: null,
          createdAt: 1,
          ownedSubmodules: [],
        },
      ],
    },
    missingWorktreePaths: [],
  };
}

function createBindingFixture(args: {
  readonly setupState: SetupState;
  readonly fail: boolean;
}) {
  const queryClient = createAppQueryClient();
  let setupState = args.setupState;
  let fail = args.fail;
  let requestSeq = 0;
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => {
        requestSeq += 1;
        return `req-${String(requestSeq)}`;
      },
      handlers: {
        "worktree.getBinding": () => {
          if (fail) throw new Error("binding unavailable");
          return bindingResponse(setupState);
        },
      },
    }),
  });
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-1",
    }),
  );
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return {
    client,
    queryClient,
    Wrapper,
    setSetupState: (next: SetupState) => {
      setupState = next;
    },
    setFail: (next: boolean) => {
      fail = next;
    },
  };
}

function bindingQuery(queryClient: QueryClient): Query {
  const query = queryClient
    .getQueryCache()
    .getAll()
    .find((entry) => entry.queryKey.includes("worktree.getBinding"));
  if (query === undefined) {
    throw new Error("Expected worktree.getBinding query");
  }
  return query;
}

function appliedDelay(query: Query): number | false | undefined {
  const interval = refetchIntervalFor(query);
  if (!isRefetchInterval(interval)) {
    return typeof interval === "number" || interval === false
      ? interval
      : undefined;
  }
  return interval(query);
}

function refetchIntervalFor(query: Query): unknown {
  const { options } = query;
  return "refetchInterval" in options ? options.refetchInterval : undefined;
}

function isRefetchInterval(
  value: unknown,
): value is (query: Query) => number | false | undefined {
  return typeof value === "function";
}

describe("useWorktreeGetBinding condition cadence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
  });

  afterEach(() => {
    focusManager.setFocused(undefined);
    cleanup();
    vi.useRealTimers();
  });

  it("poll:true brands the interval, stamps the method, and forces retry:false", async () => {
    const fixture = createBindingFixture({
      setupState: "pending",
      fail: false,
    });

    renderHook(
      () =>
        useWorktreeGetBinding({
          client: fixture.client,
          epicId: "epic-1",
          ownerId: "owner-1",
          ownerKind: "chat",
          enabled: true,
          staleTime: 0,
          refetchOnWindowFocus: false,
          poll: true,
        }),
      { wrapper: fixture.Wrapper },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const query = bindingQuery(fixture.queryClient);
    const branded = getConditionPollEpisodeCoordinator(
      fixture.queryClient,
    ).refetchIntervalFor("worktree.getBinding");

    expect(query.options.meta).toMatchObject({
      hostRpcMethod: "worktree.getBinding",
    });
    expect(query.options.retry).toBe(false);
    expect(refetchIntervalFor(query)).toBe(branded);
    expect(appliedDelay(query)).toBe(
      WORKTREE_SETUP_IN_FLIGHT_POLL_LANE.initialDelayMs,
    );
  });

  it("poll:false never installs branded cadence", async () => {
    const fixture = createBindingFixture({
      setupState: "pending",
      fail: false,
    });

    renderHook(
      () =>
        useWorktreeGetBinding({
          client: fixture.client,
          epicId: "epic-1",
          ownerId: "owner-1",
          ownerKind: "chat",
          enabled: true,
          staleTime: 0,
          refetchOnWindowFocus: false,
          poll: false,
        }),
      { wrapper: fixture.Wrapper },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const query = bindingQuery(fixture.queryClient);
    expect(query.options.meta).toMatchObject({
      hostRpcMethod: "worktree.getBinding",
    });
    expect(query.options.retry).toBe(false);
    expect(refetchIntervalFor(query)).toBe(false);
  });

  it("applies the setup-in-flight schedule on the real timer while poll:true", async () => {
    vi.setSystemTime(0);
    const fetchTimes: number[] = [];
    const fixture = createBindingFixture({
      setupState: "running",
      fail: false,
    });
    const originalRequest = fixture.client.requestWithSignal.bind(
      fixture.client,
    );
    vi.spyOn(fixture.client, "requestWithSignal").mockImplementation(
      async (method, params, signal) => {
        if (method === "worktree.getBinding") {
          fetchTimes.push(Date.now());
        }
        return originalRequest(method, params, signal);
      },
    );

    renderHook(
      () =>
        useWorktreeGetBinding({
          client: fixture.client,
          epicId: "epic-1",
          ownerId: "owner-1",
          ownerKind: "chat",
          enabled: true,
          staleTime: 0,
          refetchOnWindowFocus: false,
          poll: true,
        }),
      { wrapper: fixture.Wrapper },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    const deltas = fetchTimes
      .slice(1)
      .map((time, index) => time - fetchTimes[index]);
    expect(deltas).toEqual([2_000, 4_000, 5_000]);
  });

  it("uses the setup-in-flight lane for cold error recovery", async () => {
    const fixture = createBindingFixture({
      setupState: "succeeded",
      fail: true,
    });

    renderHook(
      () =>
        useWorktreeGetBinding({
          client: fixture.client,
          epicId: "epic-1",
          ownerId: "owner-1",
          ownerKind: "chat",
          enabled: true,
          staleTime: 0,
          refetchOnWindowFocus: false,
          poll: true,
        }),
      { wrapper: fixture.Wrapper },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(appliedDelay(bindingQuery(fixture.queryClient))).toBe(
      WORKTREE_SETUP_IN_FLIGHT_POLL_LANE.initialDelayMs,
    );
  });
});

describe("worktree binding observer inventory", () => {
  it("requires every direct observer and wrapper consumer to declare its polling role", () => {
    const sourcePaths = sourceFiles(guiAppSrc);
    const directObservers = sourcePaths.filter((relativePath) =>
      /method:\s*"worktree\.getBinding"/.test(
        readFileSync(path.join(guiAppSrc, relativePath), "utf8"),
      ),
    );
    expect(directObservers).toEqual([
      "components/epic-canvas/renderers/chat-tile.tsx",
      "hooks/worktree/use-worktree-get-binding-query.ts",
    ]);

    const chatSource = readFileSync(
      path.join(guiAppSrc, "components/epic-canvas/renderers/chat-tile.tsx"),
      "utf8",
    );
    expect(chatSource).toMatch(
      /method:\s*"worktree\.getBinding"[\s\S]*?poll:\s*false/,
    );
    const builderSource = readFileSync(
      path.join(guiAppSrc, "hooks/worktree/use-worktree-get-binding-query.ts"),
      "utf8",
    );
    expect(builderSource).toMatch(
      /method:\s*"worktree\.getBinding"[\s\S]*?poll:\s*args\.poll/,
    );

    const wrapperCallInventory = new Map([
      [
        "components/epic-canvas/renderers/tui-agent-tile.tsx",
        { calls: 2, polls: [false, true] },
      ],
      [
        "hooks/worktree/use-latest-conversation-workspace-seed.ts",
        { calls: 1, polls: [false] },
      ],
      [
        "hooks/worktree/use-owner-workspace-inheritance-seed.ts",
        { calls: 1, polls: [false] },
      ],
      [
        "hooks/worktree/use-worktree-owner-metadata-query.ts",
        { calls: 1, polls: [false] },
      ],
    ]);
    const wrapperCallers = sourcePaths.filter((relativePath) =>
      /useWorktreeGetBinding\(\{/.test(
        readFileSync(path.join(guiAppSrc, relativePath), "utf8"),
      ),
    );
    expect(wrapperCallers).toEqual([...wrapperCallInventory.keys()]);

    for (const [relativePath, expected] of wrapperCallInventory) {
      const source = readFileSync(path.join(guiAppSrc, relativePath), "utf8");
      expect(source.match(/useWorktreeGetBinding\(\{/g)).toHaveLength(
        expected.calls,
      );
      expect(source.match(/poll:\s*false/g) ?? []).toHaveLength(
        expected.polls.filter((poll) => !poll).length,
      );
      expect(source.match(/poll:\s*true/g) ?? []).toHaveLength(
        expected.polls.filter((poll) => poll).length,
      );
    }
  });
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : sourceFiles(absolutePath);
    }
    if (!/\.tsx?$/.test(entry.name)) return [];
    return [path.relative(guiAppSrc, absolutePath)];
  });
}
