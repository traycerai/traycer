import * as fsPromises from "node:fs/promises";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCredentialsMutationStore,
  CredentialsStoreUnavailableError,
  spentBaseMarkerPath,
  type CredentialsMutationStore,
  type RefreshFn,
} from "../credentials-mutation";
import {
  readCredentialsFile,
  writeCredentialsFile,
  type StoredCredentials,
} from "../credentials";
import { writeJsonFileAtomic } from "../credentials-fs";
import { digestCredentials, writeSidecarState } from "../credentials-wal";

const CREDS: StoredCredentials = {
  token: "disk-pressure-token",
  refreshToken: "disk-pressure-refresh",
  savedAt: "2026-01-01T00:00:00.000Z",
  user: { id: "u1", email: "ada@traycer.ai", name: "Ada" },
};

type Fault = {
  operation: "writeFile" | "link" | "rename" | "readFile";
  fragment: string;
  code: string;
  remaining: number;
};

const filesystemMock = vi.hoisted(() => {
  const faults: Fault[] = [];
  return {
    faults,
    onReserveWrite: null as (() => void) | null,
    reserveWritesInFlight: 0,
    syncReserveStat: false,
    takeFault(operation: Fault["operation"], path: string): Fault | null {
      const fault = faults.find(
        (candidate) =>
          candidate.operation === operation &&
          candidate.remaining > 0 &&
          (candidate.fragment.startsWith("=")
            ? path === candidate.fragment.slice(1)
            : path.includes(candidate.fragment)),
      );
      if (fault === undefined) return null;
      fault.remaining -= 1;
      return fault;
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const syncFs = await import("node:fs");
  const rejectFault = (code: string): Promise<never> =>
    Promise.reject(Object.assign(new Error(`simulated ${code}`), { code }));
  return {
    ...actual,
    writeFile: vi.fn((...args: Parameters<typeof actual.writeFile>) => {
      const path = String(args[0]);
      const fault = filesystemMock.takeFault("writeFile", path);
      if (fault !== null) return rejectFault(fault.code);
      const isReserve = path.includes(".reserve.");
      if (isReserve) filesystemMock.reserveWritesInFlight += 1;
      return actual.writeFile(...args).then(
        () => {
          if (isReserve) {
            filesystemMock.reserveWritesInFlight -= 1;
            filesystemMock.onReserveWrite?.();
          }
        },
        (error: unknown) => {
          if (isReserve) filesystemMock.reserveWritesInFlight -= 1;
          throw error;
        },
      );
    }),
    link: vi.fn((...args: Parameters<typeof actual.link>) => {
      const fault = filesystemMock.takeFault("link", String(args[1]));
      return fault === null ? actual.link(...args) : rejectFault(fault.code);
    }),
    rename: vi.fn((...args: Parameters<typeof actual.rename>) => {
      const fault = filesystemMock.takeFault("rename", String(args[1]));
      return fault === null ? actual.rename(...args) : rejectFault(fault.code);
    }),
    readFile: vi.fn((...args: Parameters<typeof actual.readFile>) => {
      const fault = filesystemMock.takeFault("readFile", String(args[0]));
      return fault === null
        ? actual.readFile(...args)
        : rejectFault(fault.code);
    }),
    stat: vi.fn((...args: Parameters<typeof actual.stat>) => {
      const path = String(args[0]);
      if (filesystemMock.syncReserveStat && path.includes(".reserve.")) {
        try {
          return Promise.resolve(syncFs.statSync(path));
        } catch (error) {
          return Promise.reject(error);
        }
      }
      return actual.stat(...args);
    }),
  };
});

function fail(
  operation: Fault["operation"],
  fragment: string,
  code: string,
  count: number,
): void {
  filesystemMock.faults.push({ operation, fragment, code, remaining: count });
}

describe("credentials store disk pressure", () => {
  let workDir: string;
  let credentialsPath: string;
  let metaPath: string;
  let lockPath: string;
  const stores: CredentialsMutationStore[] = [];
  const refreshCalls: string[] = [];
  const pressures: string[] = [];
  let onClearPressure: (() => void) | null = null;

  function makeStore(refresh: RefreshFn): CredentialsMutationStore {
    const store = createCredentialsMutationStore({
      paths: { credentialsPath, metaPath, lockPath },
      onDiskPressure: (pressure) => {
        pressures.push(pressure);
        if (pressure === "clear") onClearPressure?.();
      },
      refresh,
      lockWaitMs: 500,
      lockPollIntervalMs: 10,
      continuationRetryMs: 60_000,
    });
    stores.push(store);
    return store;
  }

  async function fillReserve(): Promise<void> {
    const ready = (): boolean =>
      filesystemMock.reserveWritesInFlight === 0 &&
      Array.from({ length: 16 }, (_, index) => {
        try {
          return (
            statSync(join(workDir, `credentials.reserve.${index}`)).size ===
            65_536
          );
        } catch {
          return false;
        }
      }).every(Boolean);
    if (ready()) return;
    await new Promise<void>((resolve) => {
      filesystemMock.onReserveWrite = () => {
        if (ready()) {
          filesystemMock.onReserveWrite = null;
          resolve();
        }
      };
    });
  }

  const refreshOk: RefreshFn = async ({ token }) => {
    refreshCalls.push(token);
    return {
      kind: "refreshed",
      token: `${token}-new`,
      refreshToken: `${token}-refresh-new`,
    };
  };

  async function seed(store: CredentialsMutationStore): Promise<void> {
    expect((await store.signIn(CREDS, false, null)).outcome).toBe("applied");
    await fillReserve();
    refreshCalls.length = 0;
    pressures.length = 0;
  }

  async function rotate(store: CredentialsMutationStore) {
    return store.rotate({
      expectedUserId: CREDS.user.id,
      expectedToken: CREDS.token,
      refreshTokenOverride: null,
      signal: null,
    });
  }

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "traycer-cred-pressure-"));
    credentialsPath = join(workDir, "credentials");
    metaPath = join(workDir, "credentials.meta.json");
    lockPath = join(workDir, "credentials.lock");
    filesystemMock.faults.length = 0;
    filesystemMock.syncReserveStat = false;
    filesystemMock.onReserveWrite = null;
    filesystemMock.reserveWritesInFlight = 0;
  });

  afterEach(() => {
    for (const store of stores) store.dispose();
    stores.length = 0;
    filesystemMock.faults.length = 0;
    refreshCalls.length = 0;
    pressures.length = 0;
    onClearPressure = null;
    filesystemMock.syncReserveStat = false;
    filesystemMock.onReserveWrite = null;
    filesystemMock.reserveWritesInFlight = 0;
    vi.useRealTimers();
    vi.clearAllMocks();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("creates private reserve files when the store starts", async () => {
    makeStore(refreshOk);
    await fillReserve();

    const firstPiece = statSync(join(workDir, "credentials.reserve.0"));
    expect(firstPiece.size).toBe(65_536);
    if (process.platform !== "win32") {
      expect(firstPiece.mode & 0o777).toBe(0o600);
    }
    expect(pressures).toEqual([]);
  });

  it("does not write or probe when every reserve piece already exists at full size", async () => {
    for (let index = 0; index < 16; index += 1) {
      writeFileSync(
        join(workDir, `credentials.reserve.${index}`),
        Buffer.alloc(65_536, 0x5a),
        { mode: 0o600 },
      );
    }
    filesystemMock.syncReserveStat = true;
    vi.useFakeTimers({ toFake: ["setImmediate", "clearImmediate"] });
    const writeSpy = vi.mocked(fsPromises.writeFile);
    writeSpy.mockClear();

    makeStore(refreshOk);
    await vi.runAllTimersAsync();

    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("probes and replaces a short reserve piece while leaving full pieces intact", async () => {
    for (let index = 0; index < 16; index += 1) {
      writeFileSync(
        join(workDir, `credentials.reserve.${index}`),
        Buffer.alloc(65_536, 0x5a),
        { mode: 0o600 },
      );
    }
    writeFileSync(join(workDir, "credentials.reserve.7"), Buffer.alloc(1), {
      mode: 0o600,
    });
    filesystemMock.syncReserveStat = true;
    vi.useFakeTimers({ toFake: ["setImmediate", "clearImmediate"] });
    const reserveWrite = new Promise<void>((resolve) => {
      filesystemMock.onReserveWrite = resolve;
    });
    const writeSpy = vi.mocked(fsPromises.writeFile);
    writeSpy.mockClear();

    makeStore(refreshOk);
    await vi.runAllTimersAsync();
    await reserveWrite;

    expect(statSync(join(workDir, "credentials.reserve.7")).size).toBe(65_536);
    expect(
      writeSpy.mock.calls.filter((call) =>
        String(call[0]).includes(".space-check."),
      ).length,
    ).toBe(1);
    expect(
      writeSpy.mock.calls.filter((call) =>
        String(call[0]).includes(".reserve."),
      ).length,
    ).toBe(1);
  });

  it.each(["ENOSPC", "EDQUOT"] as const)(
    "releases one reserve piece and retries a lock write on %s",
    async (code) => {
      const store = makeStore(refreshOk);
      await seed(store);
      fail("writeFile", ".lock.", code, 1);

      const result = await rotate(store);

      expect(result.outcome).toBe("applied");
      expect(result.diskPressure).toBe("low");
      expect(refreshCalls).toEqual([CREDS.token]);
      expect(pressures).toEqual(["low"]);
      expect((await readCredentialsFile(credentialsPath))?.token).toBe(
        `${CREDS.token}-new`,
      );
      expect(
        readdirSync(workDir).filter((name) =>
          name.startsWith("credentials.reserve."),
        ),
      ).toHaveLength(15);
    },
  );

  it("does not retry a permission failure on the lock write", async () => {
    const store = makeStore(refreshOk);
    await seed(store);
    fail("writeFile", ".lock.", "EACCES", 1);

    await expect(rotate(store)).rejects.toMatchObject({ code: "EACCES" });

    expect(filesystemMock.faults[0].remaining).toBe(0);
    expect(refreshCalls).toEqual([]);
  });

  it("saves after releasing a reserve piece for a commit write", async () => {
    const store = makeStore(refreshOk);
    await seed(store);
    fail("writeFile", "credentials.meta.json", "ENOSPC", 1);

    const result = await rotate(store);

    expect(result.outcome).toBe("applied");
    expect(result.diskPressure).toBe("low");
    expect((await readCredentialsFile(credentialsPath))?.token).toBe(
      `${CREDS.token}-new`,
    );
    expect(pressures).toEqual(["low"]);
  });

  it("retries a no-space rename after renewal and commits the pair", async () => {
    const store = makeStore(refreshOk);
    await seed(store);
    fail("rename", `=${credentialsPath}`, "ENOSPC", 1);

    const result = await rotate(store);

    expect(result.outcome).toBe("applied");
    expect(result.diskPressure).toBe("low");
    expect((await readCredentialsFile(credentialsPath))?.token).toBe(
      `${CREDS.token}-new`,
    );
  });

  it("returns disk-full without requesting renewal when the probe exhausts the reserve", async () => {
    const store = makeStore(refreshOk);
    await seed(store);
    fail("writeFile", ".space-check.", "ENOSPC", 17);

    const result = await rotate(store);

    expect(result).toMatchObject({
      outcome: "disk-full",
      credentials: null,
      rejection: null,
      diskPressure: "low",
    });
    expect(refreshCalls).toEqual([]);
    expect(pressures).toEqual(["low"]);
  });

  it("returns disk-full when lock linking exhausts the reserve before renewal", async () => {
    const store = makeStore(refreshOk);
    await seed(store);
    fail("link", lockPath, "ENOSPC", 17);

    const result = await rotate(store);

    expect(result.outcome).toBe("disk-full");
    expect(refreshCalls).toEqual([]);
    expect(result.diskPressure).toBe("low");
  });

  it("returns disk-full when the lock temporary write exhausts the reserve before renewal", async () => {
    const store = makeStore(refreshOk);
    await seed(store);
    fail("writeFile", ".lock.", "ENOSPC", 17);

    const result = await rotate(store);

    expect(result.outcome).toBe("disk-full");
    expect(refreshCalls).toEqual([]);
    expect(result.diskPressure).toBe("low");
  });

  it("returns disk-full with no refresh when the spent-base marker exhausts the reserve", async () => {
    const store = makeStore(refreshOk);
    await seed(store);
    fail("writeFile", "pending-spend.json", "ENOSPC", 17);

    const result = await rotate(store);

    expect(result.outcome).toBe("disk-full");
    expect(refreshCalls).toEqual([]);
    expect(result.diskPressure).toBe("low");
    expect(existsSync(spentBaseMarkerPath(credentialsPath))).toBe(false);
  });

  it("returns disk-full when recovering an earlier pending save exhausts the reserve", async () => {
    const store = makeStore(refreshOk);
    await writeCredentialsFile(credentialsPath, CREDS, 0);
    await writeSidecarState(metaPath, {
      epoch: 0,
      lastMutation: null,
      mtimeFloorMs: 0,
      pending: {
        op: "rotate",
        nextEpoch: 0,
        targetDigest: digestCredentials(CREDS),
        floorCandidate: 0,
      },
    });
    await fillReserve();
    fail("writeFile", "credentials.meta.json", "ENOSPC", 17);

    const result = await rotate(store);

    expect(result.outcome).toBe("disk-full");
    expect(refreshCalls).toEqual([]);
    expect(result.diskPressure).toBe("low");
  });

  it("keeps the OS error code on an unavailable marker read", async () => {
    const store = makeStore(refreshOk);
    await seed(store);
    fail("readFile", `=${spentBaseMarkerPath(credentialsPath)}`, "EACCES", 1);

    await expect(rotate(store)).rejects.toMatchObject({
      code: "EACCES",
      cause: expect.objectContaining({ code: "EACCES" }),
    } satisfies Partial<CredentialsStoreUnavailableError>);
    expect(refreshCalls).toEqual([]);
    expect(filesystemMock.faults[0].remaining).toBe(0);
  });

  it("reports clear only after a clean credential save", async () => {
    const store = makeStore(refreshOk);

    const result = await store.signIn(CREDS, false, null);

    expect(result.diskPressure).toBe("clear");
    expect(pressures).toEqual(["clear"]);
    await fillReserve();

    pressures.length = 0;
    const deleted = await store.signOut(null);
    expect(deleted.diskPressure).toBeNull();
    expect(pressures).toEqual([]);
  });

  it("keeps rotate preflight probing while a full-reserve refill does no extra probe or write", async () => {
    for (let index = 0; index < 16; index += 1) {
      writeFileSync(
        join(workDir, `credentials.reserve.${index}`),
        Buffer.alloc(65_536, 0x5a),
        { mode: 0o600 },
      );
    }
    filesystemMock.syncReserveStat = true;
    vi.useFakeTimers({ toFake: ["setImmediate", "clearImmediate"] });
    const store = makeStore(refreshOk);
    await vi.runAllTimersAsync();
    expect((await store.signIn(CREDS, false, null)).outcome).toBe("applied");
    await vi.runAllTimersAsync();
    const writeSpy = vi.mocked(fsPromises.writeFile);
    writeSpy.mockClear();

    const result = await rotate(store);
    await vi.runAllTimersAsync();

    expect(result.outcome).toBe("applied");
    expect(
      writeSpy.mock.calls.filter((call) =>
        String(call[0]).includes(".space-check."),
      ).length,
    ).toBe(1);
    expect(
      writeSpy.mock.calls.filter((call) =>
        String(call[0]).includes(".reserve."),
      ).length,
    ).toBe(0);
  });

  it("lets concurrent stores release reserve pieces without failing either operation", async () => {
    const storeA = makeStore(refreshOk);
    await seed(storeA);
    const storeB = makeStore(refreshOk);
    fail("writeFile", ".space-check.", "ENOSPC", 2);

    const results = await Promise.all([rotate(storeA), rotate(storeB)]);

    expect(results.map((result) => result.outcome)).toContain("applied");
    expect(results.some((result) => result.diskPressure === "low")).toBe(true);
    expect(refreshCalls).toHaveLength(1);
  });

  it("does not refill after a no-space commit failure and preserves the pending pair", async () => {
    const store = makeStore(refreshOk);
    await seed(store);
    fail("writeFile", "credentials.meta.json", "ENOSPC", 17);

    const result = await rotate(store);

    expect(result.outcome).toBe("commit-failed");
    expect(result.diskPressure).toBe("low");
    expect(result.credentials?.token).toBe(`${CREDS.token}-new`);
    expect(store.hasPendingContinuation()).toBe(true);
    expect(existsSync(spentBaseMarkerPath(credentialsPath))).toBe(true);
    expect(pressures).toEqual(["low"]);
    expect(
      readdirSync(workDir).filter((name) =>
        name.startsWith("credentials.reserve."),
      ),
    ).toHaveLength(0);
  });

  it.each([".space-check.", ".lock."])(
    "preserves a spent continuation when a later pre-request write fails at %s",
    async (fragment) => {
      const store = makeStore(refreshOk);
      await seed(store);
      fail("writeFile", "credentials.meta.json", "ENOSPC", 17);
      const first = await rotate(store);
      expect(first.outcome).toBe("commit-failed");
      const markerPath = spentBaseMarkerPath(credentialsPath);
      const markerBefore = readFileSync(markerPath, "utf8");
      pressures.length = 0;
      fail("writeFile", fragment, "ENOSPC", 1);

      const second = await rotate(store);

      expect(second.outcome).toBe("commit-failed");
      expect(second.credentials?.token).toBe(first.credentials?.token);
      expect(second.diskPressure).toBe("low");
      expect(readFileSync(markerPath, "utf8")).toBe(markerBefore);
      expect(pressures).toEqual(["low"]);
      expect(refreshCalls).toEqual([CREDS.token]);
    },
  );

  it("reports clear from the background continuation after the full save lands", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const store = makeStore(refreshOk);
    await seed(store);
    const clearEvent = new Promise<void>((resolve) => {
      onClearPressure = resolve;
    });
    fail("writeFile", "credentials.meta.json", "ENOSPC", 17);
    const first = await rotate(store);
    expect(first.outcome).toBe("commit-failed");
    expect(pressures).toEqual(["low"]);

    await vi.advanceTimersByTimeAsync(60_000);
    await clearEvent;

    expect(store.hasPendingContinuation()).toBe(false);
    expect(pressures).toEqual(["low", "clear"]);
  });

  it("passes flush:true through both atomic writer seams", async () => {
    const writeSpy = vi.mocked(fsPromises.writeFile);
    await writeCredentialsFile(join(workDir, "credentials"), CREDS, 0);
    await writeJsonFileAtomic(join(workDir, "state.json"), { ok: true }, 0o600);

    const options = writeSpy.mock.calls.map((call) => call[2]);
    expect(
      options.filter(
        (option) =>
          option !== undefined &&
          typeof option === "object" &&
          "flush" in option &&
          option.flush === true,
      ),
    ).toHaveLength(2);
  });
});
