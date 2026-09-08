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
 * Node's built-in `node:sqlite`, never `better-sqlite3`. The CLI is a Node
 * SEA with no native addons on purpose (`scripts/build-cli-sea.cjs`), and a
 * separately shipped `.node` file is the exact shape that failed to load
 * pre-3.0 (a code-signing mismatch on the extension-era `sqlite3` addon). The
 * built-in is compiled into the signed executable itself, so there is no
 * second file to be mis-signed or wrong-arch, and it costs the binary nothing.
 *
 * The import is DYNAMIC so the module loads only on the downgrade path this
 * survey serves, and every failure - a Node build without the module, a locked
 * or unreadable file, a store with no stamp row - is a `failures` entry that
 * the verdict reads as INDETERMINATE and refuses. Nothing here returns a
 * plausible wrong stamp.
 *
 * ## Read-only, and what that does not protect against
 *
 * `readOnly: true` means this connection can never write the database. It
 * does not stop SQLite mapping the `-shm` sidecar for a WAL-mode file, which
 * is why an unwritable directory is a failure rather than a silent `0`. It
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
      failures: [{ epicId: "*", reason: describeFailure(error) }],
    };
  }
  const readings: ChatDbStampReading[] = [];
  const failures: ChatDbStampFailure[] = [];
  for (const epicId of [...entries].sort()) {
    const dbPath = chatDbPathFor(hostHome, epicId);
    if (!(await chatDbExists(dbPath))) continue;
    try {
      readings.push({
        epicId,
        schemaVersion: await readChatDbSchemaVersion(dbPath),
      });
    } catch (error: unknown) {
      failures.push({ epicId, reason: describeFailure(error) });
    }
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

/**
 * The stamp one store carries. Throws on ANY way of not learning it, so the
 * caller records a failure instead of a fabricated version.
 */
async function readChatDbSchemaVersion(dbPath: string): Promise<number> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare(`SELECT value FROM ${CHAT_DB_META_TABLE} WHERE key = ?`)
      .get(CHAT_DB_SCHEMA_VERSION_KEY);
    if (row === undefined) {
      throw new Error(
        `${CHAT_DB_META_TABLE} carries no ${CHAT_DB_SCHEMA_VERSION_KEY} row`,
      );
    }
    return parseSchemaVersion(row.value);
  } finally {
    db.close();
  }
}

function parseSchemaVersion(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `${CHAT_DB_SCHEMA_VERSION_KEY} is not a positive integer: ${JSON.stringify(value)}`,
    );
  }
  return parsed;
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

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
