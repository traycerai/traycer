import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cliCredentialsPath } from "@traycer/protocol/config/paths";
import { withCredentialsLock } from "@traycer/protocol/config/credentials-lock";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
  type HostTokenPersistence,
  type HostTokenMintOutcome,
} from "../host-token-source";
import type { HostTokenTable } from "../host-token-store";
import {
  createHostTokenFilePersistence,
  hostTokensPath,
} from "../host-token-file";
import {
  forgetHostTokensOnSignOut,
  type SignedInWatch,
} from "../host-token-sign-out";

const USER_A = "user-a";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function inspectablePersistence(load: Promise<HostTokenTable>): {
  readonly persistence: HostTokenPersistence;
  readonly table: () => HostTokenTable;
} {
  let table: HostTokenTable = new Map();
  return {
    persistence: {
      load: () => load,
      update: (change) => {
        table = change(table);
        return Promise.resolve(table);
      },
    },
    table: () => table,
  };
}

function deferredSignedInWatch(): {
  readonly watch: SignedInWatch;
  readonly settleCurrent: (userId: string | null) => void;
  readonly emit: (userId: string | null) => void;
  readonly settled: Promise<string | null>;
} {
  let resolveCurrent = (_userId: string | null): void => undefined;
  let listener: ((userId: string | null) => void) | null = null;
  const settled = new Promise<string | null>((resolve) => {
    resolveCurrent = resolve;
  });
  return {
    watch: {
      current: () => settled,
      onChange: (next) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
    },
    settleCurrent: (userId) => resolveCurrent(userId),
    emit: (userId) => {
      if (listener === null) throw new Error("sign-in listener is not ready");
      listener(userId);
    },
    settled,
  };
}

function filePersistence(environment: string) {
  return createHostTokenFilePersistence({
    environment,
    lockWaitMs: 1_000,
    lockPollIntervalMs: 25,
  });
}

describe("host-token file persistence", () => {
  it("stores only per-user, per-host tokens and ends with private atomic replacement", async () => {
    const environment = "host-token-file-records";
    const persistence = filePersistence(environment);
    const path = hostTokensPath(environment);
    const lockPath = `${cliCredentialsPath(environment)}.lock`;

    const first = await persistence.update((table) => {
      const users = new Map(table);
      users.set(
        USER_A,
        new Map([
          ["computer-a", { token: "host-token-a1", expiresAtMs: 10_000 }],
        ]),
      );
      users.set(
        "user-b",
        new Map([
          ["computer-a", { token: "host-token-b", expiresAtMs: 20_000 }],
        ]),
      );
      return users;
    });
    const firstStat = await stat(path);
    const second = new Map(first);
    second.set(
      USER_A,
      new Map([
        ["computer-a", { token: "host-token-a2", expiresAtMs: 30_000 }],
      ]),
    );
    await persistence.update(() => second);

    expect(hostTokensPath(environment)).toBe(path);
    expect(basename(path)).toBe("host-tokens");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    if (process.platform !== "win32")
      expect((await stat(path)).ino).not.toBe(firstStat.ino);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      users: {
        [USER_A]: {
          "computer-a": { token: "host-token-a2", expiresAt: 30_000 },
        },
        "user-b": {
          "computer-a": { token: "host-token-b", expiresAt: 20_000 },
        },
      },
    });
    expect(
      (await readdir(dirname(path))).filter((entry) => entry.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("applies a file update while holding the credentials lock", async () => {
    const environment = "host-token-file-lock";
    const lockPath = `${cliCredentialsPath(environment)}.lock`;
    let observedLock = false;
    await filePersistence(environment).update((table) => {
      observedLock = true;
      expect(existsSync(lockPath)).toBe(true);
      const users = new Map(table);
      users.set(
        USER_A,
        new Map([
          ["computer-a", { token: "locked-token", expiresAtMs: 50_000 }],
        ]),
      );
      return users;
    });
    expect(observedLock).toBe(true);
  });

  it("removes the signed-out user's entries through the sign-in change listener", async () => {
    const persistence = filePersistence("host-token-file-signout");
    const tokens = createHostTokenSource({
      persistence,
      mint: (): Promise<HostTokenMintOutcome> =>
        Promise.resolve({ kind: "no-sign-in" }),
      signIn: null,
      now: () => 1,
    });
    await tokens.adopt(USER_A, "computer-a", {
      token: "host-token-a",
      expiresAtMs: 10_000,
    });
    await tokens.adopt(USER_A, "computer-b", {
      token: "host-token-b",
      expiresAtMs: 20_000,
    });

    const watch: {
      onChange: ((userId: string | null) => void) | null;
      resolveCurrent: ((userId: string | null) => void) | null;
    } = { onChange: null, resolveCurrent: null };
    const currentRead = new Promise<string | null>((resolve) => {
      watch.resolveCurrent = resolve;
    });
    const signedIn: SignedInWatch = {
      current: () => currentRead,
      onChange: (listener) => {
        watch.onChange = listener;
        return () => {
          watch.onChange = null;
        };
      },
    };
    const unsubscribe = forgetHostTokensOnSignOut(signedIn, tokens);
    const finishRead = watch.resolveCurrent;
    if (finishRead === null) throw new Error("sign-in read was not started");
    finishRead(USER_A);
    await currentRead;
    const forgotten = new Promise<void>((resolve) => {
      const stop = tokens.subscribe((change) => {
        if (change.userId === USER_A) {
          stop();
          resolve();
        }
      });
    });
    const notify = watch.onChange;
    if (notify === null) throw new Error("sign-in listener was not registered");
    notify(null);
    await forgotten;

    expect(tokens.current(USER_A, "computer-a")).toBeNull();
    expect(tokens.current(USER_A, "computer-b")).toBeNull();
    expect(tokens.current("user-b", "computer-a")).toBeNull();
    unsubscribe();
  });
});

describe("host-token source per-person eras", () => {
  it("drops an ok mint that answers after forgetUser", async () => {
    const answer = deferred<HostTokenMintOutcome>();
    const started = deferred<void>();
    const persistence = inspectablePersistence(Promise.resolve(new Map()));
    const tokens = createHostTokenSource({
      persistence: persistence.persistence,
      mint: () => {
        started.resolve();
        return answer.promise;
      },
      signIn: () => "sign-in-a",
      now: () => 0,
    });
    const announced: string[] = [];
    tokens.subscribe(({ userId, hostId }) => {
      announced.push(`${userId}:${hostId}`);
    });

    const pending = tokens.obtain(USER_A, "computer-a", false, null);
    await started.promise;
    await tokens.forgetUser(USER_A);
    announced.length = 0;
    answer.resolve({
      kind: "ok",
      token: { token: "late-token", expiresAtMs: 10_000 },
    });

    await expect(pending).resolves.toEqual({ kind: "superseded" });
    expect(tokens.current(USER_A, "computer-a")).toBeNull();
    expect(persistence.table().has(USER_A)).toBe(false);
    expect(announced).toEqual([]);
  });

  it("supersedes a not-a-member mint that answers after forgetUser", async () => {
    const answer = deferred<HostTokenMintOutcome>();
    const started = deferred<void>();
    const persistence = inspectablePersistence(Promise.resolve(new Map()));
    const tokens = createHostTokenSource({
      persistence: persistence.persistence,
      mint: () => {
        started.resolve();
        return answer.promise;
      },
      signIn: () => "sign-in-a",
      now: () => 0,
    });
    const announced: string[] = [];
    tokens.subscribe(({ userId, hostId }) => {
      announced.push(`${userId}:${hostId}`);
    });

    const pending = tokens.obtain(USER_A, "computer-a", false, null);
    await started.promise;
    await tokens.forgetUser(USER_A);
    announced.length = 0;
    answer.resolve({ kind: "not-a-member" });

    await expect(pending).resolves.toEqual({ kind: "superseded" });
    expect(tokens.current(USER_A, "computer-a")).toBeNull();
    expect(persistence.table().has(USER_A)).toBe(false);
    expect(announced).toEqual([]);
  });

  it("drops an adoption that was waiting on persistence when forgetUser ran", async () => {
    const load = deferred<HostTokenTable>();
    const persistence = inspectablePersistence(load.promise);
    const tokens = createHostTokenSource({
      persistence: persistence.persistence,
      mint: () => Promise.resolve({ kind: "no-sign-in" }),
      signIn: null,
      now: () => 0,
    });
    const announced: string[] = [];
    tokens.subscribe(({ userId, hostId }) => {
      announced.push(`${userId}:${hostId}`);
    });

    const adoption = tokens.adopt(USER_A, "computer-a", {
      token: "late-adopted-token",
      expiresAtMs: 10_000,
    });
    const forgetting = tokens.forgetUser(USER_A);
    expect(tokens.era(USER_A)).toBe(1);
    load.resolve(new Map());
    await Promise.all([adoption, forgetting]);

    expect(tokens.current(USER_A, "computer-a")).toBeNull();
    expect(persistence.table().has(USER_A)).toBe(false);
    expect(announced).toEqual([]);
  });

  it("does not join an earlier era's mint after forgetUser", async () => {
    const firstAnswer = deferred<HostTokenMintOutcome>();
    const secondAnswer = deferred<HostTokenMintOutcome>();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    let mintCalls = 0;
    const tokens = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => {
        mintCalls += 1;
        if (mintCalls === 1) {
          firstStarted.resolve();
          return firstAnswer.promise;
        }
        if (mintCalls === 2) {
          secondStarted.resolve();
          return secondAnswer.promise;
        }
        throw new Error("unexpected third mint");
      },
      signIn: () => "sign-in-a",
      now: () => 0,
    });

    const first = tokens.obtain(USER_A, "computer-a", false, null);
    await firstStarted.promise;
    await tokens.forgetUser(USER_A);
    const second = tokens.obtain(USER_A, "computer-a", false, null);
    await secondStarted.promise;
    secondAnswer.resolve({
      kind: "ok",
      token: { token: "second-era-token", expiresAtMs: 10_000 },
    });
    await expect(second).resolves.toEqual({
      kind: "ok",
      token: { token: "second-era-token", expiresAtMs: 10_000 },
    });
    firstAnswer.resolve({
      kind: "ok",
      token: { token: "first-era-token", expiresAtMs: 10_000 },
    });

    await expect(first).resolves.toEqual({ kind: "superseded" });
    expect(mintCalls).toBe(2);
    expect(tokens.current(USER_A, "computer-a")?.token).toBe(
      "second-era-token",
    );
  });

  it("supersedes a renewal that answers after forgetUser", async () => {
    const answer = deferred<HostTokenMintOutcome>();
    const started = deferred<void>();
    const tokens = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => {
        started.resolve();
        return answer.promise;
      },
      signIn: () => "sign-in-a",
      now: () => 0,
    });

    const renewal = tokens.renew(USER_A, ["computer-a"]);
    await started.promise;
    await tokens.forgetUser(USER_A);
    answer.resolve({
      kind: "ok",
      token: { token: "late-renewal-token", expiresAtMs: 10_000 },
    });

    await expect(renewal).resolves.toEqual({ kind: "superseded" });
    expect(tokens.current(USER_A, "computer-a")).toBeNull();
  });

  it("drops a mint store whose persistence callback runs after forgetUser", async () => {
    const answer = deferred<HostTokenMintOutcome>();
    const mintStarted = deferred<void>();
    const storeUpdateStarted = deferred<void>();
    const releaseStoreUpdate = deferred<void>();
    let updateCalls = 0;
    let table: HostTokenTable = new Map();
    const persistence: HostTokenPersistence = {
      load: () => Promise.resolve(new Map()),
      update: async (change) => {
        updateCalls += 1;
        if (updateCalls === 1) {
          storeUpdateStarted.resolve();
          await releaseStoreUpdate.promise;
        }
        table = change(table);
        return table;
      },
    };
    const tokens = createHostTokenSource({
      persistence,
      mint: () => {
        mintStarted.resolve();
        return answer.promise;
      },
      signIn: () => "sign-in-a",
      now: () => 0,
    });
    const announced: string[] = [];
    tokens.subscribe(({ userId, hostId }) => {
      announced.push(`${userId}:${hostId}`);
    });

    const pending = tokens.obtain(USER_A, "computer-a", false, null);
    await mintStarted.promise;
    answer.resolve({
      kind: "ok",
      token: { token: "racing-token", expiresAtMs: 10_000 },
    });
    await storeUpdateStarted.promise;
    await tokens.forgetUser(USER_A);
    releaseStoreUpdate.resolve();

    await expect(pending).resolves.toEqual({ kind: "superseded" });
    expect(tokens.current(USER_A, "computer-a")).toBeNull();
    expect(table.has(USER_A)).toBe(false);
    expect(announced).toEqual([]);
  });

  it("supersedes obtain when sign-out lands during the initial persistence load", async () => {
    const initialTable: HostTokenTable = new Map([
      [
        USER_A,
        new Map([["computer-a", { token: "held-token", expiresAtMs: 10_000 }]]),
      ],
    ]);
    const load = deferred<HostTokenTable>();
    let table = initialTable;
    const persistence: HostTokenPersistence = {
      load: () => load.promise,
      update: (change) => {
        table = change(table);
        return Promise.resolve(table);
      },
    };
    let mintCalls = 0;
    const tokens = createHostTokenSource({
      persistence,
      mint: () => {
        mintCalls += 1;
        return Promise.resolve({ kind: "no-sign-in" });
      },
      signIn: () => "sign-in-a",
      now: () => 0,
    });

    const pending = tokens.obtain(USER_A, "computer-a", false, null);
    const forgetting = tokens.forgetUser(USER_A);
    load.resolve(initialTable);
    const outcome = await pending;
    await forgetting;

    expect(outcome).toEqual({ kind: "superseded" });
    expect(mintCalls).toBe(0);
    expect(table.has(USER_A)).toBe(false);
  });
});

describe("forgetHostTokensOnSignOut with a late initial read", () => {
  function tokenSource() {
    return createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => Promise.resolve({ kind: "no-sign-in" }),
      signIn: null,
      now: () => 0,
    });
  }

  it("forgets A once when sign-out arrives before current() settles", async () => {
    const tokens = tokenSource();
    const forget = vi.spyOn(tokens, "forgetUser");
    const signedIn = deferredSignedInWatch();
    const unsubscribe = forgetHostTokensOnSignOut(signedIn.watch, tokens);

    signedIn.emit(null);
    signedIn.settleCurrent(USER_A);
    await signedIn.settled;

    expect(forget).toHaveBeenCalledTimes(1);
    expect(forget).toHaveBeenCalledWith(USER_A);
    unsubscribe();
  });

  it("forgets A once when A-to-B switch arrives before current() settles", async () => {
    const tokens = tokenSource();
    const forget = vi.spyOn(tokens, "forgetUser");
    const signedIn = deferredSignedInWatch();
    const unsubscribe = forgetHostTokensOnSignOut(signedIn.watch, tokens);

    signedIn.emit("user-b");
    signedIn.settleCurrent(USER_A);
    await signedIn.settled;

    expect(forget).toHaveBeenCalledTimes(1);
    expect(forget).toHaveBeenCalledWith(USER_A);
    unsubscribe();
  });

  it("does not forget a late current user already named by the change", async () => {
    const tokens = tokenSource();
    const forget = vi.spyOn(tokens, "forgetUser");
    const signedIn = deferredSignedInWatch();
    const unsubscribe = forgetHostTokensOnSignOut(signedIn.watch, tokens);

    signedIn.emit(USER_A);
    signedIn.settleCurrent(USER_A);
    await signedIn.settled;

    expect(forget).not.toHaveBeenCalled();
    unsubscribe();
  });
});
