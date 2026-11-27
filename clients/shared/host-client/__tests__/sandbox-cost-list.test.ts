import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readBrowserSandboxCostsForAccount,
  readSandboxCostsForAccount,
} from "../sandbox-cost-list";

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

  it("holds browser transport in its lock and honors a preseeded shared deadline without exposing the account id", async () => {
    const failedRead = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init: RequestInit | undefined) => {
        started.resolve();
        return failedRead.promise;
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const storedDeadlines = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storedDeadlines.get(key) ?? null,
      removeItem: (key: string) => storedDeadlines.delete(key),
      setItem: (key: string, value: string) => storedDeadlines.set(key, value),
    });
    vi.stubGlobal("crypto", {
      subtle: {
        digest: async () => new Uint8Array(32).buffer,
      },
    });
    const lockNames: string[] = [];
    let holdLock = false;
    vi.stubGlobal("navigator", {
      locks: {
        request: async (name: string, callback: () => Promise<unknown>) => {
          lockNames.push(name);
          if (lockNames.length === 2) {
            storedDeadlines.set(name, String(Date.now() + 60_000));
          }
          holdLock = true;
          try {
            return await callback();
          } finally {
            holdLock = false;
          }
        },
      },
    });

    const endpoint = "https://browser-cost.test/lock-storage/";
    const caller = principal(
      "private-account-id",
      "browser-bearer",
      () => true,
    );
    const firstRead = readBrowserSandboxCostsForAccount(endpoint, caller);
    await started.promise;
    expect(holdLock).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    failedRead.resolve(jsonResponse(503, {}));
    const firstFailure = await firstRead;
    expect(firstFailure.kind).toBe("network-error");
    expect(holdLock).toBe(false);
    expect(lockNames[0]).toMatch(/^traycer:sandbox-cost:(?:[a-f\d]{2}){32}$/u);
    expect(lockNames[0]).not.toContain("private-account-id");

    await vi.advanceTimersByTimeAsync(60_000);
    const secondFailure = await readBrowserSandboxCostsForAccount(
      endpoint,
      caller,
    );
    expect(secondFailure.kind).toBe("network-error");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lockNames).toEqual([lockNames[0], lockNames[0]]);
    expect(storedDeadlines.get(lockNames[1])).toBeDefined();
    expect(lockNames[1]).not.toContain("private-account-id");
  });
});
