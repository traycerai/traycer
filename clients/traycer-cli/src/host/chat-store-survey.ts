/**
 * The CLI's read of every per-epic chat store's format stamp.
 *
 * Feeds `decideStoreFormatFloor` (`@traycer/protocol/host/store-formats`)
 * before the CLI lands an OLDER host over a data directory: a target build
 * that cannot open a file already on disk must be refused before any bytes
 * move, and the only way to know is to read the stamp each file carries.
 *
 * ## Engine
 *
 * Whichever SQLite the RUNTIME already has, resolved once per survey:
 * `bun:sqlite` under Bun, Node's built-in `node:sqlite` otherwise. Never
 * `better-sqlite3`. The CLI is a Node SEA with no native addons on purpose
 * (`scripts/build-cli-sea.cjs`), and a separately shipped `.node` file is the
 * exact shape that failed to load pre-3.0 (a code-signing mismatch on the
 * extension-era `sqlite3` addon). Both built-ins are compiled into their own
 * runtime, so there is no second file to be mis-signed or wrong-arch, and
 * neither costs the binary anything.
 *
 * BOTH are needed, and this is not defensive breadth. The released binary is
 * Node and has only `node:sqlite`; the repo's own dev loop runs the CLI from
 * source under Bun (`traycer/Makefile`, `scripts/dev-desktop.js`), which has
 * only `bun:sqlite` - `node:sqlite` there is not a degraded read, it is
 * `No such built-in module`. With one engine, every `make dev-desktop` whose
 * installed host predates the format sidecar would survey, fail on every
 * epic, and refuse the install while blaming files that are perfectly fine.
 *
 * The import is DYNAMIC so the module loads only on the paths this survey
 * serves, and it is resolved ONCE for the whole survey rather than per epic:
 * a missing engine is one fact about the runtime, and reporting it per file
 * would turn it into N claims about the user's data.
 *
 * Every other failure - a locked or unreadable file, a store with no stamp
 * row - is a `failures` entry that the verdict reads as INDETERMINATE and
 * refuses. Nothing here returns a plausible wrong stamp.
 *
 * ## Read-only, and what that does not protect against
 *
 * Read-only means this connection can never write the database. It does not
 * stop SQLite mapping the `-shm` sidecar for a WAL-mode file, which is why an
 * unwritable directory is a failure rather than a silent `0`. (A WAL file
 * whose `-shm` is merely absent reads fine on both engines - verified - as
 * long as the directory can be written; it is the directory that decides.) It
 * also never runs a migration: the stamp is read off `chat_db_meta` directly,
 * not through the host's store open, which migrates on sight.
 *
 * Absent stores are neither readings nor failures. An epic directory without
 * `chat/chat.db` has nothing the target could fail to read.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  ChatDbStampFailure,
  ChatDbStampFailureReason,
  ChatDbStampReading,
  ChatDbStampSurvey,
} from "@traycer/protocol/host/store-formats";

/** Directory under the host home holding one directory per epic. */
export const EPIC_STATE_DIRNAME = "epic-state";

/** The chat store's path within an epic's state directory. */
export const CHAT_DB_RELATIVE_PATH = join("chat", "chat.db");

/** The table and key the host stamps its schema version under. */
const CHAT_DB_META_TABLE = "chat_db_meta";
const CHAT_DB_SCHEMA_VERSION_KEY = "schema_version";

/**
 * The `epicId` a failure carries when it is about the survey as a whole
 * rather than one epic. Matches the host ledger's sentinel so a reader of
 * either side reads the same thing.
 */
const WHOLE_SURVEY_EPIC_ID = "*";

/**
 * Longest `schema_version` text this will even attempt to parse.
 *
 * A stamp is a small positive integer; nothing legitimate is close to this.
 * The bound exists so a corrupt row holding a multi-megabyte blob is rejected
 * BEFORE the digit test walks it, and never on the strength of the regex
 * alone.
 */
const MAX_SCHEMA_VERSION_TEXT_LENGTH = 20;

/**
 * Longest epic id rendered into a message, a log line or an error envelope.
 *
 * An epic id here is a DIRECTORY NAME - it is whatever is on disk, not a
 * validated uuid - so it is subject to the same rule as any other untrusted
 * value that reaches a log: bounded, and printable. Real ids are uuids and
 * pass through untouched.
 */
const MAX_EPIC_ID_RENDER_LENGTH = 64;

export function chatDbPathFor(hostHome: string, epicId: string): string {
  return join(hostHome, EPIC_STATE_DIRNAME, epicId, CHAT_DB_RELATIVE_PATH);
}

/**
 * Read the schema stamp of every chat store under `hostHome`.
 *
 * `hostHome` is the host DATA root the target install would serve - the
 * `hostHomeDir(environment)` the CLI passes as `--host-data-dir`, never the
 * install directory. A missing `epic-state` directory is an empty survey: a
 * host that has never opened an epic has nothing at risk.
 */
export async function surveyChatDbStamps(
  hostHome: string,
): Promise<ChatDbStampSurvey> {
  const epicStateDir = join(hostHome, EPIC_STATE_DIRNAME);
  let entries: readonly string[];
  try {
    entries = await readdir(epicStateDir);
  } catch (error: unknown) {
    // ENOENT ALONE is emptiness. Everything else - EACCES on a root that is
    // there, ENOTDIR for a root that exists but is a file - is a root this
    // survey could not ENUMERATE, and reporting that as "no stores" would hand
    // `decideStoreFormatFloor` an empty survey, which it clears
    // unconditionally. A floor that cannot read the directory must refuse, so
    // the inability travels as a failure entry.
    if (isNotFound(error)) return { readings: [], failures: [] };
    return {
      readings: [],
      failures: [
        {
          epicId: WHOLE_SURVEY_EPIC_ID,
          reason: "unreadable-epic-state-directory",
        },
      ],
    };
  }
  const epicIds = [...entries].sort();
  // Nothing to open, so the engine is never asked for. This matters beyond
  // speed: a machine with no epics must not report `engine-unavailable` and
  // refuse, because there is no data there for any target to fail to read.
  if (epicIds.length === 0) return { readings: [], failures: [] };

  const reader = await openChatDbStampReader();
  if (reader === null) {
    // ONE entry, not one per epic. The runtime has no SQLite; that is a fact
    // about this process, and N copies of it would read as N damaged files.
    return {
      readings: [],
      failures: [
        { epicId: WHOLE_SURVEY_EPIC_ID, reason: "engine-unavailable" },
      ],
    };
  }

  const readings: ChatDbStampReading[] = [];
  const failures: ChatDbStampFailure[] = [];
  for (const epicId of epicIds) {
    const dbPath = chatDbPathFor(hostHome, epicId);
    if (!(await chatDbExists(dbPath))) continue;
    const outcome = reader.readStamp(dbPath);
    if (outcome.kind === "stamp") {
      readings.push({
        epicId: renderEpicId(epicId),
        schemaVersion: outcome.schemaVersion,
      });
      continue;
    }
    failures.push({ epicId: renderEpicId(epicId), reason: outcome.reason });
  }
  return { readings, failures };
}

async function chatDbExists(dbPath: string): Promise<boolean> {
  try {
    return (await stat(dbPath)).isFile();
  } catch (error: unknown) {
    if (isMissingPath(error)) return false;
    // Anything else (a permission error, a dangling link) is left to the
    // open below to fail loudly, rather than quietly reading as "no store".
    return true;
  }
}

/** One store's outcome: a stamp, or the finite reason there is none. */
type ChatDbStampOutcome =
  | { readonly kind: "stamp"; readonly schemaVersion: number }
  | { readonly kind: "failure"; readonly reason: ChatDbStampFailureReason };

/**
 * One open store, reduced to the single question this module asks it.
 *
 * The seam is the QUERY, not the client object, because the two runtimes'
 * clients differ in ways that must not leak past here: the constructor's
 * option name (`readOnly` vs `readonly`), the prepared-statement accessor
 * (`prepare` vs `query`), and the empty-row value (`undefined` vs `null`).
 */
interface OpenChatDb {
  /** The `schema_version` row, in whatever shape the engine returns it. */
  readonly stampRow: () => unknown;
  readonly close: () => void;
}

/** A resolved engine: it can open a store read-only, or throw trying. */
interface ChatDbStampReader {
  readonly readStamp: (dbPath: string) => ChatDbStampOutcome;
}

const SELECT_STAMP_SQL = `SELECT value FROM ${CHAT_DB_META_TABLE} WHERE key = ?`;

/**
 * The engine for this runtime, or `null` when it has none.
 *
 * Bun is asked only when `process.versions.bun` is set, so the released Node
 * binary never attempts a specifier its bundle does not carry. Both build
 * scripts mark `bun:sqlite` external for the same reason: it is a virtual
 * module only Bun can resolve, and the bundle never runs there.
 */
async function openChatDbStampReader(): Promise<ChatDbStampReader | null> {
  const open =
    process.versions.bun === undefined
      ? await nodeChatDbOpener()
      : await bunChatDbOpener();
  if (open === null) return null;
  return { readStamp: (dbPath: string) => readStampWith(open, dbPath) };
}

/** Opens one store read-only. Throws if the file cannot be opened. */
type ChatDbOpener = (dbPath: string) => OpenChatDb;

async function nodeChatDbOpener(): Promise<ChatDbOpener | null> {
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return null;
  }
  return (dbPath: string): OpenChatDb => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    return {
      stampRow: () =>
        db.prepare(SELECT_STAMP_SQL).get(CHAT_DB_SCHEMA_VERSION_KEY),
      close: () => db.close(),
    };
  };
}

async function bunChatDbOpener(): Promise<ChatDbOpener | null> {
  let Database: typeof import("bun:sqlite").Database;
  try {
    ({ Database } = await import("bun:sqlite"));
  } catch {
    return null;
  }
  return (dbPath: string): OpenChatDb => {
    const db = new Database(dbPath, { readonly: true });
    return {
      stampRow: () =>
        db.query(SELECT_STAMP_SQL).get(CHAT_DB_SCHEMA_VERSION_KEY),
      close: () => db.close(),
    };
  };
}

/**
 * One store's stamp through a resolved engine.
 *
 * Every throw below the open - a corrupt page, a missing `chat_db_meta`, a
 * lock, an unwritable directory under a WAL file - is the same finite answer:
 * this file could not be read. The distinction the codes DO keep is between
 * that and a file that read fine but carries no usable stamp, because only
 * one of those two is a damaged database.
 */
function readStampWith(open: ChatDbOpener, dbPath: string): ChatDbStampOutcome {
  let db: OpenChatDb;
  try {
    db = open(dbPath);
  } catch {
    return { kind: "failure", reason: "unreadable-chat-db" };
  }
  try {
    return stampFromRow(db.stampRow());
  } catch {
    return { kind: "failure", reason: "unreadable-chat-db" };
  } finally {
    db.close();
  }
}

/**
 * One engine's row into an outcome.
 *
 * `undefined` is Node's empty result and `null` is Bun's; both mean the same
 * thing, and a stamp that is present but unusable is deliberately the SAME
 * answer as an absent one - neither tells us what the store speaks.
 */
function stampFromRow(row: unknown): ChatDbStampOutcome {
  if (row === null || typeof row !== "object") return MISSING_STAMP;
  const schemaVersion = parseSchemaVersion(
    (row as Record<string, unknown>).value,
  );
  if (schemaVersion === null) return MISSING_STAMP;
  return { kind: "stamp", schemaVersion };
}

const MISSING_STAMP: ChatDbStampOutcome = {
  kind: "failure",
  reason: "missing-or-invalid-schema-version",
};

/**
 * The stamp a row holds, or `null` for every way of not holding one.
 *
 * Returns rather than throws, and never renders the offending value: the
 * caller's job is to record a finite reason code, and a message carrying the
 * stored bytes is exactly what this must not produce.
 */
function parseSchemaVersion(value: unknown): number | null {
  if (typeof value === "number") return positiveStamp(value);
  if (typeof value !== "string") return null;
  if (value.length > MAX_SCHEMA_VERSION_TEXT_LENGTH) return null;
  if (!/^\d+$/.test(value)) return null;
  return positiveStamp(Number.parseInt(value, 10));
}

function positiveStamp(parsed: number): number | null {
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

/**
 * An epic id, bounded and printable, for the message and envelope it ends up
 * in. Out-of-charset bytes become `_` so a control character cannot close a
 * log line and open a forged one; a truncation is marked with a trailing `~`,
 * which the charset excludes and so cannot be mistaken for content.
 */
function renderEpicId(epicId: string): string {
  const printable = epicId.replace(/[^A-Za-z0-9_.-]/g, "_");
  if (printable.length <= MAX_EPIC_ID_RENDER_LENGTH) return printable;
  return `${printable.slice(0, MAX_EPIC_ID_RENDER_LENGTH)}~`;
}

/**
 * Absent, and nothing else. Used for the `epic-state` root, where "not there"
 * is the legitimate empty answer and every other errno is an enumeration this
 * survey owes the caller as a failure.
 */
function isNotFound(error: unknown): boolean {
  return errnoCodeOf(error) === "ENOENT";
}

/**
 * Absent OR shadowed by a non-directory component. Used for the per-epic
 * `chat/chat.db` probe, where both mean the same thing - this epic has no chat
 * store - and neither is anything the target build could fail to open.
 */
function isMissingPath(error: unknown): boolean {
  const code = errnoCodeOf(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function errnoCodeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  return typeof error.code === "string" ? error.code : null;
}
