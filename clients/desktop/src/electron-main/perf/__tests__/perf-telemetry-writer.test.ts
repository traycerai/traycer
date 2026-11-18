import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const userDataDir = vi.hoisted(() => ({ path: "" }));

vi.mock("electron", () => ({
  app: {
    getPath: (name: string): string => {
      if (name !== "userData") throw new Error(`unexpected path: ${name}`);
      return userDataDir.path;
    },
  },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: { file: { level: "info" }, console: { level: "info" } },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { appendPerfEvent, flushPerfWrites } from "../perf-telemetry-writer";

const PERF_FILE = "traycer-perf.ndjson";
const BACKUP_FILE = "traycer-perf.ndjson.1";

beforeEach(async () => {
  userDataDir.path = await mkdtemp(join(tmpdir(), "traycer-perf-"));
});

afterEach(async () => {
  await rm(userDataDir.path, { recursive: true, force: true });
});

describe("perf-telemetry-writer", () => {
  it("appends one JSON object per line, in order", async () => {
    appendPerfEvent({ name: "a", tsMs: 1, fields: { n: 1 } });
    appendPerfEvent({ name: "b", tsMs: 2, fields: { s: "x" } });
    await flushPerfWrites();

    const raw = await readFile(join(userDataDir.path, PERF_FILE), "utf8");
    const lines = raw.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({
      name: "a",
      tsMs: 1,
      fields: { n: 1 },
    });
    expect(JSON.parse(lines[1])).toEqual({
      name: "b",
      tsMs: 2,
      fields: { s: "x" },
    });
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("rotates to a single .1 backup once the file exceeds ~5 MB", async () => {
    // First event pushes the file past the 5 MB threshold; the NEXT append
    // rotates the oversized file to the backup and starts fresh.
    const big = "x".repeat(5 * 1024 * 1024 + 16);
    appendPerfEvent({ name: "big", tsMs: 1, fields: { blob: big } });
    await flushPerfWrites();
    const sizeBefore = (await stat(join(userDataDir.path, PERF_FILE))).size;
    expect(sizeBefore).toBeGreaterThan(5 * 1024 * 1024);

    appendPerfEvent({ name: "after", tsMs: 2, fields: {} });
    await flushPerfWrites();

    // Fresh main file carries only the post-rotation event...
    const mainRaw = await readFile(join(userDataDir.path, PERF_FILE), "utf8");
    const mainLines = mainRaw.split("\n").filter((line) => line.length > 0);
    expect(mainLines).toHaveLength(1);
    expect(JSON.parse(mainLines[0]).name).toBe("after");

    // ...and the backup holds the pre-rotation content.
    const backupRaw = await readFile(
      join(userDataDir.path, BACKUP_FILE),
      "utf8",
    );
    expect(JSON.parse(backupRaw.trim()).name).toBe("big");
  });

  it("keeps exactly one backup, overwriting a prior .1 on the next rotation", async () => {
    const big = "x".repeat(5 * 1024 * 1024 + 16);
    // Seed a stale backup that a later rotation must overwrite, not append to.
    await writeFile(join(userDataDir.path, BACKUP_FILE), "stale\n", "utf8");

    appendPerfEvent({ name: "gen1", tsMs: 1, fields: { blob: big } });
    appendPerfEvent({ name: "after1", tsMs: 2, fields: {} });
    await flushPerfWrites();

    const backupRaw = await readFile(
      join(userDataDir.path, BACKUP_FILE),
      "utf8",
    );
    expect(backupRaw.includes("stale")).toBe(false);
    expect(JSON.parse(backupRaw.trim()).name).toBe("gen1");
  });

  it("never throws into the caller and logs a failed write", async () => {
    // Point userData at a path that cannot be created (a file, not a dir) so
    // mkdir fails - the append must swallow it, not throw.
    const filePath = join(userDataDir.path, "not-a-dir");
    await writeFile(filePath, "blocker", "utf8");
    userDataDir.path = filePath;

    expect(() =>
      appendPerfEvent({ name: "x", tsMs: 1, fields: {} }),
    ).not.toThrow();
    await expect(flushPerfWrites()).resolves.toBeUndefined();
  });
});
