import log from "electron-log";
import { app } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_LOG_LEVEL,
  isLogLevel,
  type LogLevel,
} from "@traycer/protocol/config/log-level";
import { createJsonFileStore } from "./json-file-store";

const STORE_FILE_NAME = "desktop-log-level.json";

interface DesktopLogLevelState {
  readonly level: LogLevel;
}

const DEFAULT_STATE: DesktopLogLevelState = { level: DEFAULT_LOG_LEVEL };

function parseState(value: unknown): DesktopLogLevelState {
  if (value !== null && typeof value === "object") {
    const obj = value as Partial<DesktopLogLevelState>;
    if (isLogLevel(obj.level)) return { level: obj.level };
  }
  return DEFAULT_STATE;
}

function storePath(): string {
  return join(app.getPath("userData"), STORE_FILE_NAME);
}

// `app.getPath("userData")` is only valid after the app module boots, so the
// store is created lazily per call rather than at module load (mirrors the GPU
// preference store).
function getStore() {
  return createJsonFileStore<DesktopLogLevelState>(
    storePath(),
    DEFAULT_STATE,
    parseState,
  );
}

// electron-log's level vocabulary differs slightly from ours: `trace` maps to
// its most-verbose `silly`; the rest line up one-to-one.
type ElectronLogLevel =
  | "error"
  | "warn"
  | "info"
  | "verbose"
  | "debug"
  | "silly";
const ELECTRON_LOG_LEVEL: Record<LogLevel, ElectronLogLevel> = {
  trace: "silly",
  debug: "debug",
  info: "info",
  warn: "warn",
  error: "error",
};

/**
 * Applies the desktop threshold to electron-log's file transport — the sink
 * that persists both the main process's own logs and the renderer's forwarded
 * console logs into `traycer-desktop.log`. Raising it to `debug` is what support
 * asks for when collecting a repro.
 */
export function applyDesktopLogLevel(level: LogLevel): void {
  log.transports.file.level = ELECTRON_LOG_LEVEL[level];
}

/**
 * Synchronous startup read, before the event loop is pumping (mirrors the GPU
 * preference). Never throws — a missing or unreadable file yields the default.
 */
export function readDesktopLogLevelSync(): LogLevel {
  try {
    const raw = readFileSync(storePath(), "utf8");
    return parseState(JSON.parse(raw)).level;
  } catch {
    return DEFAULT_LOG_LEVEL;
  }
}

export async function getDesktopLogLevel(): Promise<LogLevel> {
  return (await getStore().load()).level;
}

export async function setDesktopLogLevel(level: LogLevel): Promise<LogLevel> {
  await getStore().save({ level });
  applyDesktopLogLevel(level);
  log.info("[log-level] desktop level updated", { level });
  return level;
}
