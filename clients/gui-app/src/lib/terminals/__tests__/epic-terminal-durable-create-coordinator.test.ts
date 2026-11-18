import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
import {
  acceptEpicTerminalDurableCreate,
  discardEpicTerminalDurableCreate,
  listEpicTerminalDurableCreateJobViewsForEpic,
  peekEpicTerminalDurableCreate,
  purgeEpicTerminalDurableCreatesForEpic,
  requestEpicTerminalDurableCreate,
  resetEpicTerminalDurableCreatesForTests,
  retryEpicTerminalDurableCreate,
  settleEpicTerminalDurableCreate,
  shouldPreserveEpicTerminalPendingCreate,
  subscribeEpicTerminalDurableCreates,
} from "@/lib/terminals/epic-terminal-durable-create-coordinator";

const REQUEST = {
  hostId: "host-1",
  terminalId: "term-1",
  epicId: "epic-1",
  cwd: "/repo",
  cols: 80,
  rows: 24,
} as const;

function projection(): PlainTerminalProjection {
  return {
    record: {
      terminalId: REQUEST.terminalId,
      hostId: REQUEST.hostId,
      scope: { kind: "epic", epicId: REQUEST.epicId },
      launch: { cwd: REQUEST.cwd, shellCommand: "/bin/zsh", shellArgs: [] },
      manualTitle: null,
      revision: 1,
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
    },
    runtime: {
      status: "running",
      sessionId: REQUEST.terminalId,
      currentCwd: REQUEST.cwd,
      activeProcessName: "zsh",
      cols: 80,
      rows: 24,
    },
  };
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: Error) => void;
} {
  let resolvePromise: ((value: Value) => void) | undefined;
  let rejectPromise: ((error: Error) => void) | undefined;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
    reject: (error) => rejectPromise?.(error),
  };
}

describe("epic terminal durable create coordinator", () => {
  afterEach(() => {
    resetEpicTerminalDurableCreatesForTests();
  });

  it("does not dispatch before capability and preserves the accepted job", () => {
    const create = vi.fn(() => Promise.resolve());
    const adopt = vi.fn();
    acceptEpicTerminalDurableCreate(REQUEST);

    expect(
      requestEpicTerminalDurableCreate({
        hostId: REQUEST.hostId,
        terminalId: REQUEST.terminalId,
        ready: false,
        create,
        onSuccess: adopt,
        commit: undefined,
        onCommit: undefined,
        onFailure: undefined,
      }),
    ).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(
      shouldPreserveEpicTerminalPendingCreate(
        REQUEST.hostId,
        REQUEST.terminalId,
      ),
    ).toBe(true);
    expect(
      peekEpicTerminalDurableCreate(REQUEST.hostId, REQUEST.terminalId)?.status,
    ).toBe("accepted");
  });

  it("single-flights create across remount and still adopts after the original caller unmounts", async () => {
    const pending = deferred<PlainTerminalProjection>();
    const create = vi.fn(() => pending.promise);
    const firstAdopt = vi.fn();
    const secondAdopt = vi.fn();
    acceptEpicTerminalDurableCreate(REQUEST);

    const first = requestEpicTerminalDurableCreate({
      hostId: REQUEST.hostId,
      terminalId: REQUEST.terminalId,
      ready: true,
      create: async () => {
        await create();
      },
      onSuccess: firstAdopt,
      commit: undefined,
      onCommit: undefined,
      onFailure: undefined,
    });
    const second = requestEpicTerminalDurableCreate({
      hostId: REQUEST.hostId,
      terminalId: REQUEST.terminalId,
      ready: true,
      create: () => Promise.resolve(),
      onSuccess: secondAdopt,
      commit: undefined,
      onCommit: undefined,
      onFailure: undefined,
    });
    expect(second).toBe(first);
    await Promise.resolve();
    expect(create).toHaveBeenCalledTimes(1);

    pending.resolve(projection());
    await first;
    expect(firstAdopt).toHaveBeenCalledTimes(1);
    expect(secondAdopt).not.toHaveBeenCalled();
    expect(
      peekEpicTerminalDurableCreate(REQUEST.hostId, REQUEST.terminalId),
    ).toBeNull();
  });

  it("records an explicit failure without losing retryability", async () => {
    const create = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce();
    const adopt = vi.fn();
    acceptEpicTerminalDurableCreate(REQUEST);

    const first = requestEpicTerminalDurableCreate({
      hostId: REQUEST.hostId,
      terminalId: REQUEST.terminalId,
      ready: true,
      create,
      onSuccess: adopt,
      commit: undefined,
      onCommit: undefined,
      onFailure: undefined,
    });
    await expect(first).rejects.toThrow("offline");
    expect(
      peekEpicTerminalDurableCreate(REQUEST.hostId, REQUEST.terminalId)?.status,
    ).toBe("failed");
    expect(adopt).not.toHaveBeenCalled();

    retryEpicTerminalDurableCreate(REQUEST.hostId, REQUEST.terminalId);
    const retry = requestEpicTerminalDurableCreate({
      hostId: REQUEST.hostId,
      terminalId: REQUEST.terminalId,
      ready: true,
      create,
      onSuccess: adopt,
      commit: undefined,
      onCommit: undefined,
      onFailure: undefined,
    });
    await retry;
    expect(create).toHaveBeenCalledTimes(2);
    expect(adopt).toHaveBeenCalledTimes(1);
  });

  it("discard removes the job so pending-create need not be preserved", async () => {
    const create = vi.fn<() => Promise<void>>(() =>
      Promise.reject(new Error("offline")),
    );
    acceptEpicTerminalDurableCreate(REQUEST);
    await expect(
      requestEpicTerminalDurableCreate({
        hostId: REQUEST.hostId,
        terminalId: REQUEST.terminalId,
        ready: true,
        create,
        onSuccess: () => undefined,
        commit: undefined,
        onCommit: undefined,
        onFailure: undefined,
      }),
    ).rejects.toThrow("offline");

    expect(
      discardEpicTerminalDurableCreate(REQUEST.hostId, REQUEST.terminalId),
    ).toBe(true);
    expect(
      peekEpicTerminalDurableCreate(REQUEST.hostId, REQUEST.terminalId),
    ).toBeNull();
    expect(
      shouldPreserveEpicTerminalPendingCreate(
        REQUEST.hostId,
        REQUEST.terminalId,
      ),
    ).toBe(false);
  });

  it("settles a failed job so Retry cannot resurrect it", async () => {
    const create = vi.fn<() => Promise<void>>(() =>
      Promise.reject(new Error("timed out")),
    );
    acceptEpicTerminalDurableCreate(REQUEST);
    await expect(
      requestEpicTerminalDurableCreate({
        hostId: REQUEST.hostId,
        terminalId: REQUEST.terminalId,
        ready: true,
        create,
        onSuccess: () => undefined,
        commit: undefined,
        onCommit: undefined,
        onFailure: undefined,
      }),
    ).rejects.toThrow("timed out");

    expect(
      settleEpicTerminalDurableCreate(REQUEST.hostId, REQUEST.terminalId),
    ).toBe(true);
    expect(
      peekEpicTerminalDurableCreate(REQUEST.hostId, REQUEST.terminalId),
    ).toBeNull();
    retryEpicTerminalDurableCreate(REQUEST.hostId, REQUEST.terminalId);
    expect(
      requestEpicTerminalDurableCreate({
        hostId: REQUEST.hostId,
        terminalId: REQUEST.terminalId,
        ready: true,
        create,
        onSuccess: () => undefined,
        commit: undefined,
        onCommit: undefined,
        onFailure: undefined,
      }),
    ).toBeNull();
  });

  it("purges accepted and failed jobs for one Epic without touching another", async () => {
    const other = {
      ...REQUEST,
      hostId: "host-2",
      terminalId: "term-2",
      epicId: "epic-2",
    };
    acceptEpicTerminalDurableCreate(REQUEST);
    acceptEpicTerminalDurableCreate(other);
    await expect(
      requestEpicTerminalDurableCreate({
        hostId: REQUEST.hostId,
        terminalId: REQUEST.terminalId,
        ready: true,
        create: () => Promise.reject(new Error("offline")),
        onSuccess: () => undefined,
        commit: undefined,
        onCommit: undefined,
        onFailure: undefined,
      }),
    ).rejects.toThrow("offline");

    const listener = vi.fn();
    const unsubscribe = subscribeEpicTerminalDurableCreates(listener);
    const removed = purgeEpicTerminalDurableCreatesForEpic(REQUEST.epicId);
    unsubscribe();

    expect(removed).toEqual([REQUEST]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(
      peekEpicTerminalDurableCreate(REQUEST.hostId, REQUEST.terminalId),
    ).toBeNull();
    expect(
      peekEpicTerminalDurableCreate(other.hostId, other.terminalId),
    ).toEqual({
      request: other,
      status: "accepted",
      error: null,
    });
    expect(
      listEpicTerminalDurableCreateJobViewsForEpic(REQUEST.epicId),
    ).toEqual([]);
  });

  it("does not dispatch stale work after an Epic identity is reused", () => {
    acceptEpicTerminalDurableCreate(REQUEST);
    purgeEpicTerminalDurableCreatesForEpic(REQUEST.epicId);
    expect(
      requestEpicTerminalDurableCreate({
        hostId: REQUEST.hostId,
        terminalId: REQUEST.terminalId,
        ready: true,
        create: () => Promise.resolve(),
        onSuccess: () => undefined,
        commit: undefined,
        onCommit: undefined,
        onFailure: undefined,
      }),
    ).toBeNull();
    acceptEpicTerminalDurableCreate(REQUEST);
    expect(
      peekEpicTerminalDurableCreate(REQUEST.hostId, REQUEST.terminalId)?.status,
    ).toBe("accepted");
  });

  it("ignores stale success after purge and same-identity reaccept", async () => {
    const pending = deferred<PlainTerminalProjection>();
    const staleSuccess = vi.fn();
    const staleFailure = vi.fn();
    const freshSuccess = vi.fn();
    acceptEpicTerminalDurableCreate(REQUEST);
    const first = requestEpicTerminalDurableCreate({
      hostId: REQUEST.hostId,
      terminalId: REQUEST.terminalId,
      ready: true,
      create: () => pending.promise.then(() => undefined),
      onSuccess: staleSuccess,
      commit: undefined,
      onCommit: undefined,
      onFailure: staleFailure,
    });
    expect(first).not.toBeNull();

    purgeEpicTerminalDurableCreatesForEpic(REQUEST.epicId);
    acceptEpicTerminalDurableCreate(REQUEST);
    pending.resolve(projection());
    await first;

    expect(staleSuccess).not.toHaveBeenCalled();
    expect(staleFailure).not.toHaveBeenCalled();
    expect(
      peekEpicTerminalDurableCreate(REQUEST.hostId, REQUEST.terminalId)?.status,
    ).toBe("accepted");
    expect(
      requestEpicTerminalDurableCreate({
        hostId: REQUEST.hostId,
        terminalId: REQUEST.terminalId,
        ready: false,
        create: () => Promise.resolve(),
        onSuccess: freshSuccess,
        commit: undefined,
        onCommit: undefined,
        onFailure: undefined,
      }),
    ).toBeNull();
    expect(freshSuccess).not.toHaveBeenCalled();
  });

  it("ignores stale failure after purge and same-identity reaccept", async () => {
    const pending = deferred<PlainTerminalProjection>();
    const staleSuccess = vi.fn();
    const staleFailure = vi.fn();
    acceptEpicTerminalDurableCreate(REQUEST);
    const first = requestEpicTerminalDurableCreate({
      hostId: REQUEST.hostId,
      terminalId: REQUEST.terminalId,
      ready: true,
      create: () => pending.promise.then(() => undefined),
      onSuccess: staleSuccess,
      commit: undefined,
      onCommit: undefined,
      onFailure: staleFailure,
    });
    expect(first).not.toBeNull();

    purgeEpicTerminalDurableCreatesForEpic(REQUEST.epicId);
    acceptEpicTerminalDurableCreate(REQUEST);
    pending.reject(new Error("lost after teardown"));
    await first;

    expect(staleSuccess).not.toHaveBeenCalled();
    expect(staleFailure).not.toHaveBeenCalled();
    expect(
      peekEpicTerminalDurableCreate(REQUEST.hostId, REQUEST.terminalId),
    ).toEqual({
      request: REQUEST,
      status: "accepted",
      error: null,
    });
  });

  it("skips commit on ordinary create success", async () => {
    const commit = vi.fn(() =>
      Promise.resolve({
        sessions: [{ sessionId: REQUEST.terminalId }],
      }),
    );
    const onCommit = vi.fn();
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    acceptEpicTerminalDurableCreate(REQUEST);
    await requestEpicTerminalDurableCreate({
      hostId: REQUEST.hostId,
      terminalId: REQUEST.terminalId,
      ready: true,
      create: () => Promise.resolve(),
      commit,
      onCommit,
      onSuccess,
      onFailure,
    });
    expect(commit).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("runs commit only after generation validation and treats discovery as success", async () => {
    const snapshot = { sessions: [{ sessionId: REQUEST.terminalId }] };
    const commit = vi.fn(() => Promise.resolve(snapshot));
    const onCommit = vi.fn();
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    acceptEpicTerminalDurableCreate(REQUEST);
    await expect(
      requestEpicTerminalDurableCreate({
        hostId: REQUEST.hostId,
        terminalId: REQUEST.terminalId,
        ready: true,
        create: () => Promise.reject(new Error("lost response")),
        commit,
        onCommit,
        onSuccess,
        onFailure,
      }),
    ).resolves.toBeUndefined();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(snapshot);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
    expect(
      peekEpicTerminalDurableCreate(REQUEST.hostId, REQUEST.terminalId),
    ).toBeNull();
  });

  it("fails without consulting commit when isolated list throws", async () => {
    const onCommit = vi.fn();
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    acceptEpicTerminalDurableCreate(REQUEST);
    await expect(
      requestEpicTerminalDurableCreate({
        hostId: REQUEST.hostId,
        terminalId: REQUEST.terminalId,
        ready: true,
        create: () => Promise.reject(new Error("lost response")),
        commit: () => Promise.reject(new Error("list failed")),
        onCommit,
        onSuccess,
        onFailure,
      }),
    ).rejects.toThrow("lost response");
    expect(onCommit).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(
      peekEpicTerminalDurableCreate(REQUEST.hostId, REQUEST.terminalId)?.status,
    ).toBe("failed");
  });

  it("does not run commit or side effects for a purged attempt", async () => {
    const pending = deferred<void>();
    const commit = vi.fn(() =>
      Promise.resolve({
        sessions: [{ sessionId: REQUEST.terminalId }],
      }),
    );
    const onCommit = vi.fn();
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    acceptEpicTerminalDurableCreate(REQUEST);
    const first = requestEpicTerminalDurableCreate({
      hostId: REQUEST.hostId,
      terminalId: REQUEST.terminalId,
      ready: true,
      create: () => pending.promise,
      commit,
      onCommit,
      onSuccess,
      onFailure,
    });
    purgeEpicTerminalDurableCreatesForEpic(REQUEST.epicId);
    acceptEpicTerminalDurableCreate(REQUEST);
    pending.reject(new Error("lost after teardown"));
    await first;
    expect(commit).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
    expect(
      peekEpicTerminalDurableCreate(REQUEST.hostId, REQUEST.terminalId)?.status,
    ).toBe("accepted");
  });

  it("ignores commit completion after purge mid-refresh", async () => {
    const commitPending = deferred<{
      readonly sessions: ReadonlyArray<{ readonly sessionId: string }>;
    }>();
    const onCommit = vi.fn();
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    acceptEpicTerminalDurableCreate(REQUEST);
    const first = requestEpicTerminalDurableCreate({
      hostId: REQUEST.hostId,
      terminalId: REQUEST.terminalId,
      ready: true,
      create: () => Promise.reject(new Error("lost response")),
      commit: () => commitPending.promise,
      onCommit,
      onSuccess,
      onFailure,
    });
    await Promise.resolve();
    await Promise.resolve();
    purgeEpicTerminalDurableCreatesForEpic(REQUEST.epicId);
    acceptEpicTerminalDurableCreate(REQUEST);
    commitPending.resolve({
      sessions: [{ sessionId: REQUEST.terminalId }],
    });
    await first;
    expect(onCommit).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
    expect(
      peekEpicTerminalDurableCreate(REQUEST.hostId, REQUEST.terminalId)?.status,
    ).toBe("accepted");
  });
});
