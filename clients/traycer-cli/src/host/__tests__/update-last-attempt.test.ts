import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readHostUpdateLastAttempt } from "../update-last-attempt";

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
