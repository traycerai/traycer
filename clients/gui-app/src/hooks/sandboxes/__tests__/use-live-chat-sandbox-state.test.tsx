import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { ChatServing } from "@traycer/protocol/host/chat-serving/index";
import type { SandboxListResponse } from "@traycer/protocol/host/sandbox-control";
import type { SandboxListFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { TaskSandboxHost } from "@/hooks/epic/use-task-sandbox-end";
import {
  createFakeSandboxBinding,
  type FakeSandboxBinding,
} from "./sandbox-binding-fixture";
import {
  sandboxOperationFixture,
  sandboxSummaryFixture,
} from "./sandbox-fixtures";

const sources = vi.hoisted(
  (): {
    binding: FakeSandboxBinding | null;
    serving: ChatServing | null;
    status: StreamConnectionStatus;
    /** Whether the chat's stream has delivered content. */
    hasContent: boolean;
    /** A chat the host refused to open, if any. */
    fatalClose: FatalErrorDetails | null;
    /** Whether the relay holds a ready session to the host. */
    readySession: boolean;
    task: TaskSandboxHost;
    unavailableReason: string | null;
  } => ({
    binding: null,
    serving: null,
    status: "open",
    hasContent: true,
    fatalClose: null,
    readySession: true,
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
    hasContent: sources.hasContent,
    wake: null,
  }),
}));
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useExistingChatSessionFatalClose: () => sources.fatalClose,
}));
vi.mock("@/hooks/agent/use-host-reachability", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/agent/use-host-reachability")
  >()),
  useRemoteSessionPollReadiness: () => sources.readySession,
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
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { ListTaskHostsResponse } from "@traycer/protocol/host/task-host-summary";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { EpicSessionHostClientContext } from "@/lib/registries/epic-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSandboxWakeReportStore } from "@/stores/sandboxes/sandbox-wake-report-store";
import { useEndedSandboxHostsStore } from "@/stores/sandboxes/ended-sandbox-hosts-store";

const HOST = "host-sbx";
const VIEWER = "viewer";
const LIVE: ChatServing = {
  ownerHostId: HOST,
  state: "live",
  catchingUp: null,
};

/** A row whose host has reported since its wake, unless `reported` is false. */
function listed(
  state: "awake" | "stopped" | "suspending" | "resuming",
  reported: boolean,
): SandboxListResponse {
  return {
    sandboxes: [
      sandboxSummaryFixture({
        hostId: HOST,
        displayName: "test-box",
        state,
        lastActivityAt: reported ? 1_791_000_020_000 : null,
      }),
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
  sources.hasContent = true;
  sources.fatalClose = null;
  sources.readySession = false;
  useSandboxWakeReportStore.setState({ answeredWakes: {} });
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
      const { result, rerender, binding } = setup(listed("awake", true));
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
        read.answer(listed("awake", true));
        await read.promise;
      });
      await waitFor(() =>
        expect(result.current.state.kind).toBe("unreachable"),
      );
    },
  );

  it("finishes the shared lifecycle read when the live tile unmounts during substitution", async () => {
    const live = setup(listed("awake", true));
    await waitFor(() => expect(live.result.current.listedState).toBe("awake"));
    const copy = renderHook(() => useSandboxList(), { wrapper: live.wrapper });
    live.binding.auth.listSandboxes.mockResolvedValueOnce({
      kind: "ok",
      response: listed("stopped", true),
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
    const { result, rerender, binding } = setup(listed("awake", true));
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
      read.answer(listed("awake", true));
      await read.promise;
    });
    expect(result.current.state).toEqual({ kind: "destroyed", ended });
    expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(2);
  });

  it("replaces a stale awake row on a remote Stop without a poll or remount", async () => {
    const { result, rerender, binding } = setup(listed("awake", true));
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
      read.answer(listed("stopped", true));
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
    const { result, rerender, binding, queryClient } = setup(
      listed("awake", true),
    );
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
      response: listed("suspending", true),
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
    const { result, rerender, binding, queryClient } = setup(
      listed("awake", true),
    );
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
      old.answer(listed("awake", true));
      await oldRead;
    });
    expect(result.current.view.composer.kind).toBe("line");
    await act(async () => {
      current.answer(listed("stopped", true));
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
      response: listed("stopped", true),
    });
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0, staleTime: Infinity },
      },
    });
    // The task's hosts through the Epic session's host client, as the chat's
    // own surface reads them: a real request whose answer the test holds.
    let taskHostsReads = 0;
    let taskHostsAnswer: Promise<ListTaskHostsResponse> = Promise.resolve({
      hosts: [],
    });
    const sessionClient = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => "req-task-hosts",
        handlers: {
          "epic.listTaskHosts": () => {
            taskHostsReads += 1;
            return taskHostsAnswer;
          },
        },
      }),
    });
    sessionClient.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
    );
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <EpicSessionHostClientContext
          value={sessionClient.createRequester(mockLocalHostEntry)}
        >
          {children}
        </EpicSessionHostClientContext>
      </QueryClientProvider>
    );
    // The chat's own read of the task's hosts is mounted by the end-read hook.
    const { result, rerender } = renderHook(
      () => useLiveChatSandboxState("epic", "chat", HOST, true),
      { wrapper },
    );
    await waitFor(() => expect(result.current.state.kind).toBe("resting"));
    // The observer's own first read is the only one: nothing re-reads the
    // task's hosts until the state turns pending.
    await waitFor(() => expect(taskHostsReads).toBe(1));
    await waitFor(() =>
      expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(2),
    );
    const readsBeforeLeaving = taskHostsReads;

    let answerTaskHosts: (value: ListTaskHostsResponse) => void = () => {
      throw new Error("the task hosts read has not started");
    };
    taskHostsAnswer = new Promise<ListTaskHostsResponse>((resolve) => {
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
      answerTaskHosts({ hosts: [] });
      await taskHostsAnswer;
    });
    rerender();
    expect(result.current.state).toEqual({ kind: "destroyed", ended });
  });
});

describe("a live tile's wait for a sandbox it watched wake", () => {
  const FATAL: FatalErrorDetails = {
    code: "chat-refused",
    reason: "The host refused this chat.",
    incompatibleMethods: null,
    upgradeGuidance: null,
  };

  /** A tile that saw the row resume, then turn awake with the host ready. */
  async function watchWake() {
    sources.hasContent = false;
    sources.readySession = false;
    const live = setup(listed("resuming", false));
    await waitFor(() =>
      expect(live.result.current.listedState).toBe("resuming"),
    );
    expect(live.result.current.state).toMatchObject({
      kind: "moving",
      state: "resuming",
    });
    await act(() => {
      live.queryClient.setQueryData(
        sandboxQueryKeys.list(live.binding.auth, VIEWER),
        listed("awake", false),
      );
      return Promise.resolve();
    });
    sources.readySession = true;
    live.rerender();
    await waitFor(() => expect(live.result.current.listedState).toBe("awake"));
    return live;
  }

  it("holds the moving line after the session is ready until the stream opens with content", async () => {
    const live = await watchWake();
    expect(live.result.current.state).toMatchObject({
      kind: "moving",
      state: "resuming",
    });
    expect(live.result.current.reachable).toBe(false);
    expect(live.result.current.view.line?.text).toBe(
      "Resuming test-box · pending",
    );

    sources.hasContent = true;
    live.rerender();

    expect(live.result.current.state.kind).toBe("none");
    expect(live.result.current.view.line).toBeNull();
  });

  it("ends the hold when the host refuses the chat, so the chat's own line shows", async () => {
    const live = await watchWake();
    expect(live.result.current.state.kind).toBe("moving");

    sources.fatalClose = FATAL;
    live.rerender();

    expect(live.result.current.state.kind).toBe("none");
  });

  it("never shows the hold for a tile opened on an awake, healthy host", async () => {
    sources.hasContent = false;
    sources.readySession = true;
    const live = setup(listed("awake", false));
    await waitFor(() => expect(live.result.current.listedState).toBe("awake"));

    expect(live.result.current.state.kind).toBe("none");
    expect(live.result.current.view.line).toBeNull();
  });
});

describe("a live tile's wait against a fatal chat close", () => {
  it("yields an unanswered awake wait to a fatal chat close after the session disappears", async () => {
    sources.hasContent = false;
    sources.readySession = false;
    const live = setup(listed("resuming", false));
    await waitFor(() =>
      expect(live.result.current.listedState).toBe("resuming"),
    );
    // The session and the refusal arrive while the list still says resuming.
    sources.readySession = true;
    live.rerender();
    sources.readySession = false;
    sources.fatalClose = {
      code: "chat-refused",
      reason: "The host refused this chat.",
      incompatibleMethods: null,
      upgradeGuidance: null,
    };
    sources.status = "closed";
    await act(() => {
      live.queryClient.setQueryData(
        sandboxQueryKeys.list(live.binding.auth, VIEWER),
        listed("awake", false),
      );
      return Promise.resolve();
    });
    live.rerender();
    await waitFor(() => expect(live.result.current.listedState).toBe("awake"));

    expect(live.result.current.state.kind).not.toBe("moving");
  });
});

describe("a live tile that mounts on an awake sandbox", () => {
  const WAKE = 1_791_000_010_000;
  const FATAL: FatalErrorDetails = {
    code: "chat-refused",
    reason: "The host refused this chat.",
    incompatibleMethods: null,
    upgradeGuidance: null,
  };

  /** An awake row of a Resume, `reported` once its host posted activity. */
  function awakeAfterResume(reported: boolean): SandboxListResponse {
    return {
      sandboxes: [
        sandboxSummaryFixture({
          hostId: HOST,
          displayName: "test-box",
          state: "awake",
          lastTransitionAt: WAKE,
          lastActivityAt: reported ? WAKE + 1 : null,
          operation: sandboxOperationFixture({
            at: WAKE,
            fromState: "suspended",
            state: "awake",
            cause: "wake",
          }),
        }),
      ],
    };
  }

  beforeEach(() => {
    useSandboxWakeReportStore.setState({ answeredWakes: {}, setupStops: {} });
    sources.hasContent = false;
    sources.readySession = false;
  });

  it("keeps an unreported wake pending when the list skipped resuming", async () => {
    const live = setup(awakeAfterResume(false));
    await waitFor(() => expect(live.result.current.listedState).toBe("awake"));

    expect(live.result.current.view.line?.text).toBe(
      "Resuming test-box · pending",
    );
  });

  it("never holds when the host already reported after the wake", async () => {
    const live = setup(awakeAfterResume(true));
    await waitFor(() => expect(live.result.current.listedState).toBe("awake"));

    expect(live.result.current.state.kind).toBe("none");
    expect(live.result.current.view.line).toBeNull();
  });

  it("never holds when this device saw the host answer in this wake", async () => {
    sources.readySession = true;
    const live = setup(awakeAfterResume(false));
    await waitFor(() => expect(live.result.current.listedState).toBe("awake"));
    sources.readySession = false;
    live.rerender();

    expect(live.result.current.state.kind).toBe("none");
  });

  it("ends the seeded wait when the host refuses the chat", async () => {
    const live = setup(awakeAfterResume(false));
    await waitFor(() => expect(live.result.current.listedState).toBe("awake"));
    expect(live.result.current.state.kind).toBe("moving");

    sources.fatalClose = FATAL;
    live.rerender();

    expect(live.result.current.state.kind).not.toBe("moving");
  });

  it("holds the seeded wait through the session becoming ready until the stream opens with content", async () => {
    const live = setup(awakeAfterResume(false));
    await waitFor(() => expect(live.result.current.listedState).toBe("awake"));
    expect(live.result.current.view.line?.text).toBe(
      "Resuming test-box · pending",
    );

    sources.readySession = true;
    live.rerender();
    expect(live.result.current.view.line?.text).toBe(
      "Resuming test-box · pending",
    );

    sources.hasContent = true;
    live.rerender();
    expect(live.result.current.state.kind).toBe("none");
  });

  it("does not read a task that ended as moving while its row still lists awake", async () => {
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
    const live = setup(awakeAfterResume(false));
    await waitFor(() => expect(live.result.current.listedState).toBe("awake"));

    expect(live.result.current.state).toEqual({ kind: "destroyed", ended });
  });
});
