import { describe, expect, it } from "vitest";
import type {
  ControlEvent,
  RuntimeEnvironment,
} from "@traycer-clients/shared/replica-runtime";
import type { EarlyMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import {
  createWorkspaceContextRefreshPolicy,
  type WorkspaceContextRefreshCause,
  type WorkspaceContextRefreshSources,
} from "../workspace-context-refresh";

/**
 * `epic.getWorkspaceContext@1.0` fetch-and-refetch policy - the coalescing
 * contract, the transport/control-event/authority-epoch triggers, and
 * dispose semantics.
 *
 * A deferred promise (not fake timers) is used throughout to control exactly
 * when a fetch resolves, since the coalescing guarantee is about ORDER of
 * triggers relative to a fetch's resolution, not about elapsed time.
 */

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function contextFixture(): EarlyMetaEpic {
  return {
    epicLight: null,
    permissionRole: null,
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
  };
}

function createFakeRuntimeEnvironment(): RuntimeEnvironment {
  return {
    clock: { now: () => 0 },
    scheduler: {
      schedule: () => ({ cancel: () => {} }),
      scheduleMicrotask: () => {},
    },
    logger: {
      debug: () => {},
      warn: () => {},
      error: () => {},
    },
  };
}

interface FetchCall {
  readonly epicId: string;
  readonly deferred: Deferred<EarlyMetaEpic>;
}

function createFakeFetch(): {
  readonly fetch: (epicId: string) => Promise<EarlyMetaEpic>;
  readonly calls: () => readonly FetchCall[];
  readonly latest: () => FetchCall;
} {
  const calls: FetchCall[] = [];
  const fetch = (epicId: string): Promise<EarlyMetaEpic> => {
    const deferred = createDeferred<EarlyMetaEpic>();
    calls.push({ epicId, deferred });
    return deferred.promise;
  };
  return {
    fetch,
    calls: () => calls,
    latest: () => {
      const call = calls.at(-1);
      if (call === undefined) throw new Error("fetch not invoked");
      return call;
    },
  };
}

type ContextLogEntry = {
  readonly context: EarlyMetaEpic;
  readonly cause: WorkspaceContextRefreshCause;
};
type ErrorLogEntry = {
  readonly error: unknown;
  readonly cause: WorkspaceContextRefreshCause;
};

function createSources(
  fetch: (epicId: string) => Promise<EarlyMetaEpic>,
  isDisposed: (() => boolean) | undefined,
): {
  readonly sources: WorkspaceContextRefreshSources;
  readonly onContextCalls: readonly ContextLogEntry[];
  readonly onErrorCalls: readonly ErrorLogEntry[];
} {
  const onContextCalls: ContextLogEntry[] = [];
  const onErrorCalls: ErrorLogEntry[] = [];
  const sources: WorkspaceContextRefreshSources = {
    epicId: "epic-1",
    environment: createFakeRuntimeEnvironment(),
    fetch,
    onContext: (context, cause) => onContextCalls.push({ context, cause }),
    onError: (error, cause) => onErrorCalls.push({ error, cause }),
    isDisposed: isDisposed ?? (() => false),
  };
  return { sources, onContextCalls, onErrorCalls };
}

// Flush the microtask queue so a resolved/rejected promise's `.then`/`.catch`
// handlers run before an assertion reads the callback logs.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ─── start() ────────────────────────────────────────────────────────────────

describe("createWorkspaceContextRefreshPolicy - start()", () => {
  it("fetches exactly once; a second start() does not", () => {
    const { fetch, calls } = createFakeFetch();
    const { sources } = createSources(fetch, undefined);
    const policy = createWorkspaceContextRefreshPolicy(sources);

    policy.start();
    policy.start();

    expect(calls()).toHaveLength(1);
    expect(calls()[0]?.epicId).toBe("epic-1");
  });
});

// ─── noteTransportStatus ────────────────────────────────────────────────────

describe("createWorkspaceContextRefreshPolicy - noteTransportStatus", () => {
  it("'open' with no prior non-open status does NOT refetch (start() already covered it)", () => {
    const { fetch, calls } = createFakeFetch();
    const { sources } = createSources(fetch, undefined);
    const policy = createWorkspaceContextRefreshPolicy(sources);

    policy.start();
    policy.noteTransportStatus("open");

    expect(calls()).toHaveLength(1);
  });

  it("a drop to reconnecting/closed then a return to open refetches exactly once with cause 'reconnect'", async () => {
    const { fetch, calls } = createFakeFetch();
    const { sources } = createSources(fetch, undefined);
    const policy = createWorkspaceContextRefreshPolicy(sources);

    policy.start();
    calls()[0]?.deferred.resolve(contextFixture());
    await flush();

    policy.noteTransportStatus("reconnecting");
    policy.noteTransportStatus("closed");
    policy.noteTransportStatus("open");

    expect(calls()).toHaveLength(2);
    expect(calls()[1]?.epicId).toBe("epic-1");
  });
});

// ─── noteControlEvent ───────────────────────────────────────────────────────

describe("createWorkspaceContextRefreshPolicy - noteControlEvent", () => {
  it("refetches for permission-changed", async () => {
    const { fetch, calls } = createFakeFetch();
    const { sources } = createSources(fetch, undefined);
    const policy = createWorkspaceContextRefreshPolicy(sources);

    policy.start();
    calls()[0]?.deferred.resolve(contextFixture());
    await flush();

    const event: ControlEvent = {
      kind: "permission-changed",
      role: "editor",
      canWrite: true,
      securityEpoch: 1,
    };
    policy.noteControlEvent(event);

    expect(calls()).toHaveLength(2);
  });

  it("refetches for migration", async () => {
    const { fetch, calls } = createFakeFetch();
    const { sources } = createSources(fetch, undefined);
    const policy = createWorkspaceContextRefreshPolicy(sources);

    policy.start();
    calls()[0]?.deferred.resolve(contextFixture());
    await flush();

    const event: ControlEvent = {
      kind: "migration",
      migration: { status: "started" },
    };
    policy.noteControlEvent(event);

    expect(calls()).toHaveLength(2);
  });

  it.each<{ event: ControlEvent }>([
    {
      event: {
        kind: "cloud-sync-status",
        status: "connected",
        observedAtMs: 0,
      },
    },
    { event: { kind: "aggregate-dirty", dirty: true } },
    {
      event: {
        kind: "epic-deleted",
        deletedByDisplayName: null,
        deletedByTraycerUserId: null,
      },
    },
  ])("does NOT refetch for $event.kind", async ({ event }) => {
    const { fetch, calls } = createFakeFetch();
    const { sources } = createSources(fetch, undefined);
    const policy = createWorkspaceContextRefreshPolicy(sources);

    policy.start();
    calls()[0]?.deferred.resolve(contextFixture());
    await flush();

    policy.noteControlEvent(event);

    expect(calls()).toHaveLength(1);
  });
});

// ─── coalescing ─────────────────────────────────────────────────────────────

describe("createWorkspaceContextRefreshPolicy - coalescing", () => {
  it("five triggers while a fetch is in flight produce exactly ONE trailing fetch, started after the last trigger", async () => {
    const { fetch, calls } = createFakeFetch();
    const { sources } = createSources(fetch, undefined);
    const policy = createWorkspaceContextRefreshPolicy(sources);

    policy.start();
    expect(calls()).toHaveLength(1);

    // Five triggers land while the initial fetch is still in flight.
    for (let i = 0; i < 5; i += 1) {
      policy.noteControlEvent({
        kind: "migration",
        migration: { status: "started" },
      });
    }
    // Still only the original in-flight fetch: no second request queued yet.
    expect(calls()).toHaveLength(1);

    calls()[0]?.deferred.resolve(contextFixture());
    await flush();

    // Exactly one trailing fetch started after the burst resolved.
    expect(calls()).toHaveLength(2);
  });

  it("the trailing fetch carries the cause of the LAST trigger (a reconnect landing mid-migration reports 'reconnect')", async () => {
    const { fetch, calls } = createFakeFetch();
    const { sources, onContextCalls } = createSources(fetch, undefined);
    const policy = createWorkspaceContextRefreshPolicy(sources);

    policy.start();
    policy.noteControlEvent({
      kind: "migration",
      migration: { status: "started" },
    });
    policy.noteTransportStatus("reconnecting");
    policy.noteTransportStatus("open");

    calls()[0]?.deferred.resolve(contextFixture());
    await flush();

    expect(calls()).toHaveLength(2);
    calls()[1]?.deferred.resolve(contextFixture());
    await flush();

    expect(onContextCalls.map((entry) => entry.cause)).toEqual([
      "initial",
      "reconnect",
    ]);
  });
});

// ─── noteAuthorityEpochChanged ──────────────────────────────────────────────

describe("createWorkspaceContextRefreshPolicy - noteAuthorityEpochChanged", () => {
  it("refetches with cause 'authority-epoch-changed'", async () => {
    const { fetch, calls } = createFakeFetch();
    const { sources, onContextCalls } = createSources(fetch, undefined);
    const policy = createWorkspaceContextRefreshPolicy(sources);

    policy.start();
    calls()[0]?.deferred.resolve(contextFixture());
    await flush();

    policy.noteAuthorityEpochChanged();
    calls()[1]?.deferred.resolve(contextFixture());
    await flush();

    expect(onContextCalls.map((entry) => entry.cause)).toEqual([
      "initial",
      "authority-epoch-changed",
    ]);
  });
});

// ─── rejection and disposal ─────────────────────────────────────────────────

describe("createWorkspaceContextRefreshPolicy - rejection is reported, never latched", () => {
  it("a rejected fetch calls onError (not onContext) and a later trigger still fetches", async () => {
    const { fetch, calls } = createFakeFetch();
    const { sources, onContextCalls, onErrorCalls } = createSources(
      fetch,
      undefined,
    );
    const policy = createWorkspaceContextRefreshPolicy(sources);

    policy.start();
    const failure = new Error("host unreachable");
    calls()[0]?.deferred.reject(failure);
    await flush();

    expect(onErrorCalls).toEqual([{ error: failure, cause: "initial" }]);
    expect(onContextCalls).toEqual([]);

    policy.noteAuthorityEpochChanged();
    expect(calls()).toHaveLength(2);

    calls()[1]?.deferred.resolve(contextFixture());
    await flush();
    expect(onContextCalls).toEqual([
      { context: contextFixture(), cause: "authority-epoch-changed" },
    ]);
  });
});

describe("createWorkspaceContextRefreshPolicy - dispose()", () => {
  it("an in-flight answer after dispose() calls neither onContext nor onError, and later triggers fetch nothing", async () => {
    const { fetch, calls } = createFakeFetch();
    const { sources, onContextCalls, onErrorCalls } = createSources(
      fetch,
      undefined,
    );
    const policy = createWorkspaceContextRefreshPolicy(sources);

    policy.start();
    policy.dispose();
    calls()[0]?.deferred.resolve(contextFixture());
    await flush();

    expect(onContextCalls).toEqual([]);
    expect(onErrorCalls).toEqual([]);

    policy.noteAuthorityEpochChanged();
    expect(calls()).toHaveLength(1);
  });

  it("the injected isDisposed() flipping true has the same effect", async () => {
    let disposed = false;
    const { fetch, calls } = createFakeFetch();
    const { sources, onContextCalls } = createSources(fetch, () => disposed);
    const policy = createWorkspaceContextRefreshPolicy(sources);

    policy.start();
    disposed = true;
    calls()[0]?.deferred.resolve(contextFixture());
    await flush();

    expect(onContextCalls).toEqual([]);

    policy.noteAuthorityEpochChanged();
    expect(calls()).toHaveLength(1);
  });
});
