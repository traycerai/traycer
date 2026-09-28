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
        // Only the holder's own invocation (dir, name, slots, timeout,
        // status_file, parent -> 8 args total) has more than 3 arguments;
        // the `python3 -c 'import fcntl'` capability probe has 2.
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
