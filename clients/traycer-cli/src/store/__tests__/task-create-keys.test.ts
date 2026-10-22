import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  clearTaskCreateKey,
  readTaskCreateKey,
  TASK_CREATE_KEY_TTL_MS,
  taskCreateKeyRecordPath,
  withTaskCreateKeyLock,
  writeTaskCreateKey,
} from "../task-create-keys";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "task-create-keys-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const RECORD = {
  taskId: "task-1",
  agentId: "chat-1",
  fingerprint: "fp-1",
  writtenAt: 1_000,
};

describe("task create key record path", () => {
  it("is one file per signed-in person and key, naming neither", () => {
    const path = taskCreateKeyRecordPath(dir, "user-a", "nightly-2026-10-22");
    expect(dirname(path)).toBe(dir);
    expect(basename(path)).not.toContain("user-a");
    expect(basename(path)).not.toContain("nightly");
    expect(taskCreateKeyRecordPath(dir, "user-a", "nightly-2026-10-22")).toBe(
      path,
    );
    expect(
      taskCreateKeyRecordPath(dir, "user-b", "nightly-2026-10-22"),
    ).not.toBe(path);
    expect(
      taskCreateKeyRecordPath(dir, "user-a", "nightly-2026-10-23"),
    ).not.toBe(path);
  });
});

describe("task create key record", () => {
  it("reads absent before any write", async () => {
    const path = taskCreateKeyRecordPath(dir, "u", "k");
    expect(await readTaskCreateKey(path, 2_000)).toEqual({ kind: "absent" });
  });

  it("reads back an intent, then the done that replaces it, leaving no temp file", async () => {
    const path = taskCreateKeyRecordPath(join(dir, "nested"), "u", "k");
    await writeTaskCreateKey(path, { state: "intent", ...RECORD });
    expect(await readTaskCreateKey(path, 2_000)).toEqual({
      kind: "intent",
      record: { state: "intent", ...RECORD },
    });
    await writeTaskCreateKey(path, { state: "done", ...RECORD });
    expect(await readTaskCreateKey(path, 2_000)).toEqual({
      kind: "done",
      record: { state: "done", ...RECORD },
    });
    expect(await readdir(join(dir, "nested"))).toEqual([basename(path)]);
  });

  it("reads a record older than the 24-hour window as expired", async () => {
    const path = taskCreateKeyRecordPath(dir, "u", "k");
    await writeTaskCreateKey(path, { state: "intent", ...RECORD });
    expect(
      await readTaskCreateKey(path, RECORD.writtenAt + TASK_CREATE_KEY_TTL_MS),
    ).toEqual({ kind: "intent", record: { state: "intent", ...RECORD } });
    expect(
      await readTaskCreateKey(
        path,
        RECORD.writtenAt + TASK_CREATE_KEY_TTL_MS + 1,
      ),
    ).toEqual({ kind: "expired" });
  });

  it("reads bytes it cannot parse as damaged, never as absent", async () => {
    const path = taskCreateKeyRecordPath(dir, "u", "k");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{not json");
    expect(await readTaskCreateKey(path, 2_000)).toEqual({ kind: "damaged" });
  });

  it("clears a record", async () => {
    const path = taskCreateKeyRecordPath(dir, "u", "k");
    await writeTaskCreateKey(path, { state: "intent", ...RECORD });
    await clearTaskCreateKey(path);
    expect(await readTaskCreateKey(path, 2_000)).toEqual({ kind: "absent" });
  });
});

describe("task create key lock", () => {
  it("makes a second holder whose wait runs out fail busy without running", async () => {
    const path = taskCreateKeyRecordPath(dir, "u", "k");
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withTaskCreateKeyLock(path, 1_000, () => held);
    // Let the first holder take the lock file before the second asks.
    await new Promise((resolve) => setTimeout(resolve, 50));
    let secondRan = false;
    const second = withTaskCreateKeyLock(path, 100, () => {
      secondRan = true;
      return Promise.resolve();
    });
    const error = await second.then(
      () => null,
      (cause: unknown) => cause,
    );
    release();
    await first;
    expect(secondRan).toBe(false);
    expect(error).toBeInstanceOf(CliError);
    // 75 (EX_TEMPFAIL), the documented exit for a run another one holds up.
    expect(error).toMatchObject({
      code: CLI_ERROR_CODES.CLI_LOCK_BUSY,
      exitCode: 75,
    });
  });
});
