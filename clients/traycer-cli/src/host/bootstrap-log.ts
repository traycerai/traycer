import { open as openCallback } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { Environment } from "../runner/environment";
import { bootstrapLogPath, ensureHostHomeDir } from "../store/paths";

// Async open that resolves to a BARE integer fd (the callback `fs.open`
// contract), not a `FileHandle` - see `openBootstrapLogFd`.
const openRawFd = promisify(openCallback);

// Bootstrap-log line format (contract shared with the host writer):
//   [<iso-timestamp>] phase=<name> key=value key=value …
// Values containing whitespace or quotes are wrapped in double quotes with
// inner quotes doubled. The renderer's failure card and `traycer host
// status` both parse these markers; raw stdout/stderr lines from the shell
// and host are also captured in the same file and pass through as-is.

export type BootstrapPhase =
  "starting" | "exited" | "crashed" | "killed" | "failed-to-spawn";

// Every field is explicit (no optional `?:` per project style). Callers
// pass `undefined` for unset fields; `formatFields` skips any field
// whose value is `undefined` (or `null` for the nullable members).
export interface BootstrapMarkerFields {
  readonly shell: string | undefined;
  readonly args: readonly string[] | undefined;
  readonly bundle: string | undefined;
  readonly exitCode: number | null | undefined;
  readonly signal: string | null | undefined;
  readonly error: string | undefined;
}

export interface BootstrapLogEntry {
  readonly timestamp: string;
  readonly phase: BootstrapPhase;
  readonly fields: Record<string, string>;
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
  return parts.join(" ");
}

export async function writeBootstrapMarker(
  environment: Environment,
  phase: BootstrapPhase,
  fields: BootstrapMarkerFields,
): Promise<void> {
  await ensureHostHomeDir(environment);
  const ts = new Date().toISOString();
  const fieldsStr = formatFields(fields);
  const line = `[${ts}] phase=${phase}${fieldsStr.length === 0 ? "" : ` ${fieldsStr}`}\n`;
  await appendFile(bootstrapLogPath(environment), line);
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

const LINE_RE = /^\[([^\]]+)\] phase=(\w[\w-]*)(?:\s+(.*))?$/;

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
  return { timestamp, phase, fields };
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
  return entries.slice(-maxEntries);
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
