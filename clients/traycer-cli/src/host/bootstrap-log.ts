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

// Marker lines end with `writer=supervisor`. Retain unstamped markers only before the first stamped one so an upgrade cannot drop a real crash.

export type BootstrapPhase =
  | "starting"
  | "exited"
  | "crashed"
  | "killed"
  | "failed-to-spawn";

// Every field is explicit (no optional `?:` per project style).
// Callers pass `undefined` for unset fields; `formatFields` skips any field whose value is `undefined` (or `null` for the nullable members).
export interface BootstrapMarkerFields {
  readonly shell: string | undefined;
  readonly args: readonly string[] | undefined;
  readonly bundle: string | undefined;
  readonly exitCode: number | null | undefined;
  readonly signal: string | null | undefined;
  readonly error: string | undefined;
  /** Decoded meaning of a high-bit `exitCode` (hex + NTSTATUS name, see `crash-diagnostics.ts`). Additive: old parsers ignore unknown keys. */
  readonly exitMeaning: string | undefined;
  /** Filename of the Node diagnostic report written by this child (newest report younger than the spawn), for `phase=crashed` markers. */
  readonly report: string | undefined;
  /** Newline-escaped tail of the child's stderr - the V8/native fatal text that used to be stranded in a rotated-away `host.log.1`. */
  readonly stderrTail: string | undefined;
  readonly attemptId: string | undefined;
  readonly supervisorPid: number | undefined;
}

// The key/value that identify a line as supervisor-written.
// Deliberately NOT a member of `BootstrapMarkerFields`: a caller that forgot to pass it would silently mint an unverified marker, so `formatMarkerLine` appends it for every writer instead.
export const MARKER_WRITER_KEY = "writer";
export const MARKER_WRITER_SUPERVISOR = "supervisor";

/** Provenance of a parsed marker line. `"supervisor"` - carries {@link MARKER_WRITER_KEY}, so a marker writer produced it. */
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

// Both writers build the marker here so the writer field cannot be forgotten. Writer identity goes last, after the diagnostic payload.
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

// Return a bare integer fd for spawn stdio, not a FileHandle: an unreferenced FileHandle is GC-closed (fatal on Node >= 24) while spawn still needs the fd.
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

// Parse one marker line; unknown keys land in `fields`. An unverified marker is labelled, never dropped - run through retainAuthenticMarkers before treating as authority.
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
 * Keep unstamped markers only before the first stamped one; filtering the whole region would delete a real pre-upgrade crash.
 * `writerIdentifiedBefore` is passed in because a truncated window may have evicted the stamped marker.
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
