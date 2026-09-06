import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
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
  // A string is the file's contents. `null` fails the read with ENOENT (no
  // `/proc/self/cgroup`, the supported absence case); an object names the errno
  // to fail with instead, which is how the "unreadable, so unanswerable" cases
  // are driven.
  cgroup: null as string | null | { readonly errno: string },
  packaged: false,
  // Recorded fd-3 writes from `acknowledgeRelocationEntry`.
  ackWrites: [] as { readonly fd: number; readonly payload: string }[],
  ackWriteError: null as Error | null,
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
          throw Object.assign(new Error(mocks.cgroup.errno), {
            code: mocks.cgroup.errno,
          });
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

// `acknowledgeRelocationEntry` writes to a raw fd. Stubbed so no test can write
// down whatever fd 3 happens to be in the process hosting this suite.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeSync: ((fd: number, payload: string): number => {
      mocks.ackWrites.push({ fd, payload });
      if (mocks.ackWriteError !== null) throw mocks.ackWriteError;
      return payload.length;
    }) as typeof actual.writeSync,
  };
});

interface RecordedSpawn {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
}

// The fake child, with the fd-3 ack pipe the production code reads through
// `child.stdio[3]`. `ack.write(...)` is the relocated CLI saying it reached
// `withRunner`; a responder that never writes to it is a `systemd-run` that
// died before any CLI started.
interface FakeChild {
  readonly child: ChildProcess;
  readonly ack: PassThrough;
}

const spawnMocks = vi.hoisted(() => ({
  recorded: [] as RecordedSpawn[],
  // Each queued responder drives the fake child once `spawn` has returned it.
  // A `null` responder returns a child that never emits anything, which is how
  // the "spawn threw synchronously" case is kept separate (`throwSync`).
  respond: null as ((fake: FakeChild) => void) | null,
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
      const ack = new PassThrough();
      const stdio: ChildProcess["stdio"] = [null, null, null, ack, null];
      const child = Object.assign(new EventEmitter(), {
        stdio,
      }) as ChildProcess;
      if (spawnMocks.respond !== null) {
        // Real `spawn` never emits synchronously - the caller has always
        // attached its listeners by the time anything fires.
        Promise.resolve().then(() => spawnMocks.respond?.({ child, ack }));
      }
      return child;
    },
  };
});

const {
  findHostUnitCgroup,
  relocationArgv,
  relocateOutOfHostCgroupIfNeeded,
  acknowledgeRelocationEntry,
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
    mocks.ackWrites = [];
    mocks.ackWriteError = null;
    spawnMocks.recorded = [];
    spawnMocks.respond = null;
    spawnMocks.throwSync = null;
    loggerMock.debug.mockClear();
    loggerMock.info.mockClear();
  });

  // The relocated CLI reaching `withRunner`: one byte on fd 3, the channel
  // closing behind it, and then whatever the command itself exits with. This
  // is the NODE ordering - the ack is delivered before the process is reaped.
  function acknowledgeThenExit(code: number | null): (fake: FakeChild) => void {
    return (fake) => {
      fake.child.emit("spawn");
      fake.ack.end("\n");
      setImmediate(() => fake.child.emit("exit", code, null));
    };
  }

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
    spawnMocks.respond = acknowledgeThenExit(0);

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
    // stdio 0-2 inherited so the child owns the output stream; fd 3 piped for
    // the entry acknowledgement.
    expect(call?.options.stdio).toEqual([
      "inherit",
      "inherit",
      "inherit",
      "pipe",
    ]);
    expect(call?.options.env?.[TRAYCER_CLI_RELOCATED_ENV]).toBe("1");
    // The line the CLI docs tell an operator to look for in cli.log. It is
    // written on the ACK, not on `spawn`: `systemd-run` starting proves
    // nothing about a CLI existing in the new scope.
    expect(loggerMock.info).toHaveBeenCalledWith(
      "relocated host-stopping command into a transient scope",
      { command: "host update", unit: "ai.traycer.host.service" },
    );
    // Never passed, on any systemd: the flag is rejected below 254, and the
    // `$` refusal below is what covers the versions that would expand.
    expect(
      call?.args.some((arg) => arg.startsWith("--expand-environment")),
    ).toBe(false);
  });

  it("forwards a non-zero exit code from a CLI that acknowledged - one result, no second envelope", async () => {
    mocks.cgroup = V2_HOST_UNIT_CGROUP;
    mocks.packaged = true;
    process.argv = packagedArgv() as string[];
    process.execPath = "/slot/traycer";
    process.execArgv = [];
    spawnMocks.respond = acknowledgeThenExit(3);

    // `completed`, not a rejection: the relocated CLI ran and emitted its own
    // terminal envelope, so this process forwards the code and writes nothing.
    await expect(
      relocateOutOfHostCgroupIfNeeded("host update"),
    ).resolves.toEqual({ kind: "completed", exitCode: 3 });
  });

  it("treats a signal death (close code null) after an acknowledgement as exit code 1", async () => {
    mocks.cgroup = V2_HOST_UNIT_CGROUP;
    mocks.packaged = true;
    process.argv = packagedArgv() as string[];
    process.execPath = "/slot/traycer";
    process.execArgv = [];
    spawnMocks.respond = acknowledgeThenExit(null);

    await expect(
      relocateOutOfHostCgroupIfNeeded("host update"),
    ).resolves.toEqual({ kind: "completed", exitCode: 1 });

    // Ablation: in `runInTransientScope`, change `resolve(code ?? 1)` to
    // `resolve(code ?? 0)` → this test fails (expects 1, gets 0).
  });

  it("rejects when systemd-run starts and exits WITHOUT the child ever acknowledging", async () => {
    // The failure this exists for: `systemd-run` itself runs, then fails to
    // reach a user bus or is refused its transient scope. `spawn` fires and
    // `close` carries an ordinary non-zero code, indistinguishable from the
    // command's own failure - except that no CLI ever wrote to fd 3. Without
    // the ack this resolved `completed`, the parent took `finishAndExit`, and
    // a `--json` caller got no error envelope from anyone: the relocated CLI
    // that owed it never existed.
    mocks.cgroup = V2_HOST_UNIT_CGROUP;
    mocks.packaged = true;
    process.argv = packagedArgv() as string[];
    process.execPath = "/slot/traycer";
    process.execArgv = [];
    // Exit first, then the ack channel ends carrying nothing. Only an ENDED
    // channel makes "no ack" final, so this is the ordering that proves the
    // refusal rather than merely reaching it.
    spawnMocks.respond = (fake) => {
      fake.child.emit("spawn");
      fake.child.emit("exit", 1, null);
      fake.ack.end();
    };

    await expect(
      relocateOutOfHostCgroupIfNeeded("host update"),
    ).rejects.toMatchObject({
      code: "E_SERVICE_CONTROL_FAILED",
      details: { systemdRunExitCode: 1 },
    });
    // And it is NOT reported as a successful relocation.
    expect(loggerMock.info).not.toHaveBeenCalled();

    // Ablation: in `runInTransientScope`, drop the `if (!acknowledged)` branch
    // from `settle` so it always resolves → this test fails: the call resolves
    // `{kind:"completed", exitCode:1}` and the caller silently exits 1 with no
    // error envelope, which is the bug this pin exists for.
  });

  it("resolves when the ack arrives AFTER the process exit - Bun does not drain fd 3 before it reports the child gone", async () => {
    // Bun 1.3.12 counts stdout/stderr toward its child close accounting but
    // returns the extra descriptor from `net.connect({fd})` without adding it,
    // so with stdio 0-2 inherited the process can be reported gone while fd 3
    // still holds the ack. Deciding on that report alone rejects a relocation
    // that had already acknowledged AND completed: a false "never started", a
    // second terminal envelope over the child's own, and the real exit code
    // lost. The tree and dev paths of this CLI run under Bun.
    mocks.cgroup = V2_HOST_UNIT_CGROUP;
    mocks.packaged = true;
    process.argv = packagedArgv() as string[];
    process.execPath = "/slot/traycer";
    process.execArgv = [];
    spawnMocks.respond = (fake) => {
      fake.child.emit("spawn");
      fake.child.emit("exit", 7, null);
      // The bytes were written before the child died; they are only delivered
      // to this process afterwards.
      setImmediate(() => fake.ack.end("\n"));
    };

    await expect(
      relocateOutOfHostCgroupIfNeeded("host update"),
    ).resolves.toEqual({ kind: "completed", exitCode: 7 });
    expect(loggerMock.info).toHaveBeenCalledWith(
      "relocated host-stopping command into a transient scope",
      { command: "host update", unit: "ai.traycer.host.service" },
    );

    // Ablation: in `runInTransientScope`, decide on the child's `close` event
    // alone again - `child.once("close", (code) => acknowledged ? resolve(code
    // ?? 1) : reject(relocationNeverStarted(...)))`, with the fake emitting
    // `close` in place of `exit` - → this test fails: the ack has not been
    // delivered yet at that point, so a completed command is rejected as one
    // that never started.
  });

  it("rejects with E_SERVICE_CONTROL_FAILED when the child emits a spawn error", async () => {
    mocks.cgroup = V2_HOST_UNIT_CGROUP;
    mocks.packaged = true;
    process.argv = packagedArgv() as string[];
    process.execPath = "/slot/traycer";
    process.execArgv = [];
    spawnMocks.respond = (fake) => {
      fake.child.emit(
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

    // Ablation: in `runInTransientScope`, change the `error` handler's
    // `reject(relocationFailed(...))` to `resolve(0)` → this test fails: the
    // relocation reports `{kind:"completed", exitCode:0}`, so a `systemd-run`
    // that never existed is recorded as a command that ran and succeeded.
  });

  it("resolves on a late ack without waiting for the ack channel to end", async () => {
    // Liveness, not correctness: once the byte is in hand the answer is known,
    // so nothing here depends on the channel ever ending. Both runtimes mark
    // descriptors above the explicit stdio set close-on-exec, so the child is
    // the only writer and `end` does follow its exit - but a future leak of fd
    // 3 into a long-lived grandchild would stall a decision this code can
    // already make.
    mocks.cgroup = V2_HOST_UNIT_CGROUP;
    mocks.packaged = true;
    process.argv = packagedArgv() as string[];
    process.execPath = "/slot/traycer";
    process.execArgv = [];
    spawnMocks.respond = (fake) => {
      fake.child.emit("spawn");
      fake.child.emit("exit", 0, null);
      // Written, never ended: the write end stays open.
      setImmediate(() => fake.ack.write("\n"));
    };

    await expect(
      relocateOutOfHostCgroupIfNeeded("host update"),
    ).resolves.toEqual({ kind: "completed", exitCode: 0 });
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

  it("refuses BEFORE spawning when a composed argument contains a dollar sign", async () => {
    // `host install --from '/tmp/${BUILD}/host.tar.gz'` is a supported input,
    // and on systemd 258 a scope expands it - silently reading a different
    // path, or failing because the variable is unset. `--expand-environment=no`
    // cannot be passed unconditionally (rejected below 254) and probing the
    // version would cost a process per relocation, so a `$` is refused instead
    // of being rewritten by something we do not control.
    mocks.cgroup = V2_HOST_UNIT_CGROUP;
    mocks.packaged = true;
    process.argv = [
      "/slot/traycer",
      "/slot/traycer",
      "host",
      "install",
      "--from",
      "/tmp/${BUILD}/host.tar.gz",
    ];
    process.execPath = "/slot/traycer";
    process.execArgv = [];

    await expect(
      relocateOutOfHostCgroupIfNeeded("host install"),
    ).rejects.toMatchObject({
      code: "E_SERVICE_CONTROL_FAILED",
      details: { argument: "/tmp/${BUILD}/host.tar.gz" },
    });
    // The refusal happens before anything is started.
    expect(spawnMocks.recorded).toHaveLength(0);

    // Ablation: in `relocateOutOfHostCgroupIfNeeded`, delete the
    // `assertArgvSurvivesSystemdRun(argv, commandPath, inside);` call → this
    // test fails: the relocation spawns and hands the dollar-bearing path to
    // systemd-run.
  });

  it("relocates normally when no composed argument contains a dollar sign", async () => {
    // The positive half of the refusal above - it must not reject every argv.
    mocks.cgroup = V2_HOST_UNIT_CGROUP;
    mocks.packaged = true;
    process.argv = [
      "/slot/traycer",
      "/slot/traycer",
      "host",
      "install",
      "--from",
      "/tmp/build/host.tar.gz",
    ];
    process.execPath = "/slot/traycer";
    process.execArgv = [];
    spawnMocks.respond = acknowledgeThenExit(0);

    await expect(
      relocateOutOfHostCgroupIfNeeded("host install"),
    ).resolves.toEqual({ kind: "completed", exitCode: 0 });
    expect(spawnMocks.recorded).toHaveLength(1);
  });

  it("refuses when the cgroup cannot be READ, rather than treating the failure as being outside the unit", async () => {
    // EACCES says nothing about membership. Treating it as "not inside" is
    // permission to stop: relocation is skipped, the guard passes, intent is
    // written, and the stop kills the process issuing it.
    mocks.cgroup = { errno: "EACCES" };
    await expect(
      relocateOutOfHostCgroupIfNeeded("host update"),
    ).rejects.toMatchObject({
      code: "E_SERVICE_CONTROL_FAILED",
      details: { path: "/proc/self/cgroup" },
    });
    expect(spawnMocks.recorded).toHaveLength(0);

    // Ablation: in `readHostUnitCgroup`, replace the `isMissingCgroupFile`
    // branch with a blanket `return null` → this test fails: EACCES resolves
    // `not-needed` and the command runs in the cgroup that is about to kill it.
  });

  it("treats an ABSENT /proc/self/cgroup (ENOENT, ENOTDIR) as not inside a host unit", async () => {
    // Containers, WSL without systemd, a kernel with no cgroup filesystem:
    // there is no cgroup that can kill us, which is a real answer and not a
    // failed check.
    for (const errno of ["ENOENT", "ENOTDIR"]) {
      mocks.cgroup = { errno };
      await expect(
        relocateOutOfHostCgroupIfNeeded("host update"),
      ).resolves.toEqual({ kind: "not-needed" });
    }
    expect(spawnMocks.recorded).toHaveLength(0);
  });
});

describe("acknowledgeRelocationEntry", () => {
  beforeEach(() => {
    mocks.ackWrites = [];
    mocks.ackWriteError = null;
  });

  afterEach(() => {
    delete process.env[TRAYCER_CLI_RELOCATED_ENV];
  });

  it("writes one byte to fd 3 on a relocated run", () => {
    process.env[TRAYCER_CLI_RELOCATED_ENV] = "1";
    acknowledgeRelocationEntry();
    expect(mocks.ackWrites).toEqual([{ fd: 3, payload: "\n" }]);
  });

  it("writes nothing on an ordinary run - fd 3 belongs to whoever launched us", () => {
    acknowledgeRelocationEntry();
    expect(mocks.ackWrites).toEqual([]);

    // Ablation: in `acknowledgeRelocationEntry`, drop the
    // `TRAYCER_CLI_RELOCATED` early return → this test fails, and the CLI
    // would write a stray byte into whatever fd 3 is on every ordinary run.
  });

  it("swallows a failed write - an older parent leaves no pipe on fd 3 (EBADF)", () => {
    process.env[TRAYCER_CLI_RELOCATED_ENV] = "1";
    mocks.ackWriteError = Object.assign(new Error("EBADF"), { code: "EBADF" });
    expect(() => acknowledgeRelocationEntry()).not.toThrow();
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

  it("REFUSES when /proc/self/cgroup cannot be read - an unreadable cgroup is not a negative answer", async () => {
    mocks.cgroup = { errno: "EACCES" };
    await expect(assertNotInsideHostUnit()).rejects.toMatchObject({
      code: "E_SERVICE_CONTROL_FAILED",
      details: { path: "/proc/self/cgroup" },
    });
  });

  it("resolves when /proc/self/cgroup is ABSENT (ENOENT) - nothing there can kill us", async () => {
    mocks.cgroup = { errno: "ENOENT" };
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
