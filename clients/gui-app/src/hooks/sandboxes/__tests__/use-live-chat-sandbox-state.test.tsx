import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatServing } from "@traycer/protocol/host/chat-serving/index";
import type { SandboxListResponse } from "@traycer/protocol/host/sandbox-control";
import type { SandboxListFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { TaskSandboxHost } from "@/hooks/epic/use-task-sandbox-end";
import {
  createFakeSandboxBinding,
  type FakeSandboxBinding,
} from "./sandbox-binding-fixture";
import { sandboxSummaryFixture } from "./sandbox-fixtures";

const sources = vi.hoisted(
  (): {
    binding: FakeSandboxBinding | null;
    serving: ChatServing | null;
    status: StreamConnectionStatus;
    task: TaskSandboxHost;
    unavailableReason: string | null;
  } => ({
    binding: null,
    serving: null,
    status: "open",
    task: { kind: "other" },
    unavailableReason: null,
  }),
);
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => sources.binding,
}));
vi.mock("@/lib/chats/chat-serving-witness", () => ({
  useChatServing: () => sources.serving,
}));
vi.mock("@/hooks/chats/use-chat-stream-sync-state", () => ({
  useChatStreamSyncState: () => ({
    status: sources.status,
    hasContent: true,
    wake: null,
  }),
}));
vi.mock("@/hooks/epic/use-task-sandbox-end", () => ({
  useTaskSandboxHost: () => sources.task,
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));
vi.mock(
  "@/hooks/sandboxes/use-sandbox-configurations",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/sandboxes/use-sandbox-configurations")
    >()),
    useSandboxConfigurations: () => ({
      configurations: [{ kind: "personal" }],
    }),
  }),
);
vi.mock("@/hooks/sandboxes/use-sandbox-control-unavailable-reason", () => ({
  useSandboxControlUnavailableReason: () => sources.unavailableReason,
}));

import { useLiveChatSandboxState } from "@/hooks/sandboxes/use-live-chat-sandbox-state";
import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";
import { resolveChatSandbox } from "@/lib/sandboxes/chat-sandbox-state";
import { sandboxQueryKeys } from "@/lib/query-keys";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEndedSandboxHostsStore } from "@/stores/sandboxes/ended-sandbox-hosts-store";

const HOST = "host-sbx";
const VIEWER = "viewer";
const LIVE: ChatServing = {
  ownerHostId: HOST,
  state: "live",
  catchingUp: null,
};

function listed(
  state: "awake" | "stopped" | "suspending",
): SandboxListResponse {
  return {
    sandboxes: [
      sandboxSummaryFixture({ hostId: HOST, displayName: "test-box", state }),
    ],
  };
}

function deferredAnswer() {
  let answer: (result: SandboxListFetchResult) => void = () => {
    throw new Error("the request has not started");
  };
  const promise = new Promise<SandboxListFetchResult>((resolve) => {
    answer = resolve;
  });
  return {
    promise,
    answer: (response: SandboxListResponse) => answer({ kind: "ok", response }),
  };
}

function setup(response: SandboxListResponse) {
  const binding = createFakeSandboxBinding();
  sources.binding = binding;
  binding.auth.listSandboxes.mockResolvedValue({
    kind: "ok",
    response,
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const rendered = renderHook(
    () => {
      const live = useLiveChatSandboxState("epic", "chat", HOST, true);
      return {
        ...live,
        view: resolveChatSandbox(live.state, {
          reachable: live.reachable,
          canEdit: true,
          ownedByViewer: true,
          environmentOwned: false,
        }),
        // A second list observer must receive the shared lifecycle answer.
        listedState: useSandboxList().data?.sandboxes[0]?.state,
      };
    },
    { wrapper },
  );
  return { ...rendered, binding, queryClient, wrapper };
}

beforeEach(() => {
  sources.serving = LIVE;
  sources.status = "open";
  sources.task = { kind: "other" };
  sources.unavailableReason = null;
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: VIEWER, username: "Viewer" },
  });
  useEndedSandboxHostsStore.setState({ byHostId: {} });
});

afterEach(() => {
  cleanup();
  sources.binding = null;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useEndedSandboxHostsStore.setState({ byHostId: {} });
});

describe("a live chat's sandbox lifecycle reconciliation", () => {
  it.each(["unverified", "control unavailable"] as const)(
    "does not claim a lifecycle read is pending while %s, and resumes when eligible",
    async (reason) => {
      const { result, rerender, binding } = setup(listed("awake"));
      await waitFor(() => expect(result.current.listedState).toBe("awake"));
      if (reason === "unverified") {
        act(() => useAuthStore.setState({ status: "unverified" }));
      } else {
        sources.unavailableReason = "Unavailable in this build";
      }
      sources.status = "reconnecting";
      rerender();

      expect(result.current.state.kind).toBe("unreachable");
      expect(result.current.view.line?.text).toBe(
        "test-box is running, but Traycer can’t connect",
      );
      expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(1);

      const read = deferredAnswer();
      binding.auth.listSandboxes.mockReturnValueOnce(read.promise);
      sources.unavailableReason = null;
      act(() => useAuthStore.setState({ status: "signed-in" }));
      rerender();
      await waitFor(() =>
        expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(2),
      );
      expect(result.current.state.kind).toBe("pending");
      await act(async () => {
        read.answer(listed("awake"));
        await read.promise;
      });
      await waitFor(() =>
        expect(result.current.state.kind).toBe("unreachable"),
      );
    },
  );

  it("finishes the shared lifecycle read when the live tile unmounts during substitution", async () => {
    const live = setup(listed("awake"));
    await waitFor(() => expect(live.result.current.listedState).toBe("awake"));
    const copy = renderHook(() => useSandboxList(), { wrapper: live.wrapper });
    live.binding.auth.listSandboxes.mockResolvedValueOnce({
      kind: "ok",
      response: listed("stopped"),
    });

    sources.serving = { ownerHostId: HOST, state: "at-rest", catchingUp: null };
    live.rerender();
    live.unmount();

    await waitFor(() =>
      expect(copy.result.current.data?.sandboxes[0]?.state).toBe("stopped"),
    );
    expect(live.binding.auth.listSandboxes).toHaveBeenCalledTimes(2);
  });

  it("preserves a task's permanent end when it arrives during an at-rest reconciliation", async () => {
    const { result, rerender, binding } = setup(listed("awake"));
    await waitFor(() => expect(result.current.listedState).toBe("awake"));
    const read = deferredAnswer();
    binding.auth.listSandboxes.mockReturnValueOnce(read.promise);
    sources.serving = { ownerHostId: HOST, state: "at-rest", catchingUp: null };
    rerender();
    await waitFor(() =>
      expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(2),
    );
    expect(result.current.state.kind).toBe("pending");

    const ended = {
      name: "test-box",
      end: {
        state: "destroyed",
        destroyedAt: Date.UTC(2026, 9, 28, 12),
        cause: "verb",
        actor: "you",
        idleMinutes: null,
      },
    } as const;
    sources.task = { kind: "ended", ended };
    rerender();
    expect(result.current.state).toEqual({ kind: "destroyed", ended });
    expect(result.current.view.composer.kind).toBe("line");
    expect(result.current.view.line?.text).toContain("was destroyed");

    await act(async () => {
      read.answer(listed("awake"));
      await read.promise;
    });
    expect(result.current.state).toEqual({ kind: "destroyed", ended });
    expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(2);
  });

  it("replaces a stale awake row on a remote Stop without a poll or remount", async () => {
    const { result, rerender, binding } = setup(listed("awake"));
    await waitFor(() => expect(result.current.listedState).toBe("awake"));
    const read = deferredAnswer();
    binding.auth.listSandboxes.mockReturnValueOnce(read.promise);

    sources.serving = { ownerHostId: HOST, state: "at-rest", catchingUp: null };
    sources.status = "closed";
    rerender();

    expect(result.current.view).toMatchObject({
      composer: { kind: "line" },
      line: { text: "test-box isn't available — this chat stays readable." },
    });
    await waitFor(() =>
      expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(2),
    );
    await act(async () => {
      read.answer(listed("stopped"));
      await read.promise;
    });
    await waitFor(() =>
      expect(result.current.view).toMatchObject({
        composer: { kind: "wake" },
        line: { place: "footer", text: "test-box is stopped" },
      }),
    );
    expect(result.current.listedState).toBe("stopped");
    expect(binding.directory.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not guess a rest or keep reading after a sandbox stream loss", async () => {
    const { result, rerender, binding, queryClient } = setup(listed("awake"));
    await waitFor(() => expect(result.current.listedState).toBe("awake"));
    sources.status = "reconnecting";
    rerender();

    await waitFor(() => expect(result.current.state.kind).toBe("unreachable"));
    expect(result.current.view.line?.text).toBe(
      "test-box is running, but Traycer can’t connect",
    );
    expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(2);
    rerender();
    sources.status = "closed";
    rerender();
    await act(async () => {
      await queryClient.ensureQueryData({
        queryKey: sandboxQueryKeys.list(binding.auth, VIEWER),
      });
    });
    expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(2);

    binding.auth.listSandboxes.mockResolvedValueOnce({
      kind: "ok",
      response: listed("suspending"),
    });
    sources.serving = {
      ownerHostId: HOST,
      state: "catching-up",
      catchingUp: "final-publication",
    };
    rerender();
    await waitFor(() =>
      expect(result.current.view.line?.text).toBe(
        "Suspending test-box · pending",
      ),
    );
    expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(3);

    // Pool transcript reconnects are not another owner lifecycle event.
    sources.status = "open";
    rerender();
    sources.status = "reconnecting";
    rerender();
    expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(3);
  });

  it("does not let an older in-flight awake answer satisfy the handoff read", async () => {
    const { result, rerender, binding, queryClient } = setup(listed("awake"));
    await waitFor(() => expect(result.current.listedState).toBe("awake"));
    const old = deferredAnswer();
    const current = deferredAnswer();
    binding.auth.listSandboxes
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    const oldRead = queryClient.invalidateQueries({
      queryKey: sandboxQueryKeys.list(binding.auth, VIEWER),
      exact: true,
    });
    await waitFor(() =>
      expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(2),
    );

    sources.serving = { ownerHostId: HOST, state: "at-rest", catchingUp: null };
    rerender();
    await waitFor(() =>
      expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(3),
    );
    await act(async () => {
      old.answer(listed("awake"));
      await oldRead;
    });
    expect(result.current.view.composer.kind).toBe("line");
    await act(async () => {
      current.answer(listed("stopped"));
      await current.promise;
    });
    await waitFor(() => expect(result.current.listedState).toBe("stopped"));
  });

  it("does not reconcile an ordinary host when its stream disconnects", async () => {
    const { result, rerender, binding } = setup({ sandboxes: [] });
    await waitFor(() => expect(result.current.state.kind).toBe("none"));
    await waitFor(() =>
      expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(1),
    );
    sources.status = "reconnecting";
    rerender();
    expect(result.current.view.line).toBeNull();
    expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(1);
    expect(binding.directory.refresh).not.toHaveBeenCalled();
  });
  it("re-reads the task's hosts when the row leaves the list, and holds a pending state reachable until they answer", async () => {
    sources.serving = { ownerHostId: HOST, state: "at-rest", catchingUp: null };
    sources.task = { kind: "sandbox", name: "test-box" };
    const binding = createFakeSandboxBinding();
    sources.binding = binding;
    binding.auth.listSandboxes.mockResolvedValue({
      kind: "ok",
      response: listed("stopped"),
    });
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0, staleTime: Infinity },
      },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    // The task's hosts as the chat's own surface keeps them: one active read.
    let taskHostsReads = 0;
    let taskHostsAnswer: Promise<number> = Promise.resolve(0);
    const { result, rerender } = renderHook(
      () => {
        useQuery(
          queryOptions({
            queryKey: hostQueryKeys.methodScope(
              "session-host",
              "epic.listTaskHosts",
            ),
            queryFn: () => {
              taskHostsReads += 1;
              return taskHostsAnswer;
            },
          }),
        );
        return useLiveChatSandboxState("epic", "chat", HOST, true);
      },
      { wrapper },
    );
    await waitFor(() => expect(result.current.state.kind).toBe("resting"));
    await waitFor(() => expect(taskHostsReads).toBeGreaterThanOrEqual(2));
    const readsBeforeLeaving = taskHostsReads;
    expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(2);

    let answerTaskHosts: (value: number) => void = () => {
      throw new Error("the task hosts read has not started");
    };
    taskHostsAnswer = new Promise<number>((resolve) => {
      answerTaskHosts = resolve;
    });
    binding.auth.listSandboxes.mockResolvedValue({
      kind: "ok",
      response: { sandboxes: [] },
    });
    act(() => {
      queryClient.setQueryData(sandboxQueryKeys.list(binding.auth, VIEWER), {
        sandboxes: [],
      });
    });
    rerender();

    await waitFor(() => expect(taskHostsReads).toBe(readsBeforeLeaving + 1));
    // The task names the sandbox, the list no longer does, and its end is in
    // flight: no line before the answer, and not an unreachable host.
    expect(result.current).toMatchObject({
      state: { kind: "pending", name: "test-box" },
      reachable: true,
    });

    const ended = {
      name: "test-box",
      end: {
        state: "destroyed",
        destroyedAt: Date.UTC(2026, 9, 28, 12),
        cause: "resting",
        actor: null,
        idleMinutes: null,
      },
    } as const;
    sources.task = { kind: "ended", ended };
    await act(async () => {
      answerTaskHosts(1);
      await taskHostsAnswer;
    });
    rerender();
    expect(result.current.state).toEqual({ kind: "destroyed", ended });
  });
});
