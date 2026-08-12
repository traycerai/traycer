import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import type { Environment } from "./paths";

/**
 * Shared on-disk installation contracts for the CLI and its host.
 *
 * These records are deliberately Node-only and therefore live under the
 * `@traycer/protocol/config` subpath, like the shared config store. The host
 * reads these exact records for RPC installation information while the CLI
 * remains the sole writer and lifecycle owner.
 */

const TRAYCER_HOME_DIRNAME = ".traycer";
const CLI_DIRNAME = "cli";
const HOST_DIRNAME = "host";
const HOST_INSTALL_DIRNAME = "install";
const HOST_STAGED_DIRNAME = "staged";
const HOST_INSTALL_RECORD_FILENAME = "install.json";
const HOST_STAGED_RECORD_FILENAME = "staged.json";
const CLI_MANIFEST_FILENAME = "manifest.json";
const DEV_DESKTOP_SLOT_ENV = "DEV_DESKTOP_SLOT";

// The record schemas live in a browser-safe sibling (see its header). Re-exported
// here so every existing `config/installation` importer is unaffected, and
// imported by name because the readers below need them in local scope.
export * from "./installation-records";
import {
  hostInstallRecordSchema,
  hostStagedRecordSchema,
  storedCliInstallManifestSchema,
  type HostInstallRecord,
  type HostStagedRecord,
  type StoredCliInstallManifest,
} from "./installation-records";

/**
 * The shared dev-desktop slot mapping. It is intentionally here rather than
 * in either consumer so every reader of an install record selects the same
 * physical CLI/host tree. Keep this byte-for-byte compatible with the
 * browser-safe shared-client helper until that helper can depend on protocol.
 */
export function devDesktopSlotForEnvironment(
  environment: Environment,
): string | null {
  if (environment !== "dev") return null;
  const raw = process.env[DEV_DESKTOP_SLOT_ENV];
  if (typeof raw !== "string") return null;
  const slot = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  if (slot.length === 0) {
    throw new Error(`${DEV_DESKTOP_SLOT_ENV} must contain a usable slot name`);
  }
  return slot;
}

function traycerHomeDir(): string {
  return join(homedir(), TRAYCER_HOME_DIRNAME);
}

function slotInstallDir(base: string, environment: Environment): string {
  const devSlot = devDesktopSlotForEnvironment(environment);
  if (devSlot !== null) return join(base, "dev-runs", devSlot);
  return environment === "production" ? base : join(base, environment);
}

/** The CLI install directory for this exact environment and development slot. */
export function cliInstallHomeDir(environment: Environment): string {
  return slotInstallDir(join(traycerHomeDir(), CLI_DIRNAME), environment);
}

export function cliManifestPath(environment: Environment): string {
  return join(cliInstallHomeDir(environment), CLI_MANIFEST_FILENAME);
}

/** The host install/runtime directory matching the CLI's selected slot. */
export function hostInstallHomeDir(environment: Environment): string {
  return slotInstallDir(join(traycerHomeDir(), HOST_DIRNAME), environment);
}

export function hostInstallDir(environment: Environment): string {
  return join(hostInstallHomeDir(environment), HOST_INSTALL_DIRNAME);
}

export function hostInstallRecordPath(environment: Environment): string {
  return join(hostInstallDir(environment), HOST_INSTALL_RECORD_FILENAME);
}

export function hostStagedDir(environment: Environment): string {
  return join(hostInstallHomeDir(environment), HOST_STAGED_DIRNAME);
}

export function hostStagedRecordPath(environment: Environment): string {
  return join(hostStagedDir(environment), HOST_STAGED_RECORD_FILENAME);
}

/**
 * Reads the installed-host record. A missing file is the unmanaged/tree-run
 * state; malformed present bytes reject so callers never mistake corruption
 * for an absent installation.
 */
export async function readHostInstallRecord(
  environment: Environment,
): Promise<HostInstallRecord | null> {
  return readHostInstallRecordAtPath(hostInstallRecordPath(environment));
}

/**
 * Parses an installed-host record at an explicit path. The CLI passes its
 * injected path helper here (test and recovery seams); the host uses the
 * canonical slot-aware helper above. Both consumers therefore share the
 * schema and reader without forking their path authority.
 */
export function readHostInstallRecordAtPath(
  path: string,
): Promise<HostInstallRecord | null> {
  return readRecord(path, hostInstallRecordSchema);
}

/**
 * Reads a staged record if it is structurally valid and contained beneath its
 * staged directory. Unlike the installed record, this is a best-effort staging
 * hint: malformed/foreign sidecars return null so reconciliation can discard
 * them rather than wedging CLI mutations.
 */
export async function readHostStagedRecord(
  environment: Environment,
): Promise<HostStagedRecord | null> {
  return readHostStagedRecordAt(hostStagedDir(environment));
}

/** Shared tolerant staged-sidecar reader for explicit CLI reconcile paths. */
export async function readHostStagedRecordAt(
  stagedDir: string,
): Promise<HostStagedRecord | null> {
  const record = await readTolerantRecord(
    join(stagedDir, HOST_STAGED_RECORD_FILENAME),
    hostStagedRecordSchema,
  );
  if (record === null) return null;
  return isStructurallyValidStagedExecutablePath(
    stagedDir,
    record.executablePath,
  )
    ? record
    : null;
}

/** Reads only an on-disk CLI manifest; synthetic package-manager state is CLI-owned. */
export async function readStoredCliInstallManifest(
  environment: Environment,
): Promise<StoredCliInstallManifest | null> {
  return readStoredCliInstallManifestAtPath(cliManifestPath(environment));
}

/** Shared strict persisted-manifest reader for CLI-owned explicit paths. */
export function readStoredCliInstallManifestAtPath(
  path: string,
): Promise<StoredCliInstallManifest | null> {
  return readRecord(path, storedCliInstallManifestSchema);
}

/** Prevent a staged sidecar from pointing its executable outside `staged/`. */
export function isStructurallyValidStagedExecutablePath(
  stagedDirPath: string,
  executablePath: string,
): boolean {
  if (executablePath.length === 0 || isAbsolute(executablePath)) return false;
  const resolvedRelative = relative(
    stagedDirPath,
    join(stagedDirPath, executablePath),
  );
  return !resolvedRelative.startsWith("..") && !isAbsolute(resolvedRelative);
}

async function readRecord<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return null;
    throw error;
  }
  return schema.parse(JSON.parse(raw));
}

async function readTolerantRecord<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  try {
    return await readRecord(path, schema);
  } catch {
    return null;
  }
}

function readErrorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : null;
}
