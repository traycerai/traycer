import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearHostDownloadFailure,
  readHostUpdateLastAttempt,
  writeHostUpdateLastAttempt,
} from "../last-attempt";

const valid = {
  command: "host apply",
  initiator: "desktop",
  outcome: "complete",
  targetVersion: "1.5.2",
  attemptId: null,
  code: null,
  message: null,
  recordedAt: "2026-11-01T07:05:10.795Z",
};

describe("readHostUpdateLastAttempt", () => {
  let home = "";

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "update-last-attempt-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function read(text: string): Promise<unknown> {
    await writeFile(join(home, "update-last-attempt.json"), text);
    return readHostUpdateLastAttempt(home);
  }

  it("reads what the writer wrote", async () => {
    expect(await read(JSON.stringify(valid))).toEqual(valid);
  });

  it("no file is no last attempt", async () => {
    expect(await readHostUpdateLastAttempt(home)).toBeNull();
  });

  it.each([
    ["torn bytes", '{"command":'],
    ["not an object", "null"],
    ["an unknown command", JSON.stringify({ ...valid, command: "host stop" })],
    ["an unknown initiator", JSON.stringify({ ...valid, initiator: "x" })],
    ["an unknown outcome", JSON.stringify({ ...valid, outcome: "x" })],
    ["a missing timestamp", JSON.stringify({ ...valid, recordedAt: 1 })],
    ["a non-string version", JSON.stringify({ ...valid, targetVersion: 1 })],
    ["a non-string attempt", JSON.stringify({ ...valid, attemptId: 1 })],
    ["a non-string code", JSON.stringify({ ...valid, code: 1 })],
    ["a non-string message", JSON.stringify({ ...valid, message: 1 })],
  ])("%s reads as none, never as a wrong answer", async (_name, text) => {
    expect(await read(text)).toBeNull();
  });
});

describe("writeHostUpdateLastAttempt", () => {
  let home = "";

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "update-last-attempt-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const attempt = {
    command: "host download",
    initiator: "desktop",
    outcome: "failed",
    targetVersion: "1.5.2",
    attemptId: null,
    code: null,
    message: null,
  } as const;

  async function recorded(message: string): Promise<string | null> {
    await writeHostUpdateLastAttempt(
      home,
      { ...attempt, message },
      { info: vi.fn() },
    );
    return (await readHostUpdateLastAttempt(home))?.message ?? null;
  }

  it.each([
    [
      "this account's home",
      `EACCES: open '${join(homedir(), ".traycer", "lock")}'`,
      `EACCES: open '${join("~", ".traycer", "lock")}'`,
    ],
    [
      "another account's macOS home",
      "EPERM: /Users/alice/.traycer/lock",
      "EPERM: /Users/[redacted]/.traycer/lock",
    ],
    [
      "another account's Linux home",
      "held from /home/alice/.traycer",
      "held from /home/[redacted]/.traycer",
    ],
    [
      "a Windows home, spaces and all",
      "EBUSY: C:\\Users\\Jo Bloggs\\.traycer\\lock",
      "EBUSY: C:\\Users\\[redacted]\\.traycer\\lock",
    ],
    [
      "an email",
      "signed in as jo.bloggs@example.com, refused",
      "signed in as [redacted], refused",
    ],
    [
      "a signed URL",
      "GET https://cdn.example.com/a?X-Amz-Signature=abc123 returned 503",
      "GET https://cdn.example.com/a?X-Amz-Signature=[redacted] returned 503",
    ],
    [
      "URL credentials",
      "GET https://jo:hunter2@mirror.example.com/a failed",
      "GET https://[redacted]@mirror.example.com/a failed",
    ],
    ["a bearer token", "sent Bearer abc.def.ghi", "sent Bearer [redacted]"],
  ])("keeps %s out of the record", async (_name, message, expected) => {
    expect(await recorded(message)).toBe(expected);
  });

  it("keeps a home out of a target typed on the command line", async () => {
    await writeHostUpdateLastAttempt(
      home,
      { ...attempt, targetVersion: "/Users/alice/build/host" },
      { info: vi.fn() },
    );
    expect(await readHostUpdateLastAttempt(home)).toMatchObject({
      targetVersion: "/Users/[redacted]/build/host",
    });
  });

  it("keeps a home out of the log when the write itself fails", async () => {
    await mkdir(join(home, "update-last-attempt.json"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    const info = vi.fn();
    try {
      await writeHostUpdateLastAttempt(home, attempt, { info });
    } finally {
      vi.unstubAllEnvs();
    }
    const [, fields] = info.mock.calls[0] ?? [];
    expect(fields.error).toContain("~");
    expect(fields.error).not.toContain(home);
  });

  it("bounds what a long stderr can put on disk", async () => {
    expect((await recorded("x".repeat(5_000)))?.length).toBe(2_003);
  });
});

describe("clearHostDownloadFailure", () => {
  let home = "";

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "update-last-attempt-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it.each([
    ["clears", "host download", null],
    ["leaves", "host apply", "host apply"],
  ])("%s a %s record", async (_verb, command, remaining) => {
    await writeFile(
      join(home, "update-last-attempt.json"),
      JSON.stringify({ ...valid, command }),
    );
    await clearHostDownloadFailure(home);
    expect((await readHostUpdateLastAttempt(home))?.command ?? null).toBe(
      remaining,
    );
  });
});
