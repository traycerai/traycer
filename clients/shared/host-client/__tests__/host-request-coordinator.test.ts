import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineRpcContract,
  defineVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import type {
  HostRequestAuthority,
  RequestOfMethod,
  ResponseOfMethod,
} from "../../host-transport/host-messenger";
import {
  HostRequestControlFlowError,
  HostRequestCoordinator,
  type HostRequestAuthorityDomain,
} from "../host-request-coordinator";
import type { RpcSchedulingPolicy } from "../rpc-scheduling-policy";
import { HostClient, type IHostQueryInvalidator } from "../host-client";
import { MockHostMessenger } from "../mock/mock-host-messenger";
import { mockLocalHostEntry } from "../mock/mock-host-directory";
import {
  createRequestContext,
  identityFromAuthenticatedUser,
} from "@traycer/protocol/auth/request-context";
import { createAuthenticatedUserFixture } from "../../test-fixtures/authenticated-user";

const latestRead = defineRpcContract({
  method: "latest.read",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({
    path: z.string().transform((value) => value.trim()),
    optional: z.string().optional(),
    values: z.array(z.string().nullable().optional()).optional(),
  }),
  responseSchema: z.object({ value: z.string() }),
});

const fifoCommand = defineRpcContract({
  method: "fifo.command",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({ value: z.number() }),
  responseSchema: z.object({ value: z.string() }),
});

const joinAwait = defineRpcContract({
  method: "join.await",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({ session: z.string() }),
  responseSchema: z.object({ value: z.string() }),
});

const rawRead = defineRpcContract({
  method: "raw.read",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({ payload: z.unknown() }),
  responseSchema: z.object({ value: z.string() }),
});

const registry = defineVersionedRpcRegistry({
  "latest.read": {
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: latestRead, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
  "fifo.command": {
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: fifoCommand, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
  "join.await": {
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: joinAwait, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
  "raw.read": {
    1: {
      latestMinor: 0,
      versions: { 0: { contract: rawRead, upgradeFromPreviousVersion: null } },
      downgradePathsFromLatest: {},
    },
  },
});

const schedulingPolicy: RpcSchedulingPolicy<typeof registry> = {
  modeFor: (method) => {
    if (method === "fifo.command") return "fifo";
    if (method === "join.await") return "join";
    return "latest";
  },
  joinResponseTimeoutMs: (method) => (method === "join.await" ? 1_000 : null),
};

type Deferred<Value> = {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
  reject(reason: unknown): void;
};

function deferred<Value>(): Deferred<Value> {
  let resolvePromise: (value: Value) => void = () => undefined;
  let rejectPromise: (reason: unknown) => void = () => undefined;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function authority(hostId: string, userId: string): HostRequestAuthority {
  return {
    endpoint: { hostId, websocketUrl: `ws://${hostId}.invalid/rpc` },
    bearer: {
      getBearerToken: () => "bearer",
      identity: { userId },
    },
    abortSignal: new AbortController().signal,
  };
}

function domain(label: string): HostRequestAuthorityDomain {
  return { bindingToken: { label }, requestContext: { label } };
}

function submit<Method extends keyof typeof registry & string>(
  coordinator: HostRequestCoordinator<typeof registry>,
  method: Method,
  params: RequestOfMethod<typeof registry, Method>,
  requestAuthority: HostRequestAuthority,
  authorityDomain: HostRequestAuthorityDomain,
  execute: (
    requestAuthority: HostRequestAuthority,
  ) => Promise<ResponseOfMethod<typeof registry, Method>>,
): Promise<ResponseOfMethod<typeof registry, Method>> {
  return coordinator.request({
    hostId: requestAuthority.endpoint.hostId,
    userId: requestAuthority.bearer.identity.userId,
    method,
    params,
    authority: requestAuthority,
    authorityDomain,
    signal: undefined,
    execute,
  });
}

function makeCoordinator(): HostRequestCoordinator<typeof registry> {
  return new HostRequestCoordinator({ registry, schedulingPolicy });
}

describe("HostRequestCoordinator", () => {
  it("keeps raw latest concurrency at one and retains one sole tail during a storm", async () => {
    const coordinator = makeCoordinator();
    const first = deferred<{ value: string }>();
    const tail = deferred<{ value: string }>();
    const calls: Deferred<{ value: string }>[] = [];
    const execute = (): Promise<{ value: string }> => {
      const call = calls.length === 0 ? first : tail;
      calls.push(call);
      return call.promise;
    };
    const requestAuthority = authority("host-a", "user-a");
    const requestDomain = domain("same");

    const p1 = submit(
      coordinator,
      "latest.read",
      { path: "/workspace" },
      requestAuthority,
      requestDomain,
      execute,
    );
    const p2 = submit(
      coordinator,
      "latest.read",
      { path: "/workspace" },
      requestAuthority,
      requestDomain,
      execute,
    );
    const p3 = submit(
      coordinator,
      "latest.read",
      { path: "/workspace" },
      requestAuthority,
      requestDomain,
      execute,
    );

    expect(calls).toHaveLength(1);
    first.resolve({ value: "first" });
    await flush();
    expect(calls).toHaveLength(2);
    tail.resolve({ value: "tail" });

    await expect(p1).resolves.toEqual({ value: "first" });
    await expect(p2).resolves.toEqual({ value: "tail" });
    await expect(p3).resolves.toEqual({ value: "tail" });
  });

  it("rejects every replaced latest tail waiter and starts only the replacement", async () => {
    const coordinator = makeCoordinator();
    const first = deferred<{ value: string }>();
    const replacement = deferred<{ value: string }>();
    const calls: Deferred<{ value: string }>[] = [];
    const execute = (): Promise<{ value: string }> => {
      const call = calls.length === 0 ? first : replacement;
      calls.push(call);
      return call.promise;
    };
    const oldAuthority = authority("host-a", "user-a");
    const oldDomain = domain("old");
    const newAuthority = authority("host-a", "user-a");
    const newDomain = domain("new");

    const active = submit(
      coordinator,
      "latest.read",
      { path: "/workspace" },
      oldAuthority,
      oldDomain,
      execute,
    );
    const oldTail1 = submit(
      coordinator,
      "latest.read",
      { path: "/workspace" },
      oldAuthority,
      oldDomain,
      execute,
    );
    const oldTail2 = submit(
      coordinator,
      "latest.read",
      { path: "/workspace" },
      oldAuthority,
      oldDomain,
      execute,
    );
    const newTail = submit(
      coordinator,
      "latest.read",
      { path: "/workspace" },
      newAuthority,
      newDomain,
      execute,
    );

    await expect(oldTail1).rejects.toMatchObject({
      reason: "authority-superseded",
    });
    await expect(oldTail2).rejects.toMatchObject({
      reason: "authority-superseded",
    });
    first.resolve({ value: "active" });
    await flush();
    expect(calls).toHaveLength(2);
    replacement.resolve({ value: "replacement" });

    await expect(active).resolves.toEqual({ value: "active" });
    await expect(newTail).resolves.toEqual({ value: "replacement" });
  });

  it("runs FIFO commands losslessly and in submission order", async () => {
    const coordinator = makeCoordinator();
    const results = [
      deferred<{ value: string }>(),
      deferred<{ value: string }>(),
      deferred<{ value: string }>(),
    ];
    const started: number[] = [];
    const requestAuthority = authority("host-a", "user-a");
    const requestDomain = domain("fifo");

    const requests = [1, 2, 3].map((sequence) => {
      return submit(
        coordinator,
        "fifo.command",
        { value: 1 },
        requestAuthority,
        requestDomain,
        () => {
          started.push(sequence);
          return results[sequence - 1].promise;
        },
      );
    });

    expect(started).toEqual([1]);
    results[0].resolve({ value: "one" });
    await flush();
    expect(started).toEqual([1, 2]);
    results[1].resolve({ value: "two" });
    await flush();
    expect(started).toEqual([1, 2, 3]);
    results[2].resolve({ value: "three" });

    await expect(requests[0]).resolves.toEqual({ value: "one" });
    await expect(requests[1]).resolves.toEqual({ value: "two" });
    await expect(requests[2]).resolves.toEqual({ value: "three" });
    expect(started).toEqual([1, 2, 3]);
  });

  it("keeps an in-flight FIFO command running while aborting a superseded latest read", async () => {
    const coordinator = makeCoordinator();
    const fifoRaw = deferred<{ value: string }>();
    const latestRaw = deferred<{ value: string }>();
    const observed = {
      fifoAuthority: null as HostRequestAuthority | null,
      latestAuthority: null as HostRequestAuthority | null,
    };
    const requestAuthority = authority("host-a", "user-a");
    const requestDomain = domain("transition-old");

    const fifoRequest = submit(
      coordinator,
      "fifo.command",
      { value: 1 },
      requestAuthority,
      requestDomain,
      (capturedAuthority) => {
        observed.fifoAuthority = capturedAuthority;
        return fifoRaw.promise;
      },
    );
    const latestRequest = submit(
      coordinator,
      "latest.read",
      { path: "/workspace" },
      requestAuthority,
      requestDomain,
      (capturedAuthority) => {
        observed.latestAuthority = capturedAuthority;
        return latestRaw.promise;
      },
    );

    coordinator.abortHost("host-a");

    expect(observed.fifoAuthority?.abortSignal.aborted).toBe(false);
    expect(observed.latestAuthority?.abortSignal.aborted).toBe(true);
    await expect(latestRequest).rejects.toMatchObject({
      reason: "authority-superseded",
    });

    fifoRaw.resolve({ value: "command-completed" });
    await expect(fifoRequest).resolves.toEqual({ value: "command-completed" });
    latestRaw.resolve({ value: "late" });
    await flush();
  });

  it("does not apply a delayed transition abort to a read submitted after its snapshot", async () => {
    const coordinator = makeCoordinator();
    const oldRaw = deferred<{ value: string }>();
    const currentRaw = deferred<{ value: string }>();
    const observed = {
      oldAuthority: null as HostRequestAuthority | null,
      currentAuthority: null as HostRequestAuthority | null,
    };
    const requestAuthority = authority("host-a", "user-a");
    const oldRequest = submit(
      coordinator,
      "latest.read",
      { path: "/before-transition" },
      requestAuthority,
      domain("old"),
      (capturedAuthority) => {
        observed.oldAuthority = capturedAuthority;
        return oldRaw.promise;
      },
    );

    const transition = coordinator.snapshotHostTransition("host-a");
    const currentRequest = submit(
      coordinator,
      "latest.read",
      { path: "/after-transition" },
      requestAuthority,
      domain("current"),
      (capturedAuthority) => {
        observed.currentAuthority = capturedAuthority;
        return currentRaw.promise;
      },
    );

    coordinator.abortHostTransition(transition);

    expect(observed.oldAuthority?.abortSignal.aborted).toBe(true);
    expect(observed.currentAuthority?.abortSignal.aborted).toBe(false);
    await expect(oldRequest).rejects.toMatchObject({
      reason: "authority-superseded",
    });

    currentRaw.resolve({ value: "current" });
    await expect(currentRequest).resolves.toEqual({ value: "current" });
    oldRaw.resolve({ value: "late" });
    await flush();
  });

  it("releases a cancelled active latest read so its held tail can fetch fresh data", async () => {
    const coordinator = makeCoordinator();
    const started: string[] = [];
    const requestAuthority = authority("host-a", "user-a");
    const requestDomain = domain("query-cancellation");
    const active = submit(
      coordinator,
      "latest.read",
      { path: "/indicator" },
      requestAuthority,
      requestDomain,
      (capturedAuthority) => {
        started.push("active");
        return new Promise<{ value: string }>((_resolve, reject) => {
          capturedAuthority.abortSignal.addEventListener(
            "abort",
            () => reject(new Error("cancelled raw read")),
            { once: true },
          );
        });
      },
    );
    const tail = submit(
      coordinator,
      "latest.read",
      { path: "/indicator" },
      requestAuthority,
      requestDomain,
      () => {
        started.push("tail");
        return Promise.resolve({ value: "fresh" });
      },
    );

    coordinator.cancelActiveRead("host-a", "user-a", "latest.read", {
      path: "/indicator",
    });

    await flush();
    expect(started).toEqual(["active", "tail"]);
    await expect(active).rejects.toMatchObject({ reason: "waiter-cancelled" });
    await expect(tail).resolves.toEqual({ value: "fresh" });
  });

  it("batches compatible join callers and keeps an incompatible authority behind the active job", async () => {
    const coordinator = makeCoordinator();
    const active = deferred<{ value: string }>();
    const queued = deferred<{ value: string }>();
    const calls: Deferred<{ value: string }>[] = [];
    const execute = (): Promise<{ value: string }> => {
      const call = calls.length === 0 ? active : queued;
      calls.push(call);
      return call.promise;
    };
    const oldAuthority = authority("host-a", "user-a");
    const oldDomain = domain("old");
    const newAuthority = authority("host-a", "user-a");
    const newDomain = domain("new");

    const activeWaiter = submit(
      coordinator,
      "join.await",
      { session: "login" },
      oldAuthority,
      oldDomain,
      execute,
    );
    const activeJoiner = submit(
      coordinator,
      "join.await",
      { session: "login" },
      oldAuthority,
      oldDomain,
      execute,
    );
    const queuedWaiter = submit(
      coordinator,
      "join.await",
      { session: "login" },
      newAuthority,
      newDomain,
      execute,
    );
    const queuedJoiner = submit(
      coordinator,
      "join.await",
      { session: "login" },
      newAuthority,
      newDomain,
      execute,
    );

    expect(calls).toHaveLength(1);
    active.resolve({ value: "active" });
    await flush();
    expect(calls).toHaveLength(2);
    queued.resolve({ value: "queued" });

    await expect(activeWaiter).resolves.toEqual({ value: "active" });
    await expect(activeJoiner).resolves.toEqual({ value: "active" });
    await expect(queuedWaiter).resolves.toEqual({ value: "queued" });
    await expect(queuedJoiner).resolves.toEqual({ value: "queued" });
  });

  it("aborts a join socket when its last cancelable waiter detaches", async () => {
    const coordinator = makeCoordinator();
    const call = deferred<{ value: string }>();
    const observed: { authority: HostRequestAuthority | null } = {
      authority: null,
    };
    const controller = new AbortController();
    const requestAuthority = authority("host-a", "user-a");
    const request = coordinator.request({
      hostId: requestAuthority.endpoint.hostId,
      userId: requestAuthority.bearer.identity.userId,
      method: "join.await",
      params: { session: "login" },
      authority: requestAuthority,
      authorityDomain: domain("join"),
      signal: controller.signal,
      execute: (capturedAuthority) => {
        observed.authority = capturedAuthority;
        return call.promise;
      },
    });

    controller.abort();
    await expect(request).rejects.toMatchObject({ reason: "waiter-cancelled" });
    expect(observed.authority?.abortSignal.aborted).toBe(true);
    call.resolve({ value: "late" });
    await flush();
  });

  it("validates join response timeout against the injected method policy", async () => {
    const invalidator: IHostQueryInvalidator = {
      invalidateHostScope: () => undefined,
    };
    const messenger = new MockHostMessenger<typeof registry>({
      registry,
      handlers: { "join.await": () => ({ value: "ok" }) },
      requestId: () => "request-1",
    });
    const client = new HostClient({
      registry,
      messenger,
      invalidator,
      schedulingPolicy,
      requestCoordinator: null,
    });
    const fixture = createAuthenticatedUserFixture(undefined);
    const context = createRequestContext({
      identity: identityFromAuthenticatedUser(fixture),
      bearerToken: "bearer",
      origin: "test",
      connectionId: undefined,
      operationId: undefined,
      externalAbortSignal: undefined,
    });
    client.bind(mockLocalHostEntry);
    client.setRequestContext(context);

    await expect(
      client.requestWithResponseTimeout(
        "join.await",
        { session: "login" },
        999,
      ),
    ).rejects.toThrow("does not permit response timeout 999");
    await expect(
      client.requestWithResponseTimeout(
        "join.await",
        { session: "login" },
        1_000,
      ),
    ).resolves.toEqual({ value: "ok" });
    expect(messenger.calls).toHaveLength(1);
    client.dispose();
  });

  it("uses the parsed stable wire value for structural keys and rejects non-wire values", () => {
    const coordinator = makeCoordinator();
    const transformed = coordinator.schedulingKeyFor(
      "host-a",
      "user-a",
      "latest.read",
      {
        path: " /tmp/a|b ",
        optional: undefined,
        values: [undefined, null, "x"],
      },
    );
    const canonical = coordinator.schedulingKeyFor(
      "host-a",
      "user-a",
      "latest.read",
      { path: "/tmp/a|b", values: [null, null, "x"] },
    );
    expect(transformed).toBe(canonical);

    const ordered = coordinator.schedulingKeyFor(
      "host/a",
      "user,b",
      "raw.read",
      { payload: { z: 1, a: 2, omitted: undefined } },
    );
    const reordered = coordinator.schedulingKeyFor(
      "host/a",
      "user,b",
      "raw.read",
      { payload: { a: 2, z: 1 } },
    );
    expect(ordered).toBe(reordered);
    expect(
      coordinator.schedulingKeyFor("host-a", "user-a", "raw.read", {
        payload: [undefined],
      }),
    ).toBe(
      coordinator.schedulingKeyFor("host-a", "user-a", "raw.read", {
        payload: [null],
      }),
    );

    expect(() =>
      coordinator.schedulingKeyFor("host-a", "user-a", "raw.read", {
        payload: NaN,
      }),
    ).toThrow();
    expect(() =>
      coordinator.schedulingKeyFor("host-a", "user-a", "raw.read", {
        payload: Infinity,
      }),
    ).toThrow();
    expect(() =>
      coordinator.schedulingKeyFor("host-a", "user-a", "raw.read", {
        payload: BigInt(1),
      }),
    ).toThrow();
    expect(() =>
      coordinator.schedulingKeyFor("host-a", "user-a", "raw.read", {
        payload: Symbol("x"),
      }),
    ).toThrow();
    expect(() =>
      coordinator.schedulingKeyFor("host-a", "user-a", "raw.read", {
        payload: () => undefined,
      }),
    ).toThrow();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() =>
      coordinator.schedulingKeyFor("host-a", "user-a", "raw.read", {
        payload: cycle,
      }),
    ).toThrow();
  });

  it("settles cancellation and disposal exactly once, including late raw completion", async () => {
    const coordinator = makeCoordinator();
    const active = deferred<{ value: string }>();
    const requestAuthority = authority("host-a", "user-a");
    const controller = new AbortController();
    const cancelled = coordinator.request({
      hostId: requestAuthority.endpoint.hostId,
      userId: requestAuthority.bearer.identity.userId,
      method: "latest.read",
      params: { path: "/cancelled" },
      authority: requestAuthority,
      authorityDomain: domain("cancel"),
      signal: controller.signal,
      execute: () => active.promise,
    });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({
      reason: "waiter-cancelled",
    });
    active.resolve({ value: "late" });
    await flush();

    const disposeActive = deferred<{ value: string }>();
    const disposeQueued = deferred<{ value: string }>();
    const disposeCalls: Deferred<{ value: string }>[] = [];
    const disposeRequest = (value: string) =>
      coordinator.request({
        hostId: requestAuthority.endpoint.hostId,
        userId: requestAuthority.bearer.identity.userId,
        method: "latest.read",
        params: { path: value },
        authority: requestAuthority,
        authorityDomain: domain("dispose"),
        signal: undefined,
        execute: () => {
          const call =
            disposeCalls.length === 0 ? disposeActive : disposeQueued;
          disposeCalls.push(call);
          return call.promise;
        },
      });
    const activeRequest = disposeRequest("active");
    const queuedRequest = disposeRequest("queued");
    coordinator.dispose();

    await expect(activeRequest).rejects.toBeInstanceOf(
      HostRequestControlFlowError,
    );
    await expect(activeRequest).rejects.toMatchObject({
      reason: "coordinator-disposed",
    });
    await expect(queuedRequest).rejects.toMatchObject({
      reason: "coordinator-disposed",
    });
    disposeActive.resolve({ value: "late-active" });
    disposeQueued.resolve({ value: "late-queued" });
    await flush();
    await expect(
      coordinator.request({
        hostId: requestAuthority.endpoint.hostId,
        userId: requestAuthority.bearer.identity.userId,
        method: "latest.read",
        params: { path: "after-dispose" },
        authority: requestAuthority,
        authorityDomain: domain("after"),
        signal: undefined,
        execute: () => Promise.resolve({ value: "never" }),
      }),
    ).rejects.toMatchObject({ reason: "coordinator-disposed" });
  });
});
