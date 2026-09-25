/**
 * Pins {@link openBunReadOnly}'s macOS retry (`../chat-store-survey.ts`):
 * Apple's system libsqlite3, which Bun links on macOS, throws
 * `SQLITE_CANTOPEN` opening a WAL database read-only while its `-wal`/`-shm`
 * sidecars are absent - the state a clean close leaves - and the fix creates
 * only the MISSING ones, empty, with the db file's own permission bits, then
 * retries exactly once.
 *
 * `bun:sqlite` is a virtual module only Bun resolves; under this vitest
 * runner (Node) it does not exist at all, so it is `vi.doMock`ed here at
 * module scope, BEFORE the survey module is imported - and the import is
 * dynamic so that mock can never leak into a suite that does not ask for it.
 * The fake stands in for Apple's build over a REAL file, opened through real
 * `node:sqlite`, so every read below is a real SQLite read, not a stub.
 */
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { singleChatStoreSurveyRoot } from "../chat-store-survey-roots";

/** A thrown SQLite error, shaped the way Apple's build and this repo's own `errnoCodeOf` read it. */
interface FakeSqliteError extends Error {
  readonly code: string;
}

function sqliteError(code: string, message: string): FakeSqliteError {
  return Object.assign(new Error(message), { code });
}

/**
 * What each `FakeDatabase`'s first statement does, set per test.
 *
 * `normal` is Apple's real rule: CANTOPEN for a read-only connection while
 * `-shm` is absent. The other two force what Apple's build cannot be made to
 * reproduce on demand here - every time, or once and then recover.
 */
type FakeDatabaseMode =
  | { readonly kind: "normal" }
  | { readonly kind: "always-cantopen" }
  | { readonly kind: "throw-once"; readonly error: FakeSqliteError };

let fakeDatabaseCalls = 0;
let fakeDatabaseCloses = 0;
let fakeDatabaseMode: FakeDatabaseMode = { kind: "normal" };

/** One sidecar as it stood when a statement began, or `null` when absent. */
interface SidecarState {
  readonly size: number;
  readonly mode: number;
}

interface OpenSnapshot {
  readonly wal: SidecarState | null;
  readonly shm: SidecarState | null;
}

/**
 * The sidecars as each connection's first statement FOUND them, before the
 * real SQLite open below touches them. Asserting here rather than after the
 * survey is what makes the mode and size checks about the fix: SQLite's unix
 * VFS fchmods an empty sidecar to the database's mode and fills `-shm` on
 * open, so a check made afterwards would pass whatever the fix had created.
 */
let openSnapshots: OpenSnapshot[] = [];

function sidecarState(path: string): SidecarState | null {
  if (!existsSync(path)) return null;
  const stats = statSync(path);
  return { size: stats.size, mode: stats.mode & 0o777 };
}

/** Bun's `get` takes `unknown`; the survey only ever binds a string key. */
function sqlInput(value: unknown): SQLInputValue {
  if (typeof value === "string" || typeof value === "number") return value;
  throw new Error(`fake bun:sqlite cannot bind a ${typeof value}`);
}

/**
 * Stands in for Bun's `Database` over Apple's system libsqlite3.
 *
 * Where it throws is the point. Measured on macOS Bun 1.3.12 / libsqlite3
 * 3.54.0: `new Database(path, { readonly: true })` succeeds and reads
 * nothing, and the FIRST statement is what fails with SQLITE_CANTOPEN,
 * because SQLite opens the WAL when it first reads the schema. So the
 * constructor only counts, and `query()` - the prepare - applies Apple's
 * rule and otherwise prepares on a REAL `node:sqlite` read-only connection
 * over the same file, so a successful read is a real SQLite read.
 */
class FakeDatabase {
  private readonly filename: string;
  private readonly index: number;
  private real: DatabaseSync | null = null;

  constructor(filename: string, options: { readonly readonly: boolean }) {
    fakeDatabaseCalls += 1;
    this.index = fakeDatabaseCalls;
    this.filename = filename;
    expect(options.readonly).toBe(true);
  }

  query(sql: string): { get: (...params: readonly unknown[]) => unknown } {
    openSnapshots.push({
      wal: sidecarState(`${this.filename}-wal`),
      shm: sidecarState(`${this.filename}-shm`),
    });
    if (fakeDatabaseMode.kind === "always-cantopen") {
      throw sqliteError("SQLITE_CANTOPEN", "unable to open database file");
    }
    if (fakeDatabaseMode.kind === "throw-once" && this.index === 1) {
      throw fakeDatabaseMode.error;
    }
    if (!existsSync(`${this.filename}-shm`)) {
      throw sqliteError("SQLITE_CANTOPEN", "unable to open database file");
    }
    const real = new DatabaseSync(this.filename, { readOnly: true });
    this.real = real;
    const statement = real.prepare(sql);
    return {
      get: (...params: readonly unknown[]): unknown =>
        statement.get(...params.map(sqlInput)),
    };
  }

  close(): void {
    fakeDatabaseCloses += 1;
    this.real?.close();
  }
}

// Module scope, not inside a hook or a test: this runs while the file itself
// loads, before any `beforeEach`/`it` body, and therefore before the dynamic
// `import("../chat-store-survey")` below - which is exactly the ordering the
// production module's own `await import("bun:sqlite")` needs to see it.
vi.doMock("bun:sqlite", () => ({ Database: FakeDatabase }));

let chatStoreSurvey: typeof import("../chat-store-survey");

beforeAll(async () => {
  chatStoreSurvey = await import("../chat-store-survey");
});

let hostHome: string;

beforeEach(async () => {
  fakeDatabaseCalls = 0;
  fakeDatabaseCloses = 0;
  fakeDatabaseMode = { kind: "normal" };
  openSnapshots = [];
  // `process.versions` extends `Dict<string>` in `@types/node`, so a `bun`
  // key is legal without pulling in `@types/bun` - see `src/types/bun-sqlite.d.ts`
  // for why this package deliberately carries no Bun types at all.
  Object.defineProperty(process.versions, "bun", {
    value: "1.3.12",
    configurable: true,
  });
  hostHome = await mkdtemp(
    join(tmpdir(), "chat-store-survey-bun-engine-test-"),
  );
});

afterEach(async () => {
  // Every connection opened - the failed first one included - is closed.
  expect(fakeDatabaseCloses).toBe(fakeDatabaseCalls);
  delete process.versions.bun;
  expect(process.versions.bun).toBeUndefined();
  await rm(hostHome, { recursive: true, force: true });
});

async function epicDbPath(epicId: string): Promise<string> {
  const dbPath = chatStoreSurvey.chatDbPathFor(hostHome, epicId);
  await mkdir(
    join(hostHome, chatStoreSurvey.EPIC_STATE_DIRNAME, epicId, "chat"),
    { recursive: true },
  );
  return dbPath;
}

/** A real WAL-mode store, written the same way the sibling suite's fixtures are. */
async function writeWalStampedChatDb(
  path: string,
  schemaVersion: number,
): Promise<void> {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(
      "CREATE TABLE chat_db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    db.prepare("INSERT INTO chat_db_meta (key, value) VALUES (?, ?)").run(
      "schema_version",
      String(schemaVersion),
    );
  } finally {
    db.close();
  }
}

/** node:sqlite's clean close normally removes both sidecars; this makes that the explicit starting state. */
async function removeSidecarsIfPresent(dbPath: string): Promise<void> {
  await rm(`${dbPath}-wal`, { force: true });
  await rm(`${dbPath}-shm`, { force: true });
}

describe("Bun engine read-only open (macOS CANTOPEN retry)", () => {
  it("sidecars absent: creates both, empty, with the db's own mode, and reads the stamp in exactly 2 opens", async () => {
    const dbPath = await epicDbPath("epic-sidecars-absent");
    await writeWalStampedChatDb(dbPath, 9);
    await removeSidecarsIfPresent(dbPath);
    // Other-write is stripped by both common umasks (022 and 002), and no
    // constant a fix might hard-code looks like this, so a match proves the
    // mode came FROM the db and survived the umask through the fchmod.
    await chmod(dbPath, 0o662);

    const survey = await chatStoreSurvey.surveyChatDbStamps(
      singleChatStoreSurveyRoot(hostHome),
    );

    expect(survey).toEqual({
      readings: [{ epicId: "epic-sidecars-absent", schemaVersion: 9 }],
      failures: [],
    });
    expect(fakeDatabaseCalls).toBe(2);
    expect(openSnapshots[0]).toEqual({ wal: null, shm: null });
    for (const created of [openSnapshots[1].wal, openSnapshots[1].shm]) {
      expect(created?.size).toBe(0);
      if (platform !== "win32") expect(created?.mode).toBe(0o662);
    }
  });

  it("sidecars present from the start, including a non-empty -wal: exactly 1 open, sidecar left untouched", async () => {
    const dbPath = await epicDbPath("epic-sidecars-present");
    await writeWalStampedChatDb(dbPath, 9);
    await removeSidecarsIfPresent(dbPath);
    // Fabricated, not a real WAL/SHM image - verified separately that real
    // SQLite tolerates an invalid WAL header on a read-only open by simply
    // ignoring it (falls back to the already-committed main file), so
    // arbitrary bytes here do not make node:sqlite reject the file.
    const walBytes = Buffer.from("known-wal-bytes-present-from-the-start");
    const shmBytes = Buffer.from("known-shm-bytes-present-from-the-start");
    await writeFile(`${dbPath}-wal`, walBytes);
    await writeFile(`${dbPath}-shm`, shmBytes);

    const survey = await chatStoreSurvey.surveyChatDbStamps(
      singleChatStoreSurveyRoot(hostHome),
    );

    expect(survey).toEqual({
      readings: [{ epicId: "epic-sidecars-present", schemaVersion: 9 }],
      failures: [],
    });
    // `-shm` already existed, so the fake never throws CANTOPEN at all - the
    // fix's own sidecar-creation code never runs in this case.
    expect(fakeDatabaseCalls).toBe(1);
    expect(openSnapshots[0].wal?.size).toBe(walBytes.length);
    expect(openSnapshots[0].shm?.size).toBe(shmBytes.length);

    // `-wal` only: a real read-only open rewrites `-shm`'s wal-index itself.
    const walAfter = await readFile(`${dbPath}-wal`);
    expect(walAfter.equals(walBytes)).toBe(true);
  });

  it("-wal present with known bytes, -shm absent: only -shm is created, -wal is untouched, exactly 2 opens", async () => {
    const dbPath = await epicDbPath("epic-wal-only");
    await writeWalStampedChatDb(dbPath, 9);
    await removeSidecarsIfPresent(dbPath);
    const walBytes = Buffer.from("known-wal-bytes-wal-only-case");
    await writeFile(`${dbPath}-wal`, walBytes);

    const survey = await chatStoreSurvey.surveyChatDbStamps(
      singleChatStoreSurveyRoot(hostHome),
    );

    expect(survey).toEqual({
      readings: [{ epicId: "epic-wal-only", schemaVersion: 9 }],
      failures: [],
    });
    expect(fakeDatabaseCalls).toBe(2);
    // At the retry: `-wal` still holds its bytes (`wx` met EEXIST and left it)
    // and `-shm` is the one the fix created, empty.
    expect(openSnapshots[1].wal?.size).toBe(walBytes.length);
    expect(openSnapshots[1].shm?.size).toBe(0);

    const walAfter = await readFile(`${dbPath}-wal`);
    expect(walAfter.equals(walBytes)).toBe(true);
  });

  it("CANTOPEN on every open: the epic fails as unreadable-chat-db, and the retry is not itself retried (exactly 2 opens)", async () => {
    const dbPath = await epicDbPath("epic-always-cantopen");
    await writeWalStampedChatDb(dbPath, 9);
    await removeSidecarsIfPresent(dbPath);
    fakeDatabaseMode = { kind: "always-cantopen" };

    const survey = await chatStoreSurvey.surveyChatDbStamps(
      singleChatStoreSurveyRoot(hostHome),
    );

    expect(survey.readings).toEqual([]);
    expect(survey.failures).toEqual([
      { epicId: "epic-always-cantopen", reason: "unreadable-chat-db" },
    ]);
    expect(fakeDatabaseCalls).toBe(2);
  });

  it("a non-CANTOPEN error on the first open is not retried at all: unreadable-chat-db, exactly 1 open, no sidecar created", async () => {
    const dbPath = await epicDbPath("epic-non-cantopen");
    await writeWalStampedChatDb(dbPath, 9);
    await removeSidecarsIfPresent(dbPath);
    fakeDatabaseMode = {
      kind: "throw-once",
      error: sqliteError("SQLITE_CORRUPT", "database disk image is malformed"),
    };

    const survey = await chatStoreSurvey.surveyChatDbStamps(
      singleChatStoreSurveyRoot(hostHome),
    );

    expect(survey.readings).toEqual([]);
    expect(survey.failures).toEqual([
      { epicId: "epic-non-cantopen", reason: "unreadable-chat-db" },
    ]);
    expect(fakeDatabaseCalls).toBe(1);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });
});
