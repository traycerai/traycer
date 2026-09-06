import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// This module is Linux's first line of defence against the host stopping the
// CLI that just asked it to stop (see the module's own top-of-file comment).
// Every seam that could touch a real machine is stubbed: `node:os.platform`,
// `node:fs/promises.readFile` (only for `/proc/self/cgroup`), `node:child_process.spawn`,
// `isPackagedRun`, and the logger - so no test here can spawn a real
// `systemd-run`, read a real cgroup file, or append to a live `cli.log`.

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../logger", () => ({
  createCliLogger: () => loggerMock,
  errorFromUnknown: (value: unknown) =>
    value instanceof Error ? value : new Error(String(value)),
}));

const mocks = vi.hoisted(() => ({
  platform: "linux" as NodeJS.Platform,
  // `null` means "no /proc/self/cgroup interception" - readFile delegates to
  // the original implementation for every path.
  cgroup: null as string | null | { reject: true },
  packaged: false,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, platform: () => mocks.platform };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (async (
      path: Parameters<typeof actual.readFile>[0],
      options: Parameters<typeof actual.readFile>[1] | undefined,
    ) => {
      if (path === "/proc/self/cgroup") {
        if (mocks.cgroup === null) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        if (typeof mocks.cgroup === "object") {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        }
        return mocks.cgroup;
      }
      return options === undefined
        ? actual.readFile(path)
        : actual.readFile(path, options);
    }) as typeof actual.readFile,
  };
});

vi.mock("../../store/well-known-cli", () => ({
  isPackagedRun: async () => mocks.packaged,
}));

interface RecordedSpawn {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
}

const spawnMocks = vi.hoisted(() => ({
  recorded: [] as RecordedSpawn[],
  // Each queued responder decides how the fake child behaves once `spawn`
  // hands it back. `null` means "no fake child was queued" and the call
  // throws synchronously, matching a real `spawn` that cannot resolve
  // `systemd-run`.
  respond: null as ((child: EventEmitter) => void) | null,
  throwSync: null as Error | null,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (
      command: string,
      args: readonly string[],
      options: SpawnOptions,
    ): ChildProcess => {
      spawnMocks.recorded.push({ command, args, options });
      if (spawnMocks.throwSync !== null) throw spawnMocks.throwSync;
      const child = new EventEmitter() as ChildProcess;
      if (spawnMocks.respond !== null) {
        // Real `spawn` never emits synchronously - the caller has always
        // attached its listeners by the time anything fires.
        Promise.resolve().then(() => spawnMocks.respond?.(child));
      }
      return child;
    },
  };
});

const {
  findHostUnitCgroup,
  relocationArgv,
  relocateOutOfHostCgroupIfNeeded,
  assertNotInsideHostUnit,
  HOST_STOPPING_COMMANDS,
  TRAYCER_CLI_RELOCATED_ENV,
} = await import("../cgroup-relocation");

const V2_HOST_UNIT_CGROUP =
  "0::/user.slice/user-1000.slice/user@1000.service/app.slice/ai.traycer.host.service\n";

const DEV_SLOT_HOST_UNIT_CGROUP =
  "0::/user.slice/user-1000.slice/user@1000.service/app.slice/ai.traycer.host.staging.service\n";

const SCOPE_CGROUP =
  "0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-r123.scope\n";

describe("findHostUnitCgroup", () => {
  it("finds the production host unit in a v2 cgroup line", () => {
    expect(findHostUnitCgroup(V2_HOST_UNIT_CGROUP)).toEqual({
      unit: "ai.traycer.host.service",
      path: "/user.slice/user-1000.slice/user@1000.service/app.slice/ai.traycer.host.service",
    });
  });

  it("finds a dev slot's host unit (ai.traycer.host.staging.service)", () => {
    expect(findHostUnitCgroup(DEV_SLOT_HOST_UNIT_CGROUP)).toEqual({
      unit: "ai.traycer.host.staging.service",
      path: "/user.slice/user-1000.slice/user@1000.service/app.slice/ai.traycer.host.staging.service",
    });
  });

  it("returns null for a relocated scope (run-*.scope)", () => {
    expect(findHostUnitCgroup(SCOPE_CGROUP)).toBeNull();
  });

  it("finds the host unit in a hybrid machine's v1 systemd line even though the v2 line is bare", () => {
    // The unified line answers "not inside a host unit" on its own; only the
    // v1 `name=systemd` hierarchy carries the real placement here. Every
    // candidate line must be checked, not just the first.
    const hybrid = [
      "0::/",
      "1:name=systemd:/user.slice/.../ai.traycer.host.service",
    ].join("\n");
    expect(findHostUnitCgroup(hybrid)).toEqual({
      unit: "ai.traycer.host.service",
      path: "/user.slice/.../ai.traycer.host.service",
    });
  });

  it("finds a bare v1 'systemd' hierarchy (kernels that drop the name= prefix)", () => {
    expect(
      findHostUnitCgroup("2:systemd:/user.slice/ai.traycer.host.service"),
    ).toEqual({
      unit: "ai.traycer.host.service",
      path: "/user.slice/ai.traycer.host.service",
    });
  });

  it("returns null for a controller hierarchy that carries no unit placement (e.g. memory)", () => {
    expect(
      findHostUnitCgroup("3:memory:/user.slice/ai.traycer.host.service"),
    ).toBeNull();
  });

  it("returns null for empty contents", () => {
    expect(findHostUnitCgroup("")).toBeNull();
  });

  // Ablation: in `findHostUnitCgroup`, change `if (unit !== null) return { unit, path };`
  // to `return { unit, path };` unconditionally inside the loop (i.e. return
  // after the FIRST candidate line regardless of match) → the hybrid test
  // above fails because the bare `0::/` first line short-circuits before the
  // v1 `name=systemd` line is ever checked.
});

describe("relocationArgv", () => {
  it("packaged (SEA): drops the doubled binary token from argv[0..1] and keeps one", () => {
    const argv = relocationArgv({
      packaged: true,
      execPath: "/slot/traycer",
      execArgv: [],
      argv: [
        "/slot/traycer",
        "/slot/traycer",
        "host",
        "update",
        "--json",
        "--ack-nonce",
        "n",
      ],
    });
    expect(argv).toEqual([
      "/slot/traycer",
      "host",
      "update",
      "--json",
      "--ack-nonce",
      "n",
    ]);
  });

  it("interpreter: carries execPath, execArgv, and argv.slice(1)", () => {
    const argv = relocationArgv({
      packaged: false,
      execPath: "/usr/bin/node",
      execArgv: ["--import", "tsx"],
      argv: ["/usr/bin/node", "/repo/src/index.ts", "host", "update"],
    });
    expect(argv).toEqual([
      "/usr/bin/node",
      "--import",
      "tsx",
      "/repo/src/index.ts",
      "host",
      "update",
    ]);
  });

  // Ablation: in `relocationArgv`, change the packaged branch to
  // `[run.execPath, ...run.argv.slice(1)]` (the doubled binary token) → the
  // packaged test above fails: it would see `/slot/traycer` twice at the
  // front of the argv instead of once.
});

describe("relocateOutOfHostCgroupIfNeeded", () => {
  // These tests hand the module a fake launch shape by writing to `process`
  // itself. Captured once here and restored after every test: a leaked
  // `execPath` of `/slot/traycer` would follow this worker into any other
  // file that spawns something real.
  const originalArgv = process.argv;
  const originalExecPath = process.execPath;
  const originalExecArgv = process.execArgv;

  beforeEach(() => {
    mocks.platform = "linux";
    mocks.cgroup = null;
    mocks.packaged = false;
    spawnMocks.recorded = [];
    spawnMocks.respond = null;
    spawnMocks.throwSync = null;
    loggerMock.debug.mockClear();
    loggerMock.info.mockClear();
  });

  afterEach(() => {
    delete process.env[TRAYCER_CLI_RELOCATED_ENV];
    process.argv = originalArgv;
    process.execPath = originalExecPath;
    process.execArgv = originalExecArgv;
  });

  function packagedArgv(): readonly string[] {
    return [
      "/slot/traycer",
      "/slot/traycer",
      "host",
      "update",
      "--json",
      "--ack-nonce",
      "n",
    ];
  }

  it("spawns systemd-run with the exact scope args, inherited stdio, and the recursion flag, forwarding a zero exit", async () => {
    mocks.cgroup = V2_HOST_UNIT_CGROUP;
    mocks.packaged = true;
    process.argv = packagedArgv() as string[];
    process.execPath = "/slot/traycer";
    process.execArgv = [];
    spawnMocks.respond = (child) => {
      child.emit("spawn");
      child.emit("close", 0, null);
    };

    const result = await relocateOutOfHostCgroupIfNeeded("host update");

    expect(result).toEqual({ kind: "completed", exitCode: 0 });
    expect(spawnMocks.recorded).toHaveLength(1);
    const call = spawnMocks.recorded[0];
    expect(call?.command).toBe("systemd-run");
    expect(call?.args).toEqual([
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      "--",
      "/slot/traycer",
      "host",
      "update",
      "--json",
      "--ack-nonce",
      "n",
    ]);
    expect(call?.options.stdio).toBe("inherit");
    expect(call?.options.env?.[TRAYCER_CLI_RELOCATED_ENV]).toBe("1");
    // The line the CLI docs tell an operator to look for in cli.log.
    expect(loggerMock.info).toHaveBeenCalledWith(
      "relocated host-stopping command into a transient scope",
      { command: "host update", unit: "ai.traycer.host.service" },
    );
  });

  it("forwards a non-zero exit code", async () => {
    mocks.cgroup = V2_HOST_UNIT_CGROUP;
    mocks.packaged = true;
    process.argv = packagedArgv() as string[];
    process.execPath = "/slot/traycer";
    process.execArgv = [];
    spawnMocks.respond = (child) => {
      child.emit("spawn");
      child.emit("close", 3, null);
    };

    await expect(
      relocateOutOfHostCgroupIfNeeded("host update"),
    ).resolves.toEqual({ kind: "completed", exitCode: 3 });
  });

  it("treats a signal death (close code null) as exit code 1", async () => {
    mocks.cgroup = V2_HOST_UNIT_CGROUP;
    mocks.packaged = true;
    process.argv = packagedArgv() as string[];
    process.execPath = "/slot/traycer";
    process.execArgv = [];
    spawnMocks.respond = (child) => {
      child.emit("spawn");
      child.emit("close", null, "SIGKILL");
    };

    await expect(
      relocateOutOfHostCgroupIfNeeded("host update"),
    ).resolves.toEqual({ kind: "completed", exitCode: 1 });

    // Ablation: in `runInTransientScope`, change `resolve(code ?? 1)` to
    // `resolve(code ?? 0)` → this test fails (expects 1, gets 0).
  });

  it("rejects with E_SERVICE_CONTROL_FAILED when the child emits a spawn error", async () => {
    mocks.cgroup = V2_HOST_UNIT_CGROUP;
    mocks.packaged = true;
    process.argv = packagedArgv() as string[];
    process.execPath = "/slot/traycer";
    process.execArgv = [];
    spawnMocks.respond = (child) => {
      child.emit(
        "error",
        Object.assign(new Error("spawn systemd-run ENOENT"), {
          code: "ENOENT",
        }),
      );
    };

    let caught: unknown = null;
    try {
      await relocateOutOfHostCgroupIfNeeded("host update");
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "E_SERVICE_CONTROL_FAILED" });

    // Ablation: in `runInTransientScope`, change the `error` handler from
    // `reject(relocationFailed(...))` to `resolve({kind:"not-needed"})` →
    // this test fails: the call resolves instead of rejecting, and the
    // caller would go on to run the stop in the doomed cgroup.
  });

  it("does nothing and never spawns for a relocated scope cgroup (run-*.scope)", async () => {
    mocks.cgroup = SCOPE_CGROUP;
    await expect(
      relocateOutOfHostCgroupIfNeeded("host update"),
    ).resolves.toEqual({ kind: "not-needed" });
    expect(spawnMocks.recorded).toHaveLength(0);
  });

  it("does nothing for a command outside HOST_STOPPING_COMMANDS, even inside a host unit", async () => {
    mocks.cgroup = V2_HOST_UNIT_CGROUP;
    expect(HOST_STOPPING_COMMANDS.has("agent turn-ended-from-hook")).toBe(
      false,
    );
    await expect(
      relocateOutOfHostCgroupIfNeeded("agent turn-ended-from-hook"),
    ).resolves.toEqual({ kind: "not-needed" });
    expect(spawnMocks.recorded).toHaveLength(0);

    // Ablation: in `cgroup-relocation.ts`, add
    // `"agent turn-ended-from-hook"` to `HOST_STOPPING_COMMANDS` → this test
    // fails: the relocation would spawn `systemd-run` for a command that is
    // supposed to die with its host agent process.
  });

  it("does nothing when TRAYCER_CLI_RELOCATED is already set, even inside a host unit", async () => {
    mocks.cgroup = V2_HOST_UNIT_CGROUP;
    process.env[TRAYCER_CLI_RELOCATED_ENV] = "1";
    await expect(
      relocateOutOfHostCgroupIfNeeded("host update"),
    ).resolves.toEqual({ kind: "not-needed" });
    expect(spawnMocks.recorded).toHaveLength(0);
  });

  it("does nothing on a non-linux platform, and never reads /proc/self/cgroup", async () => {
    mocks.platform = "darwin";
    mocks.cgroup = V2_HOST_UNIT_CGROUP;
    await expect(
      relocateOutOfHostCgroupIfNeeded("host update"),
    ).resolves.toEqual({ kind: "not-needed" });
    expect(spawnMocks.recorded).toHaveLength(0);
  });
});

describe("assertNotInsideHostUnit", () => {
  beforeEach(() => {
    mocks.platform = "linux";
    mocks.cgroup = null;
  });

  afterEach(() => {
    delete process.env[TRAYCER_CLI_RELOCATED_ENV];
  });

  it("throws E_SERVICE_CONTROL_FAILED naming the unit, with cgroup+unit details", async () => {
    mocks.cgroup = V2_HOST_UNIT_CGROUP;
    let caught: unknown = null;
    try {
      await assertNotInsideHostUnit();
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "E_SERVICE_CONTROL_FAILED",
      details: {
        unit: "ai.traycer.host.service",
        cgroup:
          "/user.slice/user-1000.slice/user@1000.service/app.slice/ai.traycer.host.service",
      },
    });
    expect((caught as Error).message).toContain("ai.traycer.host.service");
  });

  it("resolves for a relocated scope cgroup", async () => {
    mocks.cgroup = SCOPE_CGROUP;
    await expect(assertNotInsideHostUnit()).resolves.toBeUndefined();
  });

  it("resolves when /proc/self/cgroup cannot be read", async () => {
    mocks.cgroup = { reject: true };
    await expect(assertNotInsideHostUnit()).resolves.toBeUndefined();
  });

  it("resolves on darwin even inside a host unit cgroup", async () => {
    mocks.platform = "darwin";
    mocks.cgroup = V2_HOST_UNIT_CGROUP;
    await expect(assertNotInsideHostUnit()).resolves.toBeUndefined();
  });

  it("STILL throws when TRAYCER_CLI_RELOCATED=1 and we are inside a host unit - the env flag is never evidence", async () => {
    mocks.cgroup = V2_HOST_UNIT_CGROUP;
    process.env[TRAYCER_CLI_RELOCATED_ENV] = "1";
    await expect(assertNotInsideHostUnit()).rejects.toMatchObject({
      code: "E_SERVICE_CONTROL_FAILED",
    });

    // Ablation: in `assertNotInsideHostUnit`, add an early
    // `if (process.env.TRAYCER_CLI_RELOCATED) return;` before the cgroup
    // re-read → this test fails: the guard would resolve instead of
    // throwing, defeating the entire point of the second line of defence
    // (a relocation that silently did nothing would go undetected).
  });
});
