import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { cliCredentialsPath } from "@traycer/protocol/config/paths";
import { withCredentialsLock } from "@traycer/protocol/config/credentials-lock";
import {
  createHostTokenSource,
  type HostTokenMintOutcome,
} from "../host-token-source";
import {
  createHostTokenFilePersistence,
  hostTokensPath,
} from "../host-token-file";
import {
  forgetHostTokensOnSignOut,
  type SignedInWatch,
} from "../host-token-sign-out";

const USER_A = "user-a";

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
