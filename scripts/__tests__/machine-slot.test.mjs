// Tests for scripts/machine-slot.sh, the machine-wide counted semaphore used
// by the local pre-commit hooks (both this repo's and the internal
// monorepo's) to bound how many memory-heavy type-checks run at once.
//
// Every test gets a fresh TRAYCER_MACHINE_SLOT_DIR (a mkdtemp'd directory) so
// runs never contend with each other or with a real developer's lock files.
// Concurrency is driven with async `spawn`, never `spawnSync`, because these
// tests need two (or more) of the script's invocations alive at once.

import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = join(HERE, "..", "machine-slot.sh");

// A tiny inline shell body, run as `bash -c BODY _ <label> <sleepSeconds>`,
// that appends a start/end marker line to $LOGFILE around a sleep. Line
// order in the (append-only, small-write-atomic) log file is the proxy for
// wall-clock order: two runs contending for one slot cannot interleave their
// start/end pairs, and two runs holding separate slots can.
const MARKER_BODY =
  'printf "start:%s\\n" "$1" >> "$LOGFILE"; sleep "$2"; printf "end:%s\\n" "$1" >> "$LOGFILE"';

function markerCommand(label, sleepSeconds) {
  return ["bash", "-c", MARKER_BODY, "_", label, String(sleepSeconds)];
}

/** process.env with every TRAYCER_MACHINE_SLOT* variable stripped. Tests
 * spread this (never process.env directly) into a spawned child's env before
 * applying their own overrides, so a developer running these tests from
 * inside a hook - where TRAYCER_MACHINE_SLOT_HELD_commit_checks=1 or a
 * TRAYCER_MACHINE_SLOTS override is already exported - can't change the
 * behaviour under test. */
function baseEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("TRAYCER_MACHINE_SLOT")) {
      env[key] = value;
    }
  }
  return env;
}

/** Spawn one `machine-slot.sh` invocation. Returns the live child plus a
 * promise that resolves once it exits. */
function runSlot(args, env) {
  const child = spawn("/bin/bash", [SCRIPT, ...args], {
    env: { ...baseEnv(), ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const done = new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}

function readLogLines(logFile) {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

/** Finds and SIGKILLs any process whose command line mentions `needle`
 * (typically a test's unique slot directory). Used to reap a holder that a
 * test deliberately orphaned - the startup-race test's run against a
 * reverted copy is the one case that can leave one spinning forever. */
function killLeftoverProcessesForDir(needle) {
  let output = "";
  try {
    output = execFileSync("pgrep", ["-f", needle], { encoding: "utf8" });
  } catch {
    // pgrep exits non-zero when nothing matches (or isn't installed) -
    // either way, nothing to clean up.
    return;
  }
  for (const pid of output
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => Number.parseInt(line, 10))) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** Where machine_slot__dir() falls back to when TRAYCER_MACHINE_SLOT_DIR is
 * unset: macOS's per-user confstr temp dir, else XDG_RUNTIME_DIR, else
 * ~/.cache. Mirrors the script's own fallback order so a test can find (and
 * clean up) a lock file the script created there. */
function realMachineSlotDir() {
  if (process.platform === "darwin") {
    try {
      const darwinTemp = execFileSync("getconf", ["DARWIN_USER_TEMP_DIR"], {
        encoding: "utf8",
      }).trim();
      if (darwinTemp !== "") return darwinTemp.replace(/\/$/, "");
    } catch {
      // fall through to the other fallbacks
    }
  }
  if (
    process.env.XDG_RUNTIME_DIR !== undefined &&
    existsSync(process.env.XDG_RUNTIME_DIR)
  ) {
    return process.env.XDG_RUNTIME_DIR;
  }
  return join(process.env.HOME ?? "", ".cache");
}

let dirsToClean;
let pidsToKill;

beforeEach(() => {
  dirsToClean = [];
  pidsToKill = [];
});

afterEach(() => {
  for (const pid of pidsToKill) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const dir of dirsToClean) {
    killLeftoverProcessesForDir(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function freshSlotDir() {
  const dir = mkdtempSync(join(tmpdir(), "machine-slot-"));
  dirsToClean.push(dir);
  return dir;
}

describe("machine-slot.sh executable mode", () => {
  it("serializes two concurrent runs when only 1 slot is available", async () => {
    const dir = freshSlotDir();
    const logFile = join(dir, "log.txt");
    const env = { TRAYCER_MACHINE_SLOT_DIR: dir, LOGFILE: logFile };

    const a = runSlot(["serialize", "1", ...markerCommand("A", "0.3")], env);
    const b = runSlot(["serialize", "1", ...markerCommand("B", "0.3")], env);
    const [ra, rb] = await Promise.all([a.done, b.done]);

    expect(ra.code, ra.stderr).toBe(0);
    expect(rb.code, rb.stderr).toBe(0);

    const lines = readLogLines(logFile);
    expect(lines).toHaveLength(4);
    // Whichever run acquired the slot first must fully finish (start+end)
    // before the other run's start line appears at all.
    const first = lines[0].endsWith(":A") ? "A" : "B";
    const second = first === "A" ? "B" : "A";
    expect(lines).toEqual([
      `start:${first}`,
      `end:${first}`,
      `start:${second}`,
      `end:${second}`,
    ]);
  }, 8000);

  it("lets two concurrent runs overlap when 2 slots are available", async () => {
    const dir = freshSlotDir();
    const logFile = join(dir, "log.txt");
    const env = { TRAYCER_MACHINE_SLOT_DIR: dir, LOGFILE: logFile };

    const a = runSlot(["overlap", "2", ...markerCommand("A", "0.3")], env);
    const b = runSlot(["overlap", "2", ...markerCommand("B", "0.3")], env);
    const [ra, rb] = await Promise.all([a.done, b.done]);

    expect(ra.code, ra.stderr).toBe(0);
    expect(rb.code, rb.stderr).toBe(0);

    const lines = readLogLines(logFile);
    expect(lines).toHaveLength(4);
    // Both slots free means both starts land before either end: the first
    // two lines are the two starts, the last two are the two ends.
    expect(new Set(lines.slice(0, 2))).toEqual(new Set(["start:A", "start:B"]));
    expect(new Set(lines.slice(2, 4))).toEqual(new Set(["end:A", "end:B"]));
  }, 8000);

  it("does not keep the slot held by an orphaned background process the command spawned", async () => {
    const dir = freshSlotDir();
    const orphanPidFile = join(dir, "orphan.pid");
    const env = {
      TRAYCER_MACHINE_SLOT_DIR: dir,
      ORPHAN_PID_FILE: orphanPidFile,
    };

    // The command backgrounds a long-lived grandchild and returns
    // immediately. The grandchild is not a child of the holder process, so
    // it must not be able to keep the flock taken after the command exits.
    const spawnOrphan = runSlot(
      [
        "orphan",
        "1",
        "bash",
        "-c",
        // Detached stdio: an orphan holding the wrapper's pipes would delay
        // its `close` event until the orphan exits, and by then a leaked
        // lock fd would already be gone - the test could not see the bug.
        'sleep 30 </dev/null >/dev/null 2>&1 & echo $! > "$ORPHAN_PID_FILE"; exit 0',
      ],
      env,
    );
    const spawnResult = await spawnOrphan.done;
    expect(spawnResult.code, spawnResult.stderr).toBe(0);

    const orphanPid = Number.parseInt(
      readFileSync(orphanPidFile, "utf8").trim(),
      10,
    );
    expect(Number.isInteger(orphanPid)).toBe(true);
    pidsToKill.push(orphanPid);

    // A follow-up run for the SAME single slot must acquire promptly - while
    // the orphan is still sleeping - because the slot was
    // released when the command (not the orphan) exited. A generous
    // TRAYCER_MACHINE_SLOT_TIMEOUT is only a safety net so a regression fails
    // fast instead of hanging this test for 1800s.
    const startedAt = Date.now();
    const follow = runSlot(["orphan", "1", "true"], {
      ...env,
      TRAYCER_MACHINE_SLOT_TIMEOUT: "5",
    });
    const followResult = await follow.done;
    const elapsedMs = Date.now() - startedAt;

    expect(followResult.code, followResult.stderr).toBe(0);
    expect(elapsedMs).toBeLessThan(1500);
    // The orphan outlived the acquisition, so the prompt acquire above is
    // evidence it held nothing - not that it had already exited.
    expect(() => process.kill(orphanPid, 0)).not.toThrow();
  }, 10000);

  it("releases the slot promptly when the wrapper shell is SIGKILLed", async () => {
    const dir = freshSlotDir();
    const env = { TRAYCER_MACHINE_SLOT_DIR: dir };

    const holder = runSlot(["killed", "1", "sleep", "3"], env);
    pidsToKill.push(holder.child.pid);
    // Uncontended flock acquisition is near-instant; this just gives the
    // holder process time to actually take it before it gets killed.
    await new Promise((resolve) => setTimeout(resolve, 300));
    holder.child.kill("SIGKILL");

    const startedAt = Date.now();
    const follow = runSlot(["killed", "1", "true"], {
      ...env,
      TRAYCER_MACHINE_SLOT_TIMEOUT: "5",
    });
    const followResult = await follow.done;
    const elapsedMs = Date.now() - startedAt;

    expect(followResult.code, followResult.stderr).toBe(0);
    expect(elapsedMs).toBeLessThan(1500);
  }, 8000);

  it("still runs the command past the wait timeout, with a warning that it ran without a slot", async () => {
    const dir = freshSlotDir();
    const env = { TRAYCER_MACHINE_SLOT_DIR: dir };

    const holder = runSlot(["timeout-test", "1", "sleep", "2.5"], env);
    // Give the holder a head start so the second run genuinely contends
    // instead of racing it for the uncontended lock.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const waiter = runSlot(["timeout-test", "1", "echo", "ran-without-slot"], {
      ...env,
      TRAYCER_MACHINE_SLOT_TIMEOUT: "1",
    });

    const [holderResult, waiterResult] = await Promise.all([
      holder.done,
      waiter.done,
    ]);

    expect(holderResult.code, holderResult.stderr).toBe(0);
    expect(waiterResult.code, waiterResult.stderr).toBe(0);
    expect(waiterResult.stdout).toContain("ran-without-slot");
    expect(waiterResult.stderr).toMatch(/running without one/);
  }, 8000);

  it("does not hold the slot when the parent shell dies while python3 is still starting up", async () => {
    // Regression for: a holder process used to read its OWN os.getppid() as
    // "the parent" at whatever moment its Python interpreter got around to
    // starting. If the wrapper shell was SIGKILLed before that moment, the
    // now-orphaned holder was already reparented (to pid 1, or a subreaper)
    // by the time it checked - so it captured the wrong "parent", and its
    // `while os.getppid() == parent` hold-loop then ran forever because that
    // condition stayed true. The fix passes the real parent pid as argv and
    // checks it immediately, before any other work, so a holder that starts
    // after its true parent is already gone exits right away instead of
    // ever taking the lock.
    //
    // To exercise the race deterministically, a shim `python3` placed first
    // on PATH delays exactly the holder's own invocation (identified by its
    // argument count - the "does fcntl exist" probe earlier in
    // machine_slot_acquire is a much shorter argv and passes straight
    // through) long enough that the wrapper shell can be killed before the
    // real python3 ever runs.
    const dir = freshSlotDir();
    const shimDir = mkdtempSync(join(tmpdir(), "machine-slot-python-shim-"));
    dirsToClean.push(shimDir);

    const realPython3 = execFileSync("which", ["python3"], {
      encoding: "utf8",
    }).trim();
    expect(realPython3).not.toBe("");

    const shimPath = join(shimDir, "python3");
    writeFileSync(
      shimPath,
      [
        "#!/bin/bash",
        // Only the holder's own invocation (-c, the script, then dir, name,
        // slots, timeout, status_file, parent, admit, meminfo -> 10 args
        // total) has more than 3 arguments; the `python3 -c 'import fcntl'`
        // capability probe has 2.
        'if [ "$1" = "-c" ] && [ "$#" -gt 3 ]; then',
        "    sleep 0.6",
        "fi",
        `exec "${realPython3}" "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(shimPath, 0o755);

    // Defaults to the real script. Point MACHINE_SLOT_SCRIPT at a copy with
    // the startup parent check removed to watch this test go red.
    const script = process.env.MACHINE_SLOT_SCRIPT ?? SCRIPT;
    const slotEnv = {
      TRAYCER_MACHINE_SLOT_DIR: dir,
      PATH: `${shimDir}:${process.env.PATH}`,
    };

    const holder = spawn(
      "/bin/bash",
      [script, "f1-regression", "1", "sleep", "5"],
      { env: { ...baseEnv(), ...slotEnv } },
    );
    pidsToKill.push(holder.pid);

    // Kill the wrapper while the shim is still sleeping, well before it
    // execs the real python3 - this is what reparents the not-yet-started
    // python3 before it ever gets to read its own parent.
    await new Promise((resolve) => setTimeout(resolve, 200));
    holder.kill("SIGKILL");

    // Give the shim time to finish its 0.6s sleep, exec the real python3,
    // and (on the fix) exit immediately once it notices its parent is gone
    // - so that by the time the follow-up starts, a buggy build has already
    // had the chance to latch onto the flock forever, and a fixed build has
    // already exited without ever touching it.
    await new Promise((resolve) => setTimeout(resolve, 800));

    const followStartedAt = Date.now();
    const follow = runSlot(["f1-regression", "1", "true"], {
      TRAYCER_MACHINE_SLOT_DIR: dir,
      TRAYCER_MACHINE_SLOT_TIMEOUT: "3",
    });
    const followResult = await follow.done;
    const elapsedMs = Date.now() - followStartedAt;

    expect(followResult.code, followResult.stderr).toBe(0);
    expect(followResult.stderr).not.toMatch(/running without one/);
    expect(elapsedMs).toBeLessThan(2000);
  }, 10000);

  it("still runs the command when the lock file's path cannot be opened (existing symlink, O_NOFOLLOW)", async () => {
    const dir = freshSlotDir();
    // The holder opens with O_NOFOLLOW: a lock path that is itself an
    // existing symlink makes os.open fail with ELOOP, exactly as if the
    // path were untrustworthy or unwritable for some other reason.
    symlinkSync(
      "/nonexistent-target-for-machine-slot-test",
      join(dir, "traycer-slot-symlink-test.0.lock"),
    );

    const { done } = runSlot(
      ["symlink-test", "1", "bash", "-c", "echo ran; exit 3"],
      { TRAYCER_MACHINE_SLOT_DIR: dir },
    );
    const result = await done;

    expect(result.code).toBe(3);
    expect(result.stdout).toContain("ran");
    expect(result.stderr).toMatch(/cannot open .*running without a slot/);
  }, 8000);

  it("does not depend on TMPDIR for its lock directory", async () => {
    const privateTmp = mkdtempSync(
      join(tmpdir(), "machine-slot-private-tmpdir-"),
    );
    dirsToClean.push(privateTmp);

    const slotName = `tmpdir-independence-${process.pid}-${Date.now()}`;
    const realDir = realMachineSlotDir();
    const realLockFile = join(realDir, `traycer-slot-${slotName}.0.lock`);

    try {
      const { done } = runSlot([slotName, "1", "true"], {
        TMPDIR: privateTmp,
      });
      const result = await done;
      expect(result.code, result.stderr).toBe(0);

      expect(
        existsSync(join(privateTmp, `traycer-slot-${slotName}.0.lock`)),
      ).toBe(false);
      // It should have gone to the real (non-TMPDIR) fallback instead.
      expect(existsSync(realLockFile)).toBe(true);
    } finally {
      rmSync(realLockFile, { force: true });
    }
  }, 8000);

  it("propagates the command's exit status", async () => {
    const dir = freshSlotDir();
    const env = { TRAYCER_MACHINE_SLOT_DIR: dir };

    const { done } = runSlot(["exit-status", "1", "bash", "-c", "exit 7"], env);
    const result = await done;

    expect(result.code).toBe(7);
  });

  it("does not deadlock when a nested invocation for the same name inherits re-entrancy", async () => {
    const dir = freshSlotDir();
    const env = { TRAYCER_MACHINE_SLOT_DIR: dir, SLOT_SCRIPT: SCRIPT };

    // Source the helper directly (sourced mode) rather than the executable
    // mode used above: acquire once, then spawn a CHILD bash process that
    // also sources it and acquires the same name. The child inherits the
    // exported TRAYCER_MACHINE_SLOT_HELD_<name> from the parent's acquire,
    // so it must return immediately instead of contending with its own
    // parent for a lock the parent already holds (which would deadlock:
    // slots=1 and the parent's holder never releases until the parent
    // exits, which is waiting on the child).
    const body = [
      "set -e",
      '. "$SLOT_SCRIPT"',
      "machine_slot_acquire nested 1",
      "child_output=$(bash -c '. \"$SLOT_SCRIPT\"; machine_slot_acquire nested 1; echo child-ok')",
      'echo "parent-ok:$child_output"',
    ].join("\n");

    const child = spawn("/bin/bash", ["-c", body], {
      env: { ...baseEnv(), ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const result = await new Promise((resolve) => {
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("parent-ok:child-ok");
  }, 5000);

  it("creates one lock file per slot for TRAYCER_MACHINE_SLOTS=2", async () => {
    const dir = freshSlotDir();
    const { done } = runSlot(["count-two", "auto", "true"], {
      TRAYCER_MACHINE_SLOT_DIR: dir,
      TRAYCER_MACHINE_SLOTS: "2",
    });
    const result = await done;
    expect(result.code, result.stderr).toBe(0);

    const entries = readdirSync(dir);
    expect(entries).toContain("traycer-slot-count-two.0.lock");
    expect(entries).toContain("traycer-slot-count-two.1.lock");
    expect(entries).not.toContain("traycer-slot-count-two.2.lock");
  });

  it("falls back to auto (without failing) for an invalid slot count", async () => {
    const dir = freshSlotDir();
    const { done } = runSlot(["invalid-count", "abc", "true"], {
      TRAYCER_MACHINE_SLOT_DIR: dir,
    });
    const result = await done;

    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toMatch(
      /ignoring invalid slot count 'abc'; using auto/,
    );
  });
});

// `auto` has a pool (one slot file per 16 GiB of MemTotal) and an admission
// check, first come first served (a free file is only taken while nothing else
// is held, or while MemAvailable is at least 16 GiB plus 12 GiB for every held
// slot file). TRAYCER_MACHINE_SLOT_MEMINFO is a test-only seam
// that points both at a fake meminfo file, so these cases do not depend on the
// memory of the machine running them. The fake values are above 32 GiB so the
// pool differs from what a 16 GB CI runner would report for itself.
const KIB_PER_GIB = 1024 * 1024;

function meminfoText({ totalGib, availableGib }) {
  const lines = [`MemTotal:       ${totalGib * KIB_PER_GIB} kB`];
  lines.push(`MemFree:        ${KIB_PER_GIB} kB`);
  if (availableGib !== undefined) {
    lines.push(`MemAvailable:   ${availableGib * KIB_PER_GIB} kB`);
  }
  lines.push("Buffers:        1024 kB", "Cached:         4096 kB");
  return `${lines.join("\n")}\n`;
}

/** Writes (or atomically rewrites, so a polling reader never sees a half
 * file) a fake meminfo and returns its path. */
function writeMeminfo(dir, values) {
  const path = join(dir, "meminfo");
  const staging = `${path}.tmp`;
  writeFileSync(staging, meminfoText(values));
  renameSync(staging, path);
  return path;
}

/** Sources the script and prints what machine_slot__count returns for
 * `requested`, with a fake meminfo (and optionally the override) applied. */
function slotCount(requested, env) {
  return execFileSync(
    "/bin/bash",
    ["-c", `. "$1"; machine_slot__count "$2"`, "_", SCRIPT, requested],
    { env: { ...baseEnv(), ...env }, encoding: "utf8", timeout: 5000 },
  ).trim();
}

async function waitForLine(logFile, line) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (readLogLines(logFile).includes(line)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${line}`);
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isTicket = (name) => name.includes(".wait.");

async function waitForFiles(dir, predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate(readdirSync(dir))) return;
    await pause(50);
  }
  throw new Error(`timed out waiting on the contents of ${dir}`);
}

describe("machine_slot__count auto pool", () => {
  it("sizes the pool from MemTotal, one slot file per 16 GiB, whatever is available", () => {
    const dir = freshSlotDir();
    for (const [totalGib, availableGib, expected] of [
      [96, 20, "6"],
      [96, 90, "6"],
      [62, 5, "3"],
      [48, 1, "3"],
    ]) {
      const meminfo = writeMeminfo(dir, { totalGib, availableGib });
      expect(
        slotCount("auto", { TRAYCER_MACHINE_SLOT_MEMINFO: meminfo }),
        `${totalGib} GiB total, ${availableGib} GiB available`,
      ).toBe(expected);
    }
  });

  it("still sizes the pool from MemTotal when the kernel reports no MemAvailable", () => {
    const meminfo = writeMeminfo(freshSlotDir(), { totalGib: 33 });
    expect(slotCount("auto", { TRAYCER_MACHINE_SLOT_MEMINFO: meminfo })).toBe(
      "2",
    );
  });

  it("never goes below one slot file", () => {
    const meminfo = writeMeminfo(freshSlotDir(), {
      totalGib: 8,
      availableGib: 2,
    });
    expect(slotCount("auto", { TRAYCER_MACHINE_SLOT_MEMINFO: meminfo })).toBe(
      "1",
    );
  });

  it("lets TRAYCER_MACHINE_SLOTS win over the pool", () => {
    const meminfo = writeMeminfo(freshSlotDir(), {
      totalGib: 96,
      availableGib: 20,
    });
    expect(
      slotCount("auto", {
        TRAYCER_MACHINE_SLOT_MEMINFO: meminfo,
        TRAYCER_MACHINE_SLOTS: "2",
      }),
    ).toBe("2");
  });

  it("reads a MemTotal with leading zeros as decimal, not octal", () => {
    const dir = freshSlotDir();
    const meminfo = join(dir, "meminfo");
    writeFileSync(meminfo, "MemTotal:       0100663296 kB\n");
    expect(slotCount("auto", { TRAYCER_MACHINE_SLOT_MEMINFO: meminfo })).toBe(
      "6",
    );
  });

  it("treats an absurdly long MemTotal as unusable instead of doing arithmetic on it", () => {
    const dir = freshSlotDir();
    const meminfo = join(dir, "meminfo");
    writeFileSync(meminfo, "MemTotal:       9999999999999999999999 kB\n");
    expect(slotCount("auto", { TRAYCER_MACHINE_SLOT_MEMINFO: meminfo })).toBe(
      "1",
    );
  });

  it("ignores a meminfo seam that is not a regular file instead of hanging on it", () => {
    const dir = freshSlotDir();
    const fifo = join(dir, "meminfo-fifo");
    execFileSync("mkfifo", [fifo]);
    // slotCount has a 5 s timeout: a read of the FIFO would never return.
    const count = slotCount("auto", { TRAYCER_MACHINE_SLOT_MEMINFO: fifo });
    expect(count).toMatch(/^[1-9][0-9]*$/);
  });
});

describe("machine-slot.sh auto admission", () => {
  const LOW = { totalGib: 62, availableGib: 5 };
  const HIGH = { totalGib: 62, availableGib: 30 };

  /** Env for a run against a fake meminfo. */
  function admissionEnv(dir, extra) {
    return {
      TRAYCER_MACHINE_SLOT_DIR: dir,
      TRAYCER_MACHINE_SLOT_MEMINFO: join(dir, "meminfo"),
      TRAYCER_MACHINE_SLOT_TIMEOUT: "30",
      LOGFILE: join(dir, "log.txt"),
      ...extra,
    };
  }

  /** An outside process that holds the flock on one lock file until killed. */
  async function holdFile(path) {
    const holder = spawn(
      "python3",
      [
        "-I",
        "-c",
        [
          "import fcntl, os, sys, time",
          "fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)",
          "fcntl.flock(fd, fcntl.LOCK_EX)",
          'sys.stdout.write("locked\\n")',
          "sys.stdout.flush()",
          "time.sleep(60)",
        ].join("\n"),
        path,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    pidsToKill.push(holder.pid);
    await new Promise((resolve) => holder.stdout.once("data", resolve));
    return holder;
  }

  it("always admits a lone caller, even when less than 16 GiB is available", async () => {
    const dir = freshSlotDir();
    writeMeminfo(dir, LOW);
    const { done } = runSlot(
      ["lone", "auto", ...markerCommand("A", "0.1")],
      admissionEnv(dir, { TRAYCER_MACHINE_SLOT_TIMEOUT: "10" }),
    );
    const result = await done;
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).not.toMatch(/waited|waiting/);
    expect(readLogLines(join(dir, "log.txt"))).toEqual(["start:A", "end:A"]);
  }, 15000);

  it("refuses a second holder while under 16 GiB is available and admits it once the meminfo is rewritten", async () => {
    const dir = freshSlotDir();
    const logFile = join(dir, "log.txt");
    writeMeminfo(dir, LOW);
    const env = admissionEnv(dir, { TRAYCER_MACHINE_SLOT_TIMEOUT: "20" });

    const a = runSlot(["gate", "auto", ...markerCommand("A", "6")], env);
    await waitForLine(logFile, "start:A");
    const b = runSlot(["gate", "auto", ...markerCommand("B", "0.1")], env);
    // Two slot files are free, but memory does not admit a second holder.
    await pause(2000);
    expect(readLogLines(logFile)).toEqual(["start:A"]);

    // Memory frees up while B is waiting: B reads it again on its next poll.
    writeMeminfo(dir, HIGH);
    const rb = await b.done;
    expect(rb.code, rb.stderr).toBe(0);
    expect(readLogLines(logFile)).toEqual(["start:A", "start:B", "end:B"]);
    const ra = await a.done;
    expect(ra.code, ra.stderr).toBe(0);
  }, 25000);

  it("admits an earlier refused waiter before a later caller that arrives just as memory rises", async () => {
    const dir = freshSlotDir();
    const logFile = join(dir, "log.txt");
    writeMeminfo(dir, LOW);
    const env = admissionEnv(dir, { TRAYCER_MACHINE_SLOT_TIMEOUT: "20" });

    const a = runSlot(["order", "auto", ...markerCommand("A", "10")], env);
    await waitForLine(logFile, "start:A");
    const w = runSlot(["order", "auto", ...markerCommand("W", "0.1")], env);
    // W is refused for low memory and leaves a ticket.
    await waitForFiles(dir, (names) => names.some(isTicket));
    // Memory rises and L arrives before W's next poll: L must not overtake W.
    writeMeminfo(dir, HIGH);
    const l = runSlot(["order", "auto", ...markerCommand("L", "0.1")], env);
    const results = await Promise.all([w.done, l.done]);
    for (const result of results) {
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).not.toMatch(/waited/);
    }
    const lines = readLogLines(logFile);
    expect(lines.indexOf("end:A")).toBe(-1);
    expect(lines.indexOf("start:W")).toBeGreaterThan(-1);
    expect(lines.indexOf("start:W")).toBeLessThan(lines.indexOf("start:L"));
    expect((await a.done).code).toBe(0);
  }, 30000);

  it("keeps a long-queued waiter ahead of a later caller: its heartbeat is refreshed, not written once", async () => {
    const dir = freshSlotDir();
    const logFile = join(dir, "log.txt");
    writeMeminfo(dir, LOW);
    const env = admissionEnv(dir, { TRAYCER_MACHINE_SLOT_TIMEOUT: "60" });

    // Slot file 0 is held from outside for the whole test, so W is never alone
    // and nothing here depends on how long a sleeping holder lasts.
    const holder = await holdFile(join(dir, "traycer-slot-beat.0.lock"));
    const w = runSlot(["beat", "auto", ...markerCommand("W", "0.1")], env);
    await waitForFiles(dir, (names) => names.some(isTicket));
    // The ticket file exists before its first write lands: read until it holds
    // three finite numbers (started, deadline, beat).
    const readBeat = async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const name = readdirSync(dir).find(isTicket);
        const fields = (
          name === undefined ? "" : readFileSync(join(dir, name), "utf8")
        )
          .split(/\s+/)
          .filter((word) => word !== "")
          .map(Number);
        if (fields.length >= 3 && fields.slice(0, 3).every(Number.isFinite)) {
          return fields[2];
        }
        await pause(50);
      }
      throw new Error("the ticket never held three numbers");
    };
    const firstBeat = await readBeat();
    // Long enough that a heartbeat written once, at creation, would be stale.
    await pause(7500);
    expect((await readBeat()) - firstBeat).toBeGreaterThan(5);
    expect(readLogLines(logFile)).toEqual([]);

    writeMeminfo(dir, HIGH);
    const l = runSlot(["beat", "auto", ...markerCommand("L", "0.1")], env);
    const results = await Promise.all([w.done, l.done]);
    for (const result of results) {
      expect(result.code, result.stderr).toBe(0);
    }
    const lines = readLogLines(logFile);
    expect(lines.indexOf("start:W")).toBeGreaterThan(-1);
    expect(lines.indexOf("start:W")).toBeLessThan(lines.indexOf("start:L"));
    holder.kill("SIGKILL");
  }, 40000);

  it("takes the admission gate around admission: a caller waits while another process holds it", async () => {
    const dir = freshSlotDir();
    const logFile = join(dir, "log.txt");
    writeMeminfo(dir, HIGH);
    const env = admissionEnv(dir);
    const holder = await holdFile(join(dir, "traycer-slot-gate.admit.lock"));
    const a = runSlot(["gate", "auto", ...markerCommand("A", "0.1")], env);
    // A would be a lone caller, but it cannot get through the gate.
    await pause(2000);
    expect(readLogLines(logFile)).toEqual([]);
    holder.kill("SIGKILL");
    const result = await a.done;
    expect(result.code, result.stderr).toBe(0);
    expect(readLogLines(logFile)).toEqual(["start:A", "end:A"]);
  }, 20000);

  it("admits at most one of several callers released at the same instant just above 16 GiB", async () => {
    const dir = freshSlotDir();
    const logFile = join(dir, "log.txt");
    writeMeminfo(dir, { totalGib: 62, availableGib: 17 });
    const env = admissionEnv(dir);
    const runs = ["A", "B", "C", "D", "E"].map((label) =>
      runSlot(["stampede", "auto", ...markerCommand(label, "4")], env),
    );
    await pause(3000);
    const started = readLogLines(logFile).filter((line) =>
      line.startsWith("start:"),
    );
    for (const run of runs) run.child.kill("SIGKILL");
    await Promise.all(runs.map((run) => run.done));
    expect(started).toHaveLength(1);
  }, 30000);

  it("reserves one peak per held slot file: 32 GiB admits a second holder but not a third until memory rises", async () => {
    const dir = freshSlotDir();
    const logFile = join(dir, "log.txt");
    // 16 GiB plus one held file is 28 GiB; two held files, 40 GiB.
    writeMeminfo(dir, { totalGib: 62, availableGib: 32 });
    const env = admissionEnv(dir);

    const a = runSlot(["reserve", "auto", ...markerCommand("A", "12")], env);
    await waitForLine(logFile, "start:A");
    const b = runSlot(["reserve", "auto", ...markerCommand("B", "12")], env);
    await waitForLine(logFile, "start:B");
    const c = runSlot(["reserve", "auto", ...markerCommand("C", "0.1")], env);
    await pause(2000);
    expect(readLogLines(logFile)).toEqual(["start:A", "start:B"]);

    writeMeminfo(dir, { totalGib: 62, availableGib: 50 });
    const rc = await c.done;
    expect(rc.code, rc.stderr).toBe(0);
    expect(rc.stderr).not.toMatch(/waited/);
    expect(readLogLines(logFile)).not.toContain("end:A");
    await Promise.all([a.done, b.done]);
  }, 40000);

  it("never lets the reservation lapse with time: a holder keeps its 12 GiB for as long as it holds", async () => {
    const dir = freshSlotDir();
    const logFile = join(dir, "log.txt");
    writeMeminfo(dir, { totalGib: 62, availableGib: 20 });
    const env = admissionEnv(dir);

    const a = runSlot(["no-lapse", "auto", ...markerCommand("A", "10")], env);
    await waitForLine(logFile, "start:A");
    const b = runSlot(["no-lapse", "auto", ...markerCommand("B", "0.1")], env);
    // 20 GiB is under the 28 GiB that one held file needs, however long A
    // has been running.
    await pause(4000);
    expect(readLogLines(logFile)).toEqual(["start:A"]);

    writeMeminfo(dir, HIGH);
    const rb = await b.done;
    expect(rb.code, rb.stderr).toBe(0);
    expect(readLogLines(logFile)).toEqual(["start:A", "start:B", "end:B"]);
    await a.done;
  }, 30000);

  it("is not blocked by a ticket whose pid is alive but holds no lock (a recycled pid)", async () => {
    const dir = freshSlotDir();
    const logFile = join(dir, "log.txt");
    writeMeminfo(dir, HIGH);
    // This test process is alive and unrelated to the slot script.
    writeFileSync(
      join(dir, `traycer-slot-impostor.wait.${process.pid}`),
      // Valid, older than any caller, far deadline and a fresh heartbeat: only
      // the missing lock says its owner is gone.
      "0.5 99999999999.0 99999999999.0\n",
    );
    const startedAt = Date.now();
    const result = await runSlot(
      ["impostor", "auto", ...markerCommand("A", "0.1")],
      admissionEnv(dir, { TRAYCER_MACHINE_SLOT_TIMEOUT: "8" }),
    ).done;
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).not.toMatch(/waited/);
    expect(Date.now() - startedAt).toBeLessThan(4000);
    expect(readLogLines(logFile)).toEqual(["start:A", "end:A"]);
  }, 20000);

  it("ignores a ticket past its own deadline even while its owner still holds the lock", async () => {
    const dir = freshSlotDir();
    const logFile = join(dir, "log.txt");
    writeMeminfo(dir, HIGH);
    const ticket = join(dir, `traycer-slot-pastdue.wait.${process.pid}`);
    writeFileSync(ticket, "0.5 2.0 99999999999.0\n");
    await holdFile(ticket);
    const startedAt = Date.now();
    const result = await runSlot(
      ["pastdue", "auto", ...markerCommand("A", "0.1")],
      admissionEnv(dir, { TRAYCER_MACHINE_SLOT_TIMEOUT: "8" }),
    ).done;
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).not.toMatch(/waited/);
    expect(Date.now() - startedAt).toBeLessThan(4000);
    expect(readLogLines(logFile)).toEqual(["start:A", "end:A"]);
  }, 20000);

  it("ignores a locked ticket whose heartbeat is stale", async () => {
    const dir = freshSlotDir();
    const logFile = join(dir, "log.txt");
    writeMeminfo(dir, HIGH);
    const ticket = join(dir, `traycer-slot-stalebeat.wait.${process.pid}`);
    // Locked, older than any caller, far deadline, but last beaten long ago.
    writeFileSync(ticket, "0.5 99999999999.0 3.0\n");
    await holdFile(ticket);
    const startedAt = Date.now();
    const result = await runSlot(
      ["stalebeat", "auto", ...markerCommand("A", "0.1")],
      admissionEnv(dir, { TRAYCER_MACHINE_SLOT_TIMEOUT: "8" }),
    ).done;
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).not.toMatch(/waited/);
    expect(Date.now() - startedAt).toBeLessThan(4000);
    expect(readLogLines(logFile)).toEqual(["start:A", "end:A"]);
  }, 20000);

  it("stops being blocked by a stopped waiter within seconds, even a caller that would be alone", async () => {
    const dir = freshSlotDir();
    const logFile = join(dir, "log.txt");
    writeMeminfo(dir, LOW);
    const env = admissionEnv(dir);

    const a = runSlot(["stopped", "auto", ...markerCommand("A", "5")], env);
    await waitForLine(logFile, "start:A");
    // W's own deadline is far away: only the heartbeat can free the queue.
    const w = runSlot(["stopped", "auto", ...markerCommand("W", "0.1")], {
      ...env,
      TRAYCER_MACHINE_SLOT_TIMEOUT: "120",
    });
    await waitForFiles(dir, (names) => names.some(isTicket));
    const waiterPid = Number(
      readdirSync(dir).find(isTicket).split(".wait.")[1],
    );
    // Stop W only while the test holds the admission gate, so W cannot be
    // stopped inside it (that would wedge every caller, by design).
    const gateHolder = await holdFile(
      join(dir, "traycer-slot-stopped.admit.lock"),
    );
    process.kill(waiterPid, "SIGSTOP");
    gateHolder.kill("SIGKILL");

    // A finishes; nothing is held, so N would be a lone caller. W's ticket is
    // locked and older, but it is not being beaten.
    await waitForLine(logFile, "end:A");
    const n = runSlot(["stopped", "auto", ...markerCommand("N", "0.1")], env);
    await waitForLine(logFile, "start:N");
    const rn = await n.done;
    expect(rn.code, rn.stderr).toBe(0);
    expect(rn.stderr).not.toMatch(/waited/);
    process.kill(waiterPid, "SIGKILL");
    await Promise.all([w.done, a.done]);
  }, 40000);

  it("removes the ticket of a dead process instead of waiting behind it", async () => {
    const dir = freshSlotDir();
    const logFile = join(dir, "log.txt");
    writeMeminfo(dir, HIGH);
    const dead = spawn("true");
    await new Promise((resolve) => dead.on("close", resolve));
    const stale = join(dir, `traycer-slot-stale.wait.${dead.pid}`);
    writeFileSync(stale, "1.0\n");

    const result = await runSlot(
      ["stale", "auto", ...markerCommand("A", "0.1")],
      admissionEnv(dir),
    ).done;
    expect(result.code, result.stderr).toBe(0);
    expect(readLogLines(logFile)).toEqual(["start:A", "end:A"]);
    expect(existsSync(stale)).toBe(false);
  }, 15000);

  it("leaves no ticket behind when a waiter times out", async () => {
    const dir = freshSlotDir();
    const logFile = join(dir, "log.txt");
    writeMeminfo(dir, LOW);
    const env = admissionEnv(dir, { TRAYCER_MACHINE_SLOT_TIMEOUT: "2" });
    const a = runSlot(
      ["timeout-ticket", "auto", ...markerCommand("A", "6")],
      env,
    );
    await waitForLine(logFile, "start:A");
    const b = runSlot(
      ["timeout-ticket", "auto", ...markerCommand("B", "0.1")],
      env,
    );
    const rb = await b.done;
    expect(rb.stderr).toMatch(/waited 2s/);
    expect(rb.stderr).toMatch(
      /last refused because MemAvailable is 5 GiB and this needs 28 GiB/,
    );
    expect(readdirSync(dir).filter(isTicket)).toEqual([]);
    await a.done;
  }, 20000);

  it("leaves no ticket behind when a waiter's shell is killed", async () => {
    const dir = freshSlotDir();
    const logFile = join(dir, "log.txt");
    writeMeminfo(dir, LOW);
    const env = admissionEnv(dir);
    const a = runSlot(["kill-ticket", "auto", ...markerCommand("A", "6")], env);
    await waitForLine(logFile, "start:A");
    const b = runSlot(
      ["kill-ticket", "auto", ...markerCommand("B", "0.1")],
      env,
    );
    await waitForFiles(dir, (names) => names.some(isTicket));
    b.child.kill("SIGKILL");
    // The orphaned holder notices on its next poll and exits.
    await waitForFiles(dir, (names) => !names.some(isTicket));
    await Promise.all([a.done, b.done]);
  }, 20000);

  it("sees a holder that is only on slot file 1: a probe of file 0 alone would admit the newcomer", async () => {
    const dir = freshSlotDir();
    const logFile = join(dir, "log.txt");
    writeMeminfo(dir, LOW);
    const env = admissionEnv(dir);

    const holder = await holdFile(join(dir, "traycer-slot-file-one.1.lock"));
    const a = runSlot(["file-one", "auto", ...markerCommand("A", "0.1")], env);
    // Under low memory, with file 1 held, A is not alone and must wait.
    // Its ticket proves it reached the refusal path, after probing, so the
    // empty log below is not just a caller that has not started yet.
    await waitForFiles(dir, (names) => names.some(isTicket));
    await pause(2000);
    expect(readLogLines(logFile)).toEqual([]);

    holder.kill("SIGKILL");
    const result = await a.done;
    expect(result.code, result.stderr).toBe(0);
    expect(readLogLines(logFile)).toEqual(["start:A", "end:A"]);
  }, 20000);

  it("sees a holder from a larger explicit pool on a file beyond the caller's own pool", async () => {
    const dir = freshSlotDir();
    const logFile = join(dir, "log.txt");
    // MemTotal 20 GiB: the auto pool is 1 file, but a holder of an explicit
    // pool of 5 sits on slot file 3.
    writeMeminfo(dir, { totalGib: 20, availableGib: 5 });
    const env = admissionEnv(dir);
    for (let index = 0; index < 3; index += 1) {
      writeFileSync(join(dir, `traycer-slot-beyond.${index}.lock`), "");
    }

    const holder = await holdFile(join(dir, "traycer-slot-beyond.3.lock"));
    const a = runSlot(["beyond", "auto", ...markerCommand("A", "0.1")], env);
    // Its ticket proves it reached the refusal path, after probing, so the
    // empty log below is not just a caller that has not started yet.
    await waitForFiles(dir, (names) => names.some(isTicket));
    await pause(2000);
    expect(readLogLines(logFile)).toEqual([]);

    holder.kill("SIGKILL");
    const result = await a.done;
    expect(result.code, result.stderr).toBe(0);
    expect(readLogLines(logFile)).toEqual(["start:A", "end:A"]);
  }, 20000);

  it("counts a holder on a slot file past an auto pool of 16 or more in its admission threshold", async () => {
    const dir = freshSlotDir();
    const logFile = join(dir, "log.txt");
    // MemTotal 256 GiB: the auto pool is 16 slot files, as many as the probe
    // limit. A holder of a larger explicit pool sits on slot file 16.
    writeMeminfo(dir, { totalGib: 256, availableGib: 20 });
    const env = admissionEnv(dir);
    const holder = await holdFile(join(dir, "traycer-slot-bigpool.16.lock"));

    const a = runSlot(["bigpool", "auto", ...markerCommand("A", "0.1")], env);
    // 20 GiB would admit a lone caller (16 GiB), but with that holder counted
    // the threshold is 28 GiB.
    // Its ticket proves it reached the refusal path, after probing, so the
    // empty log below is not just a caller that has not started yet.
    await waitForFiles(dir, (names) => names.some(isTicket));
    await pause(2000);
    expect(readLogLines(logFile)).toEqual([]);

    writeMeminfo(dir, { totalGib: 256, availableGib: 30 });
    const result = await a.done;
    expect(result.code, result.stderr).toBe(0);
    expect(readLogLines(logFile)).toEqual(["start:A", "end:A"]);
    holder.kill("SIGKILL");
  }, 20000);

  it("runs three low-memory callers launched at once with nothing held strictly one at a time", async () => {
    const dir = freshSlotDir();
    const logFile = join(dir, "log.txt");
    writeMeminfo(dir, LOW);
    const env = admissionEnv(dir);

    const runs = ["A", "B", "C"].map((label) =>
      runSlot(["burst", "auto", ...markerCommand(label, "0.4")], env),
    );
    const results = await Promise.all(runs.map((run) => run.done));
    for (const result of results) {
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).not.toMatch(/waited/);
    }

    const lines = readLogLines(logFile);
    expect(lines).toHaveLength(6);
    for (let index = 0; index < lines.length; index += 2) {
      const label = lines[index].slice("start:".length);
      expect(lines[index]).toBe(`start:${label}`);
      expect(lines[index + 1]).toBe(`end:${label}`);
    }
  }, 40000);

  it("does not check memory for an explicit count", async () => {
    const dir = freshSlotDir();
    const logFile = join(dir, "log.txt");
    writeMeminfo(dir, LOW);
    const env = admissionEnv(dir);
    const a = runSlot(["explicit", "2", ...markerCommand("A", "4")], env);
    await waitForLine(logFile, "start:A");
    const b = runSlot(["explicit", "2", ...markerCommand("B", "0.1")], env);
    await waitForLine(logFile, "end:B");
    expect(readLogLines(logFile)).not.toContain("end:A");
    await Promise.all([a.done, b.done]);
  }, 20000);

  it("does not check memory when the kernel reports no MemAvailable", async () => {
    const dir = freshSlotDir();
    const logFile = join(dir, "log.txt");
    writeMeminfo(dir, { totalGib: 33 });
    const env = admissionEnv(dir);
    const a = runSlot(["nomemavail", "auto", ...markerCommand("A", "4")], env);
    await waitForLine(logFile, "start:A");
    const b = runSlot(
      ["nomemavail", "auto", ...markerCommand("B", "0.1")],
      env,
    );
    await waitForLine(logFile, "end:B");
    expect(readLogLines(logFile)).not.toContain("end:A");
    await Promise.all([a.done, b.done]);
  }, 20000);
});

describe("a count that differs between acquisitions", () => {
  it("only makes a newcomer try fewer slot files; it never shares a held one", async () => {
    const dir = freshSlotDir();
    const logFile = join(dir, "log.txt");
    const env = { TRAYCER_MACHINE_SLOT_DIR: dir, LOGFILE: logFile };

    // A and B ask for 2 slots and take slot files 0 and 1. A is held long
    // enough that B reliably takes its file on a loaded runner.
    const a = runSlot(["shrink", "2", ...markerCommand("A", "2")], env);
    await waitForLine(logFile, "start:A");
    const b = runSlot(["shrink", "2", ...markerCommand("B", "6")], env);
    await waitForLine(logFile, "start:B");
    // C asks for 1, so it only tries slot file 0, which A holds, and must
    // wait for A even though slot file 1 exists.
    const c = runSlot(["shrink", "1", ...markerCommand("C", "0.1")], env);
    const results = await Promise.all([a.done, b.done, c.done]);
    for (const result of results) {
      expect(result.code, result.stderr).toBe(0);
    }

    const lines = readLogLines(logFile);
    expect(lines.indexOf("start:C")).toBeGreaterThan(lines.indexOf("end:A"));
    expect(lines.indexOf("start:C")).toBeLessThan(lines.indexOf("end:B"));
  }, 25000);
});
