import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSandboxCostsForAccount } from "../sandbox-cost-list";

const COSTS = {
  sandboxes: [],
  awakeBurnMillicreditsPerHour: 0,
  todayYoursMillicredits: 0,
  todayByEnvironment: [],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function principal(
  userId: string,
  bearerToken: string,
  isCurrent: () => boolean,
) {
  return { userId, bearerToken, isCurrent };
}

interface LockJob {
  readonly callback: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

interface WebLockQueue {
  readonly requests: readonly string[];
  readonly request: (
    name: string,
    callback: () => Promise<unknown>,
  ) => Promise<unknown>;
  readonly waitForRequestCount: (count: number) => Promise<void>;
  readonly isHeld: (name: string) => boolean;
  readonly abandon: (name: string) => void;
}

function createWebLockQueue(): WebLockQueue {
  const requests: string[] = [];
  const active = new Map<string, LockJob>();
  const queued = new Map<string, LockJob[]>();
  const requestCountWaiters: {
    readonly count: number;
    readonly resolve: () => void;
  }[] = [];

  function runNext(name: string): void {
    if (active.has(name)) return;
    const job = queued.get(name)?.shift();
    if (job === undefined) return;
    active.set(name, job);
    void job
      .callback()
      .then(job.resolve, job.reject)
      .finally(() => {
        if (active.get(name) !== job) return;
        active.delete(name);
        runNext(name);
      });
  }

  function request(
    name: string,
    callback: () => Promise<unknown>,
  ): Promise<unknown> {
    requests.push(name);
    for (const waiter of [...requestCountWaiters]) {
      if (requests.length < waiter.count) continue;
      requestCountWaiters.splice(requestCountWaiters.indexOf(waiter), 1);
      waiter.resolve();
    }
    return new Promise((resolve, reject) => {
      const jobs = queued.get(name) ?? [];
      jobs.push({ callback, resolve, reject });
      queued.set(name, jobs);
      runNext(name);
    });
  }

  function waitForRequestCount(count: number): Promise<void> {
    if (requests.length >= count) return Promise.resolve();
    const waiter = Promise.withResolvers<void>();
    requestCountWaiters.push({ count, resolve: waiter.resolve });
    return waiter.promise;
  }

  function abandon(name: string): void {
    active.delete(name);
    runNext(name);
  }

  return {
    abandon,
    isHeld: (name: string) => active.has(name),
    request,
    requests,
    waitForRequestCount,
  };
}

function stubBrowserBoundaries(
  locks: WebLockQueue,
  storage: Map<string, string>,
): void {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    removeItem: (key: string) => storage.delete(key),
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal("crypto", {
    subtle: {
      digest: async () => new Uint8Array(32).buffer,
    },
  });
  vi.stubGlobal("navigator", { locks: { request: locks.request } });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("readSandboxCostsForAccount", () => {
  it("joins same-account reads, shares a failure cooldown, then admits one read", async () => {
    const failedRead = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    let requests = 0;
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init: RequestInit | undefined) => {
        requests += 1;
        if (requests === 1) {
          started.resolve();
          return failedRead.promise;
        }
        return Promise.resolve(jsonResponse(200, COSTS));
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = readSandboxCostsForAccount(
      "https://cost-coordinator.test/join-cooldown/",
      null,
      principal("account-1", "bearer-1", () => true),
    );
    await started.promise;
    const joined = readSandboxCostsForAccount(
      "https://cost-coordinator.test/join-cooldown/",
      null,
      principal("account-1", "bearer-1", () => true),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    failedRead.resolve(jsonResponse(503, {}));
    const [firstFailure, joinedFailure] = await Promise.all([first, joined]);
    expect(firstFailure).toMatchObject({
      kind: "network-error",
      retryAtMs: Date.now() + 60_000,
    });
    expect(joinedFailure).toEqual(firstFailure);

    const duringCooldown = await readSandboxCostsForAccount(
      "https://cost-coordinator.test/join-cooldown/",
      null,
      principal("account-1", "bearer-1", () => true),
    );
    expect(duringCooldown).toEqual(firstFailure);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    const [afterCooldown, afterCooldownJoin] = await Promise.all([
      readSandboxCostsForAccount(
        "https://cost-coordinator.test/join-cooldown/",
        null,
        principal("account-1", "bearer-1", () => true),
      ),
      readSandboxCostsForAccount(
        "https://cost-coordinator.test/join-cooldown/",
        null,
        principal("account-1", "bearer-1", () => true),
      ),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(afterCooldown).toEqual({ kind: "ok", costs: COSTS });
    expect(afterCooldownJoin).toEqual(afterCooldown);
  });

  it("drains an abandoned bounded read before same-account relogin fetches with its new bearer", async () => {
    let oldSessionCurrent = true;
    const started = Promise.withResolvers<void>();
    let requests = 0;
    const freshCosts = { ...COSTS, todayYoursMillicredits: 99 };
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init: RequestInit | undefined) => {
        requests += 1;
        if (requests === 1) {
          started.resolve();
          return new Promise<Response>(() => {});
        }
        return Promise.resolve(jsonResponse(200, freshCosts));
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const endpoint = "https://cost-coordinator.test/relogin-drain/";
    const abandoned = readSandboxCostsForAccount(
      endpoint,
      null,
      principal("account-2", "old-bearer", () => oldSessionCurrent),
    );
    await started.promise;

    oldSessionCurrent = false;
    const reloginPrincipal = principal("account-2", "new-bearer", () => true);
    const reloginWhileDraining = readSandboxCostsForAccount(
      endpoint,
      null,
      reloginPrincipal,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const [abandonedResult, reloginFailure] = await Promise.all([
      abandoned,
      reloginWhileDraining,
    ]);
    expect(abandonedResult).toEqual({ kind: "unauthorized" });
    expect(reloginFailure).toMatchObject({
      kind: "network-error",
      retryAtMs: Date.now() + 60_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    const reloginResult = await readSandboxCostsForAccount(
      endpoint,
      null,
      reloginPrincipal,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      new Headers(fetchMock.mock.calls.at(1)?.[1]?.headers).get(
        "authorization",
      ),
    ).toBe("Bearer new-bearer");
    expect(reloginResult).toEqual({ kind: "ok", costs: freshCosts });
  });

  it("serializes independent browser tabs without sharing either result", async () => {
    vi.resetModules();
    const tabOne = await import("../sandbox-cost-list");
    vi.resetModules();
    const tabTwo = await import("../sandbox-cost-list");
    const firstResponse = Promise.withResolvers<Response>();
    const secondResponse = Promise.withResolvers<Response>();
    const firstStarted = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    let requests = 0;
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init: RequestInit | undefined) => {
        requests += 1;
        if (requests === 1) {
          firstStarted.resolve();
          return firstResponse.promise;
        }
        secondStarted.resolve();
        return secondResponse.promise;
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const locks = createWebLockQueue();
    const storage = new Map<string, string>();
    stubBrowserBoundaries(locks, storage);
    const endpoint = "https://browser-cost.test/two-tabs/";
    const caller = principal(
      "private-account-id",
      "browser-bearer",
      () => true,
    );

    const tabOneRead = tabOne.readBrowserSandboxCostsForAccount(
      endpoint,
      caller,
    );
    await firstStarted.promise;
    const lockName = locks.requests[0];
    if (lockName === undefined) throw new Error("the first tab did not lock");
    expect(locks.isHeld(lockName)).toBe(true);
    expect(storage.get(lockName)).toBe(`lease:${Date.now() + 10_000}`);

    const tabTwoRead = tabTwo.readBrowserSandboxCostsForAccount(
      endpoint,
      caller,
    );
    await locks.waitForRequestCount(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(locks.requests[1]).toBe(lockName);
    expect(lockName).toMatch(/^traycer:sandbox-cost:(?:[a-f\d]{2}){32}$/u);
    expect(lockName).not.toContain("private-account-id");

    firstResponse.resolve(
      jsonResponse(200, { ...COSTS, todayYoursMillicredits: 11 }),
    );
    const firstResult = await tabOneRead;
    await secondStarted.promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    secondResponse.resolve(
      jsonResponse(200, { ...COSTS, todayYoursMillicredits: 22 }),
    );
    const secondResult = await tabTwoRead;

    expect(firstResult).toEqual({
      kind: "ok",
      costs: { ...COSTS, todayYoursMillicredits: 11 },
    });
    expect(secondResult).toEqual({
      kind: "ok",
      costs: { ...COSTS, todayYoursMillicredits: 22 },
    });
    expect(storage.has(lockName)).toBe(false);
  });

  it("lets the next tab wait on a dead tab's persisted lease until its ten-second expiry", async () => {
    vi.resetModules();
    const tabOne = await import("../sandbox-cost-list");
    vi.resetModules();
    const tabTwo = await import("../sandbox-cost-list");
    const secondResponse = Promise.withResolvers<Response>();
    const firstStarted = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    let requests = 0;
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init: RequestInit | undefined) => {
        requests += 1;
        if (requests === 1) {
          firstStarted.resolve();
          return new Promise<Response>(() => {});
        }
        secondStarted.resolve();
        return secondResponse.promise;
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const locks = createWebLockQueue();
    const storage = new Map<string, string>();
    stubBrowserBoundaries(locks, storage);
    const endpoint = "https://browser-cost.test/dead-tab-lease/";
    const caller = principal(
      "private-account-id",
      "browser-bearer",
      () => true,
    );
    let deadTabSettled = false;
    const deadTabRead = tabOne.readBrowserSandboxCostsForAccount(
      endpoint,
      caller,
    );
    void deadTabRead.then(() => {
      deadTabSettled = true;
    });
    await firstStarted.promise;
    const lockName = locks.requests[0];
    if (lockName === undefined) throw new Error("the first tab did not lock");
    expect(storage.get(lockName)).toBe(`lease:${Date.now() + 10_000}`);

    const nextTabRead = tabTwo.readBrowserSandboxCostsForAccount(
      endpoint,
      caller,
    );
    await locks.waitForRequestCount(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    locks.abandon(lockName);
    vi.clearAllTimers();
    await Promise.resolve();
    expect(locks.isHeld(lockName)).toBe(true);
    expect(deadTabSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await secondStarted.promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(deadTabSettled).toBe(false);
    secondResponse.resolve(
      jsonResponse(200, { ...COSTS, todayYoursMillicredits: 33 }),
    );
    expect(await nextTabRead).toEqual({
      kind: "ok",
      costs: { ...COSTS, todayYoursMillicredits: 33 },
    });
    expect(deadTabSettled).toBe(false);
  });

  it("reads a legacy numeric retry deadline from the hashed browser lock key", async () => {
    vi.resetModules();
    const tab = await import("../sandbox-cost-list");
    const locks = createWebLockQueue();
    const storage = new Map<string, string>();
    stubBrowserBoundaries(locks, storage);
    const endpoint = "https://browser-cost.test/legacy-deadline/";
    const retryAtMs = Date.now() + 45_000;
    const lockName = `traycer:sandbox-cost:${"00".repeat(32)}`;
    storage.set(lockName, String(retryAtMs));
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init: RequestInit | undefined) =>
        Promise.resolve(jsonResponse(200, COSTS)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await tab.readBrowserSandboxCostsForAccount(
      endpoint,
      principal("private-account-id", "browser-bearer", () => true),
    );

    expect(result).toMatchObject({ kind: "network-error", retryAtMs });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(locks.requests).toEqual([lockName]);
    expect(lockName).not.toContain("private-account-id");
  });
});
