import {
  appendFileSync,
  close as closeCallback,
  mkdirSync,
  open as openCallback,
} from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { Environment } from "../runner/environment";
import {
  bootstrapLogPath,
  ensureHostHomeDir,
  hostHomeDir,
} from "../store/paths";

// Async open that resolves to a BARE integer fd (the callback `fs.open`
// contract), not a `FileHandle` - see `openBootstrapLogFd`.
const openRawFd = promisify(openCallback);
const closeRawFdImpl = promisify(closeCallback);

// Bootstrap-log line format (contract shared with the host writer):
//   [<iso-timestamp>] phase=<name> key=value key=value … writer=supervisor
// Values containing whitespace or quotes are wrapped in double quotes with
// inner quotes doubled. The renderer's failure card and `traycer host
// status` both parse these markers; raw stdout/stderr lines from the shell
// and host are also captured in the same file and pass through as-is.
//
// ## Why markers carry a writer field
//
// `host.log` is BOTH the marker destination and the child's stderr sink -
// the supervisor spawns with `stdio: ["ignore", logFd, logFd]`, and the
// host's own logger appends to the same path. So any line the host prints
// that happens to start `[<iso>] phase=<name>` used to parse as a marker
// indistinguishable from one the supervisor wrote. That is not theoretical
// bookkeeping: consumers treat markers as authority (`spawn-evidence`,
// `host-status`, Doctor's `RECENT_CRASH_MARKERS`, and gui-app's bootstrap
// attempt summary), and a stray `phase=starting` line cancels a real crash
// signal in Doctor's `lastCrashMarker` scan - a crashed host reporting
// clean. Every marker therefore ends with `writer=supervisor`, emitted by
// {@link formatMarkerLine} for every writer, never by a caller.
//
// **What this does and does not defend against.** The host can write to
// this file, so it could copy any token we put in the line. This is not a
// security boundary and no in-band field could make it one - the fix for
// that is separate sinks (see `host-log-rotation.ts`, which already scopes
// that out). What it does close is ACCIDENTAL collision, which is the real
// exposure: one refactor that starts a host log message with `phase=` is
// enough today.
//
// ## N-1 overlap: strictness is latched on the file's own evidence
//
// Markers written by an older CLI carry no `writer` field, and they persist
// in `host.log` across restarts until rotation. Dropping unstamped lines
// unconditionally would blind Doctor to a genuine crash recorded by the
// previous version; trusting them unconditionally leaves the hole open. So
// {@link retainAuthenticMarkers} splits the file at a POSITION - the first
// stamped marker:
//
//   - before it -> the writer had not yet identified itself, so every
//     marker-shaped line is kept (byte-identical behaviour to before);
//   - from it onward -> the writer demonstrably stamps its markers, so an
//     unstamped marker-shaped line is raw output.
//
// The boundary has to be positional rather than a property of the whole
// file, because the ORDINARY upgrade puts both eras in one log: an old CLI
// records a real `phase=crashed`, the user upgrades, and the next start
// appends a stamped `phase=starting` to the same file. A whole-file rule
// would let that stamped marker retroactively delete the older real crash
// on every upgrade - destroying the history this compatibility path exists
// to protect.
//
// Known limitation, accepted deliberately: if an OLDER CLI writes markers
// AFTER a stamped one (a downgrade, or a stale binary earlier on PATH),
// those land past the boundary and are read as raw output. That is far
// rarer than the upgrade path, and it fails in the same direction as the
// collision it closes - under-reporting - rather than inventing a crash.

export type BootstrapPhase =
  | "starting"
  | "exited"
  | "crashed"
  | "killed"
  | "failed-to-spawn";

// Every field is explicit (no optional `?:` per project style). Callers
// pass `undefined` for unset fields; `formatFields` skips any field
// whose value is `undefined` (or `null` for the nullable members).
//
// `attemptId` + `supervisorPid` are additive identity fields (Finding F):
// new writers always set them; old parsers ignore unknown keys so the
// append-only format stays backward-compatible. Baseline correlation
// remains the compat path for hosts started by older CLIs that omit them.
export interface BootstrapMarkerFields {
  readonly shell: string | undefined;
  readonly args: readonly string[] | undefined;
  readonly bundle: string | undefined;
  readonly exitCode: number | null | undefined;
  readonly signal: string | null | undefined;
  readonly error: string | undefined;
  /**
   * Decoded meaning of a high-bit `exitCode` (hex + NTSTATUS name, see
   * `crash-diagnostics.ts`). Additive: old parsers ignore unknown keys.
   */
  readonly exitMeaning: string | undefined;
  /**
   * Filename of the Node diagnostic report written by this child (newest
   * report younger than the spawn), for `phase=crashed` markers.
   */
  readonly report: string | undefined;
  /**
   * Newline-escaped tail of the child's stderr - the V8/native fatal text
   * that used to be stranded in a rotated-away `host.log.1`.
   */
  readonly stderrTail: string | undefined;
  readonly attemptId: string | undefined;
  readonly supervisorPid: number | undefined;
}

// The key/value that identify a line as supervisor-written. Deliberately
// NOT a member of `BootstrapMarkerFields`: a caller that forgot to pass it
// would silently mint an unverified marker, so `formatMarkerLine` appends
// it for every writer instead.
export const MARKER_WRITER_KEY = "writer";
export const MARKER_WRITER_SUPERVISOR = "supervisor";

/**
 * Provenance of a parsed marker line.
 *
 * `"supervisor"` - carries {@link MARKER_WRITER_KEY}, so a marker writer
 * produced it. `"unverified"` - marker-SHAPED, but with no writer field:
 * either an older CLI wrote it, or it is host/shell output that happens to
 * match the grammar. Which of those it is cannot be decided per line; see
 * {@link retainAuthenticMarkers}, which decides it per file.
 */
export type BootstrapMarkerWriter = "supervisor" | "unverified";

export interface BootstrapLogEntry {
  readonly timestamp: string;
  readonly phase: BootstrapPhase;
  readonly fields: Record<string, string>;
  readonly writer: BootstrapMarkerWriter;
}

function escapeValue(value: string): string {
  if (/[\s"]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function formatFields(fields: BootstrapMarkerFields): string {
  const parts: string[] = [];
  if (fields.shell !== undefined)
    parts.push(`shell=${escapeValue(fields.shell)}`);
  if (fields.args !== undefined)
    parts.push(`args=${escapeValue(JSON.stringify(fields.args))}`);
  if (fields.bundle !== undefined)
    parts.push(`bundle=${escapeValue(fields.bundle)}`);
  if (fields.exitCode !== undefined && fields.exitCode !== null)
    parts.push(`code=${fields.exitCode}`);
  if (fields.signal !== undefined && fields.signal !== null)
    parts.push(`signal=${fields.signal}`);
  if (fields.error !== undefined)
    parts.push(`error=${escapeValue(fields.error)}`);
  if (fields.exitMeaning !== undefined)
    parts.push(`exitMeaning=${escapeValue(fields.exitMeaning)}`);
  if (fields.report !== undefined)
    parts.push(`report=${escapeValue(fields.report)}`);
  if (fields.stderrTail !== undefined)
    parts.push(`stderrTail=${escapeValue(fields.stderrTail)}`);
  // Identity fields last so pre-existing key=value parsers that only
  // walk known keys keep working, and so a human reading the line still
  // sees the diagnostic payload first.
  if (fields.attemptId !== undefined)
    parts.push(`attempt=${escapeValue(fields.attemptId)}`);
  if (fields.supervisorPid !== undefined)
    parts.push(`supervisorPid=${fields.supervisorPid}`);
  return parts.join(" ");
}

// The single place a marker line is built. Both writers go through it so
// the writer field cannot be emitted by one path and forgotten by the
// other - the whole guarantee is "every marker carries it", and two
// independent format strings are how that guarantee rots.
//
// The writer field goes LAST, with the other identity fields, for the
// reason already recorded above `formatFields`: a human reading the line
// sees the diagnostic payload first.
function formatMarkerLine(
  timestamp: string,
  phase: BootstrapPhase,
  fields: BootstrapMarkerFields,
): string {
  const fieldsStr = formatFields(fields);
  const identity = `${MARKER_WRITER_KEY}=${MARKER_WRITER_SUPERVISOR}`;
  const payload =
    fieldsStr.length === 0 ? identity : `${fieldsStr} ${identity}`;
  return `[${timestamp}] phase=${phase} ${payload}\n`;
}

export async function writeBootstrapMarker(
  environment: Environment,
  phase: BootstrapPhase,
  fields: BootstrapMarkerFields,
): Promise<void> {
  await ensureHostHomeDir(environment);
  const line = formatMarkerLine(new Date().toISOString(), phase, fields);
  await appendFile(bootstrapLogPath(environment), line);
}

// Exit handlers cannot await an asynchronous append before calling
// `process.exit()`: Node can terminate before the promise has reached disk.
// Terminal markers are readiness authority, so write them synchronously at
// that process boundary. Normal `starting` / pre-spawn failure markers retain
// the non-blocking writer above.
export function writeBootstrapTerminalMarker(
  environment: Environment,
  phase: Exclude<BootstrapPhase, "starting">,
  fields: BootstrapMarkerFields,
): void {
  mkdirSync(hostHomeDir(environment), { recursive: true });
  const line = formatMarkerLine(new Date().toISOString(), phase, fields);
  appendFileSync(bootstrapLogPath(environment), line);
}

// Opens the bootstrap log for spawn(stdio: [_, fd, fd]) handoff and
// returns the raw integer fd.
//
// The fd must be a BARE descriptor, not a `fsPromises.open` `FileHandle`:
// the supervisor hands it to spawn() and must keep it open for the child's
// whole lifetime, so we can neither close the handle (that closes the fd
// spawn still needs) nor drop it. A `FileHandle` left open but unreferenced
// is reaped by V8 at the next GC, and on Node >= 24 a GC-closed FileHandle
// is a FATAL `ERR_INVALID_STATE` (only a deprecation warning before) - which
// crashed the `host start` supervisor whenever GC ran (exit 1, launchd
// KeepAlive relaunch loop). A bare fd has no finalizer, so it lives until
// the process exits or the child dup()s it.
//
// The bare-fd requirement is about the RETURN type, not about blocking: the
// callback `fs.open` (promisified above) opens off-thread like every other
// async fs call here, yet still yields a plain integer fd - so this stays
// fully async without reintroducing the FileHandle finalizer.
export async function openBootstrapLogFd(
  environment: Environment,
): Promise<number> {
  await ensureHostHomeDir(environment);
  return openRawFd(bootstrapLogPath(environment), "a");
}

/**
 * Release a descriptor handed out by {@link openBootstrapLogFd}.
 *
 * Never throws: this runs on the supervisor's recovery path, where failing to
 * close a descriptor is a leak and throwing would be an outage. A double close
 * (EBADF) is likewise not worth propagating.
 */
export async function closeRawFd(fd: number): Promise<void> {
  try {
    await closeRawFdImpl(fd);
  } catch {
    // Best effort by design - see above.
  }
}

const LINE_RE = /^\[([^\]]+)\] phase=(\w[\w-]*)(?:\s+(.*))?$/;

// Exported so spawn-evidence and unit tests can parse a single log line
// without re-implementing the key=value grammar. Unknown keys (including
// the additive attempt/supervisorPid fields) land in `fields` as strings.
//
// A single line CANNOT decide whether an unverified marker is an older
// CLI's or host output wearing the grammar, so this labels
// (`entry.writer`) and never drops. Run the result through
// {@link retainAuthenticMarkers} before treating markers as authority.
export function parseBootstrapLogLine(line: string): BootstrapLogEntry | null {
  return parseLine(line);
}

/** True once any entry proves the writer emits {@link MARKER_WRITER_KEY}. */
export function markersIdentifyWriter(
  entries: readonly BootstrapLogEntry[],
): boolean {
  return entries.some((entry) => entry.writer === "supervisor");
}

/**
 * Applies the N-1 latch described at the top of this file. The boundary is
 * POSITIONAL, not a property of the whole region: entries before the first
 * stamped marker are kept as-is, and only from that marker onward is an
 * unstamped line treated as raw output.
 *
 * Position matters because the ordinary upgrade path puts both eras in one
 * file. An old CLI records a genuine `phase=crashed`, the user upgrades,
 * and the next start appends a stamped `phase=starting` to the same
 * `host.log`. Filtering the region as a whole would let that first stamped
 * marker retroactively delete the older real crash - destroying exactly the
 * history the N-1 path exists to preserve, on every upgrade rather than in
 * some rare corner.
 *
 * `writerIdentifiedBefore` says the writer had already stamped a marker
 * STRICTLY BEFORE this region, which makes the whole region post-boundary.
 * It is a parameter rather than something re-derived from `entries` because
 * capability is monotonic while `entries` may be a truncated window: a
 * caller that caps its buffer can evict the stamped marker and be left
 * holding unstamped lines, and re-deriving there would reopen the hole.
 *
 * Pure and idempotent, so an accumulating caller can hold the labelled
 * entries and re-derive the authoritative view on each read - which it
 * must, since a stamped marker arriving in a later chunk retroactively
 * demotes the unstamped lines that followed the boundary.
 */
export function retainAuthenticMarkers(
  entries: readonly BootstrapLogEntry[],
  writerIdentifiedBefore: boolean,
): readonly BootstrapLogEntry[] {
  if (writerIdentifiedBefore) {
    return entries.filter((entry) => entry.writer === "supervisor");
  }
  const boundary = entries.findIndex((entry) => entry.writer === "supervisor");
  if (boundary === -1) return entries;
  return [
    ...entries.slice(0, boundary),
    ...entries.slice(boundary).filter((entry) => entry.writer === "supervisor"),
  ];
}

function parseLine(line: string): BootstrapLogEntry | null {
  const match = LINE_RE.exec(line);
  if (match === null) return null;
  const timestamp = match[1] ?? "";
  const phase = (match[2] ?? "") as BootstrapPhase;
  const rest = match[3] ?? "";
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < rest.length) {
    while (i < rest.length && /\s/.test(rest[i] ?? "")) i++;
    if (i >= rest.length) break;
    const eqIdx = rest.indexOf("=", i);
    if (eqIdx === -1) break;
    const key = rest.slice(i, eqIdx);
    let valueStart = eqIdx + 1;
    let value: string;
    if (rest[valueStart] === '"') {
      valueStart++;
      let valueEnd = valueStart;
      let unescaped = "";
      while (valueEnd < rest.length) {
        const ch = rest[valueEnd] ?? "";
        if (ch === '"' && rest[valueEnd + 1] === '"') {
          unescaped += '"';
          valueEnd += 2;
          continue;
        }
        if (ch === '"') break;
        unescaped += ch;
        valueEnd++;
      }
      value = unescaped;
      i = valueEnd + 1;
    } else {
      let valueEnd = valueStart;
      while (valueEnd < rest.length && !/\s/.test(rest[valueEnd] ?? "")) {
        valueEnd++;
      }
      value = rest.slice(valueStart, valueEnd);
      i = valueEnd;
    }
    fields[key] = value;
  }
  const writer: BootstrapMarkerWriter =
    fields[MARKER_WRITER_KEY] === MARKER_WRITER_SUPERVISOR
      ? "supervisor"
      : "unverified";
  return { timestamp, phase, fields, writer };
}

export async function readBootstrapMarkers(
  environment: Environment | undefined,
  maxEntries: number,
): Promise<readonly BootstrapLogEntry[]> {
  let raw: string;
  try {
    raw = await readFile(bootstrapLogPath(environment), "utf8");
  } catch {
    return [];
  }
  const entries: BootstrapLogEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (parsed !== null) entries.push(parsed);
  }
  // Locate the boundary in the WHOLE file, then take the tail. The other
  // order would look for it only within the last `maxEntries` lines, so a
  // log whose recent tail happens to hold nothing stamped would read as
  // pre-boundary and trust it. Nothing precedes the start of a file, hence
  // `false`.
  return retainAuthenticMarkers(entries, false).slice(-maxEntries);
}

export async function readBootstrapLogTail(
  environment: Environment | undefined,
  maxLines: number,
): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(bootstrapLogPath(environment), "utf8");
  } catch {
    return "";
  }
  const lines = raw.split(/\r?\n/);
  return lines.slice(-maxLines).join("\n");
}
