import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chatDbPathFor,
  EPIC_STATE_DIRNAME,
  surveyChatDbStamps,
} from "../chat-store-survey";

// `node:sqlite` is available under this package's vitest runner (Node 26
// workers) but not under bare `bun` - the survey itself imports it
// dynamically for exactly that reason. Writing fixture stores the same way
// the host would exercises the real on-disk shape rather than a fabrication.
async function writeChatDb(
  path: string,
  setup: (db: import("node:sqlite").DatabaseSync) => void,
): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  try {
    setup(db);
  } finally {
    db.close();
  }
}

async function writeStampedChatDb(
  path: string,
  schemaVersion: number | string,
): Promise<void> {
  await writeChatDb(path, (db) => {
    db.exec(
      "CREATE TABLE chat_db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    db.prepare("INSERT INTO chat_db_meta (key, value) VALUES (?, ?)").run(
      "schema_version",
      String(schemaVersion),
    );
  });
}

let hostHome: string;

beforeEach(async () => {
  hostHome = await mkdtemp(join(tmpdir(), "chat-store-survey-test-"));
});

afterEach(async () => {
  await rm(hostHome, { recursive: true, force: true });
});

async function epicDbPath(epicId: string): Promise<string> {
  const dbPath = chatDbPathFor(hostHome, epicId);
  await mkdir(join(hostHome, EPIC_STATE_DIRNAME, epicId, "chat"), {
    recursive: true,
  });
  return dbPath;
}

describe("surveyChatDbStamps", () => {
  it("returns a missing epic-state directory as an empty survey", async () => {
    await expect(surveyChatDbStamps(hostHome)).resolves.toEqual({
      readings: [],
      failures: [],
    });
  });

  it("records a failure when epic-state itself is a FILE rather than a directory (ENOTDIR on the root)", async () => {
    // ENOENT alone is emptiness; every other enumeration failure - including
    // a root shadowed by a file - must travel as a failure, because an empty
    // survey now reads as unconditionally `clear` downstream.
    await writeFile(join(hostHome, EPIC_STATE_DIRNAME), "", "utf8");

    const survey = await surveyChatDbStamps(hostHome);

    expect(survey.readings).toEqual([]);
    expect(survey.failures).toEqual([
      { epicId: "*", reason: "unreadable-epic-state-directory" },
    ]);
  });

  // Root cause is `os.access`, permission bits don't restrict `root` (nor,
  // reliably, Windows), so the CI/dev-container case that actually runs as
  // root would falsely pass a plain assertion here. Skipping there rather
  // than asserting nothing is the honest tradeoff: this survey is what the
  // desktop's own dev containers run as.
  const canSimulateEacces = platform !== "win32" && process.getuid?.() !== 0;
  (canSimulateEacces ? it : it.skip)(
    "records a failure when epic-state is unreadable (EACCES on the root)",
    async () => {
      await mkdir(join(hostHome, EPIC_STATE_DIRNAME), { recursive: true });
      await chmod(join(hostHome, EPIC_STATE_DIRNAME), 0o000);

      try {
        const survey = await surveyChatDbStamps(hostHome);

        expect(survey.readings).toEqual([]);
        expect(survey.failures).toEqual([
          { epicId: "*", reason: "unreadable-epic-state-directory" },
        ]);
      } finally {
        // Restore so the temp-dir cleanup in `afterEach` can actually delete it.
        await chmod(join(hostHome, EPIC_STATE_DIRNAME), 0o755);
      }
    },
  );

  it("reads a normal store's schema stamp", async () => {
    const dbPath = await epicDbPath("epic-1");
    await writeStampedChatDb(dbPath, 9);

    const survey = await surveyChatDbStamps(hostHome);

    expect(survey).toEqual({
      readings: [{ epicId: "epic-1", schemaVersion: 9 }],
      failures: [],
    });
  });

  it("parses a stamp stored as an INTEGER rather than text", async () => {
    const dbPath = await epicDbPath("epic-int");
    await writeChatDb(dbPath, (db) => {
      db.exec(
        "CREATE TABLE chat_db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      // The host always writes a string, but the column itself is untyped
      // (SQLite dynamic typing), and a stamp written elsewhere as an
      // integer must not be misread as a failure.
      db.exec(
        "INSERT INTO chat_db_meta (key, value) VALUES ('schema_version', 9)",
      );
    });

    const survey = await surveyChatDbStamps(hostHome);

    expect(survey).toEqual({
      readings: [{ epicId: "epic-int", schemaVersion: 9 }],
      failures: [],
    });
  });

  it("records a failure when chat_db_meta carries no schema_version row", async () => {
    const dbPath = await epicDbPath("epic-no-row");
    await writeChatDb(dbPath, (db) => {
      db.exec(
        "CREATE TABLE chat_db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
    });

    const survey = await surveyChatDbStamps(hostHome);

    expect(survey.readings).toEqual([]);
    expect(survey.failures).toEqual([
      { epicId: "epic-no-row", reason: "missing-or-invalid-schema-version" },
    ]);
  });

  it("records a failure when the db file has no chat_db_meta table at all", async () => {
    const dbPath = await epicDbPath("epic-no-table");
    await writeChatDb(dbPath, (db) => {
      db.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
    });

    const survey = await surveyChatDbStamps(hostHome);

    expect(survey.readings).toEqual([]);
    // Was the raw SQLite "no such table" message before the reason codes
    // landed - opening succeeds (it is a valid, if unrelated, database), so
    // the failure is in the QUERY, same finite bucket as any other unreadable
    // store per the production module's doc comment.
    expect(survey.failures).toEqual([
      { epicId: "epic-no-table", reason: "unreadable-chat-db" },
    ]);
  });

  it("records a failure for a non-database file at chat/chat.db", async () => {
    const dbPath = await epicDbPath("epic-garbage");
    await writeFile(dbPath, "not a sqlite file at all", "utf8");

    const survey = await surveyChatDbStamps(hostHome);

    expect(survey.readings).toEqual([]);
    expect(survey.failures).toEqual([
      { epicId: "epic-garbage", reason: "unreadable-chat-db" },
    ]);
  });

  it("treats a FILE under epic-state (not a directory) as neither a reading nor a failure", async () => {
    // There is no `chat/chat.db` under a file - the survey has nothing to
    // open, and nothing to report failing to open.
    await mkdir(join(hostHome, EPIC_STATE_DIRNAME), { recursive: true });
    await writeFile(
      join(hostHome, EPIC_STATE_DIRNAME, "not-a-dir"),
      "",
      "utf8",
    );

    const survey = await surveyChatDbStamps(hostHome);

    expect(survey).toEqual({ readings: [], failures: [] });
  });

  it("treats an epic directory with no chat/chat.db as neither a reading nor a failure", async () => {
    await mkdir(join(hostHome, EPIC_STATE_DIRNAME, "epic-empty"), {
      recursive: true,
    });

    const survey = await surveyChatDbStamps(hostHome);

    expect(survey).toEqual({ readings: [], failures: [] });
  });

  it("surveys multiple epics with readings and failures disjoint by epic", async () => {
    const okPath = await epicDbPath("epic-a");
    await writeStampedChatDb(okPath, 7);
    const okPath2 = await epicDbPath("epic-b");
    await writeStampedChatDb(okPath2, 8);
    const badPath = await epicDbPath("epic-c");
    await writeFile(badPath, "garbage", "utf8");
    await mkdir(join(hostHome, EPIC_STATE_DIRNAME, "epic-d"), {
      recursive: true,
    });

    const survey = await surveyChatDbStamps(hostHome);

    expect(survey.readings).toEqual(
      expect.arrayContaining([
        { epicId: "epic-a", schemaVersion: 7 },
        { epicId: "epic-b", schemaVersion: 8 },
      ]),
    );
    expect(survey.readings).toHaveLength(2);
    expect(survey.failures).toEqual([
      { epicId: "epic-c", reason: "unreadable-chat-db" },
    ]);
    const readingIds = new Set(survey.readings.map((r) => r.epicId));
    const failureIds = new Set(survey.failures.map((f) => f.epicId));
    for (const id of readingIds) expect(failureIds.has(id)).toBe(false);
  });

  it("rejects a schema_version value far past what any legitimate stamp could be, without echoing it anywhere", async () => {
    const dbPath = await epicDbPath("epic-oversized-stamp");
    const oversized = "9".repeat(100 * 1024);
    await writeChatDb(dbPath, (db) => {
      db.exec(
        "CREATE TABLE chat_db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      db.prepare("INSERT INTO chat_db_meta (key, value) VALUES (?, ?)").run(
        "schema_version",
        oversized,
      );
    });

    const survey = await surveyChatDbStamps(hostHome);

    expect(survey.readings).toEqual([]);
    expect(survey.failures).toEqual([
      {
        epicId: "epic-oversized-stamp",
        reason: "missing-or-invalid-schema-version",
      },
    ]);
    // The old code embedded the whole row into the human error AND the
    // NDJSON details via `JSON.stringify` - a finite reason code cannot
    // carry the stored value at all, but this is the regression test for
    // that specific failure mode, not an incidental property of codes.
    expect(JSON.stringify(survey)).not.toContain(oversized.slice(0, 100));
  });

  it("bounds and charset-filters an epic id that carries a control character, so it cannot forge a log line", async () => {
    const rawEpicId = "epic\r\nINJECTED";
    const dbPath = await epicDbPath(rawEpicId);
    await writeStampedChatDb(dbPath, 9);

    const survey = await surveyChatDbStamps(hostHome);

    expect(survey.failures).toEqual([]);
    expect(survey.readings).toEqual([
      { epicId: "epic__INJECTED", schemaVersion: 9 },
    ]);
    for (const reading of survey.readings) {
      expect(reading.epicId).not.toMatch(/[\r\n]/);
    }
  });

  it("bounds an epic id longer than 64 characters, marking the truncation with a trailing ~", async () => {
    const rawEpicId = "e".repeat(80);
    const dbPath = await epicDbPath(rawEpicId);
    await writeStampedChatDb(dbPath, 9);

    const survey = await surveyChatDbStamps(hostHome);

    expect(survey.failures).toEqual([]);
    expect(survey.readings).toHaveLength(1);
    const renderedId = survey.readings[0]?.epicId ?? "";
    expect(renderedId.length).toBe(65);
    expect(renderedId.endsWith("~")).toBe(true);
    expect(renderedId.slice(0, 64)).toBe("e".repeat(64));
  });

  it("reports engine-unavailable as exactly ONE failure, never one per epic, when the runtime has no SQLite engine", async () => {
    // Two epics, both with a genuine readable chat.db, written BEFORE the
    // engine is stubbed out - `writeStampedChatDb` needs the real
    // `node:sqlite` itself. The whole finding is the COUNT: N epics reading
    // as N "damaged" failures would lie about the user's data, when the
    // truth is a fact about this one process, not about either file.
    const pathA = await epicDbPath("epic-a");
    await writeStampedChatDb(pathA, 9);
    const pathB = await epicDbPath("epic-b");
    await writeStampedChatDb(pathB, 8);

    vi.resetModules();
    vi.doMock("node:sqlite", () => {
      throw new Error("no node:sqlite in this simulated runtime");
    });
    try {
      const { surveyChatDbStamps: surveyWithoutEngine } =
        await import("../chat-store-survey");

      const survey = await surveyWithoutEngine(hostHome);

      expect(survey.readings).toEqual([]);
      expect(survey.failures).toEqual([
        { epicId: "*", reason: "engine-unavailable" },
      ]);
    } finally {
      vi.doUnmock("node:sqlite");
      vi.resetModules();
    }
  });

  it("never reports engine-unavailable on an empty epic-state directory - there is no data there to fail to read", async () => {
    // The early return (no epics enumerated -> return before the engine is
    // ever resolved) is production code; this pins that a stubbed-out
    // engine still cannot manufacture a refusal out of nothing.
    await mkdir(join(hostHome, EPIC_STATE_DIRNAME), { recursive: true });

    vi.resetModules();
    vi.doMock("node:sqlite", () => {
      throw new Error("no node:sqlite in this simulated runtime");
    });
    try {
      const { surveyChatDbStamps: surveyWithoutEngine } =
        await import("../chat-store-survey");

      await expect(surveyWithoutEngine(hostHome)).resolves.toEqual({
        readings: [],
        failures: [],
      });
    } finally {
      vi.doUnmock("node:sqlite");
      vi.resetModules();
    }
  });
});
