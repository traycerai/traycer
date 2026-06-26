import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { cliDiagnosticsConfigPath } from "./paths";
import {
  DIAGNOSTICS_CONFIG_VERSION,
  EMPTY_DIAGNOSTICS_PATCH,
  type DiagnosticLogLevel,
  type DiagnosticsEffectiveConfig,
  type DiagnosticsEffectiveSource,
  type DiagnosticsEffectiveScope,
  type DiagnosticsPatch,
  type DiagnosticsRawConfig,
  type DiagnosticsTemporaryScope,
  type DiagnosticsWriteResult,
  type HostDiagnosticLogLevel,
  type TemporaryDiagnosticLogLevel,
  type TemporaryHostDiagnosticLogLevel,
  isDiagnosticLogLevel,
  isHostDiagnosticLogLevel,
} from "./diagnostics-schema";

const GENERAL_DEFAULT_LEVEL: DiagnosticLogLevel = "info";
const HOST_DEFAULT_LEVEL: HostDiagnosticLogLevel = "inherit";
const DIAGNOSTICS_LOCK_RETRY_MS = 25;
const DIAGNOSTICS_LOCK_TIMEOUT_MS = 5_000;
const DIAGNOSTICS_LOCK_STALE_MS = 30_000;
const DIAGNOSTICS_LOCK_OWNER_FILENAME = "owner";

type DiagnosticsConfigLock = {
  readonly lockPath: string;
  readonly ownerPath: string;
  readonly ownerToken: string;
};

class DiagnosticsConfigLockLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiagnosticsConfigLockLostError";
  }
}

export async function readDiagnosticsRaw(): Promise<DiagnosticsRawConfig> {
  const path = cliDiagnosticsConfigPath();
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (err) {
    if (isNodeErrorCode(err, "ENOENT")) {
      return { raw: {}, readStatus: "missing", path, mtimeMs: null };
    }
    return { raw: {}, readStatus: "corrupt", path, mtimeMs: null };
  }

  try {
    const parsed = JSON.parse(contents);
    if (!isRecord(parsed)) {
      return { raw: {}, readStatus: "corrupt", path, mtimeMs: null };
    }
    const mtimeMs = await readMtimeMs(path);
    return { raw: parsed, readStatus: "ok", path, mtimeMs };
  } catch {
    return { raw: {}, readStatus: "corrupt", path, mtimeMs: null };
  }
}

export function readDiagnosticsRawSync(): DiagnosticsRawConfig {
  const path = cliDiagnosticsConfigPath();
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (err) {
    if (isNodeErrorCode(err, "ENOENT")) {
      return { raw: {}, readStatus: "missing", path, mtimeMs: null };
    }
    return { raw: {}, readStatus: "corrupt", path, mtimeMs: null };
  }

  try {
    const parsed = JSON.parse(contents);
    if (!isRecord(parsed)) {
      return { raw: {}, readStatus: "corrupt", path, mtimeMs: null };
    }
    return {
      raw: parsed,
      readStatus: "ok",
      path,
      mtimeMs: readMtimeMsSync(path),
    };
  } catch {
    return { raw: {}, readStatus: "corrupt", path, mtimeMs: null };
  }
}

export async function loadEffectiveDiagnosticsConfig(
  now: Date,
): Promise<DiagnosticsEffectiveConfig> {
  return resolveDiagnosticsEffective(await readDiagnosticsRaw(), now);
}

export function loadEffectiveDiagnosticsConfigSync(
  now: Date,
): DiagnosticsEffectiveConfig {
  return resolveDiagnosticsEffective(readDiagnosticsRawSync(), now);
}

export function resolveDiagnosticsEffective(
  raw: DiagnosticsRawConfig,
  now: Date,
): DiagnosticsEffectiveConfig {
  const generalPermanent = readDiagnosticLogLevel(raw.raw.logLevel);
  const temporaryGeneral = readTemporary(
    raw.raw.temporaryLogLevel,
    isDiagnosticLogLevel,
  );
  const invalidTemporaryGeneralValue = invalidTemporaryValue(
    raw.raw.temporaryLogLevel,
    temporaryGeneral,
    isDiagnosticLogLevel,
  );
  const activeTemporaryGeneral = readActiveTemporary(
    temporaryGeneral,
    now,
    isDiagnosticLogLevel,
  );

  const general = resolveGeneralScope(
    raw.raw.logLevel,
    generalPermanent,
    temporaryGeneral,
    invalidTemporaryGeneralValue,
    activeTemporaryGeneral,
    now,
  );

  const hostPermanent = readHostDiagnosticLogLevel(raw.raw.hostLogLevel);
  const temporaryHost = readTemporary(
    raw.raw.temporaryHostLogLevel,
    isHostDiagnosticLogLevel,
  );
  const invalidTemporaryHostValue = invalidTemporaryValue(
    raw.raw.temporaryHostLogLevel,
    temporaryHost,
    isHostDiagnosticLogLevel,
  );
  const activeTemporaryHost = readActiveTemporary(
    temporaryHost,
    now,
    isHostDiagnosticLogLevel,
  );

  const hostConfigured =
    activeTemporaryHost?.level ?? hostPermanent ?? HOST_DEFAULT_LEVEL;
  const hostLevel =
    hostConfigured === "inherit" ? general.level : hostConfigured;

  const host = resolveHostScope(
    raw.raw.hostLogLevel,
    hostConfigured,
    hostLevel,
    hostPermanent,
    temporaryHost,
    invalidTemporaryHostValue,
    activeTemporaryHost,
    general.source,
    now,
  );

  return {
    general,
    host,
    rawHostSetting: resolveRawHostSetting(raw.raw.hostLogLevel),
  };
}

export async function patchDiagnosticsConfig(
  patch: DiagnosticsPatch,
): Promise<DiagnosticsWriteResult> {
  const startedAtMs = Date.now();
  while (true) {
    try {
      return await withDiagnosticsConfigLock(async (lock) => {
        const current = await readDiagnosticsRaw();
        const next: Record<string, unknown> = {
          ...(current.readStatus === "ok" ? current.raw : {}),
          version: preserveConfigVersion(current),
        };

        if (patch.resetGeneral) {
          delete next.logLevel;
          delete next.temporaryLogLevel;
        }
        if (patch.resetHost) {
          delete next.hostLogLevel;
          delete next.temporaryHostLogLevel;
        }
        if (patch.logLevel !== undefined) {
          next.logLevel = patch.logLevel;
        }
        if (patch.hostLogLevel !== undefined) {
          next.hostLogLevel = patch.hostLogLevel;
        }
        if (patch.temporaryLogLevel !== undefined) {
          if (patch.temporaryLogLevel === null) {
            delete next.temporaryLogLevel;
          } else {
            next.temporaryLogLevel = serializeTemporary(
              patch.temporaryLogLevel,
              next.temporaryLogLevel,
            );
          }
        }
        if (patch.temporaryHostLogLevel !== undefined) {
          if (patch.temporaryHostLogLevel === null) {
            delete next.temporaryHostLogLevel;
          } else {
            next.temporaryHostLogLevel = serializeTemporary(
              patch.temporaryHostLogLevel,
              next.temporaryHostLogLevel,
            );
          }
        }

        return await writeDiagnosticsRaw(next, lock);
      });
    } catch (err) {
      if (
        !(err instanceof DiagnosticsConfigLockLostError) ||
        Date.now() - startedAtMs > DIAGNOSTICS_LOCK_TIMEOUT_MS
      ) {
        throw err;
      }
      await sleep(DIAGNOSTICS_LOCK_RETRY_MS);
    }
  }
}

export async function setDiagnosticsLogLevel(
  level: DiagnosticLogLevel,
): Promise<DiagnosticsWriteResult> {
  return await patchDiagnosticsConfig({
    ...EMPTY_DIAGNOSTICS_PATCH,
    logLevel: level,
  });
}

export async function setHostDiagnosticsLogLevel(
  level: HostDiagnosticLogLevel,
): Promise<DiagnosticsWriteResult> {
  return await patchDiagnosticsConfig({
    ...EMPTY_DIAGNOSTICS_PATCH,
    hostLogLevel: level,
  });
}

export async function setTemporaryDiagnosticsLogLevel(
  temporary: TemporaryDiagnosticLogLevel,
): Promise<DiagnosticsWriteResult> {
  return await patchDiagnosticsConfig({
    ...EMPTY_DIAGNOSTICS_PATCH,
    temporaryLogLevel: temporary,
  });
}

export async function setTemporaryHostDiagnosticsLogLevel(
  temporary: TemporaryHostDiagnosticLogLevel,
): Promise<DiagnosticsWriteResult> {
  return await patchDiagnosticsConfig({
    ...EMPTY_DIAGNOSTICS_PATCH,
    temporaryHostLogLevel: temporary,
  });
}

export async function clearTemporaryDiagnosticsLogLevels(): Promise<DiagnosticsWriteResult> {
  return await clearTemporaryDiagnosticsLogLevelScope("all");
}

export async function clearTemporaryDiagnosticsLogLevel(): Promise<DiagnosticsWriteResult> {
  return await clearTemporaryDiagnosticsLogLevelScope("general");
}

export async function clearTemporaryHostDiagnosticsLogLevel(): Promise<DiagnosticsWriteResult> {
  return await clearTemporaryDiagnosticsLogLevelScope("host");
}

export async function clearTemporaryDiagnosticsLogLevelScope(
  scope: DiagnosticsTemporaryScope,
): Promise<DiagnosticsWriteResult> {
  return await patchDiagnosticsConfig({
    ...EMPTY_DIAGNOSTICS_PATCH,
    temporaryLogLevel:
      scope === "general" || scope === "all" ? null : undefined,
    temporaryHostLogLevel:
      scope === "host" || scope === "all" ? null : undefined,
  });
}

export async function resetDiagnosticsConfig(): Promise<DiagnosticsWriteResult> {
  return await patchDiagnosticsConfig({
    ...EMPTY_DIAGNOSTICS_PATCH,
    resetGeneral: true,
    resetHost: true,
  });
}

function preserveConfigVersion(current: DiagnosticsRawConfig): number {
  if (current.readStatus !== "ok") return DIAGNOSTICS_CONFIG_VERSION;
  const existing = current.raw.version;
  // A newer binary may bump the on-disk version. Never stamp a higher version
  // back down to ours, so a future v2 file's version survives an older binary's
  // patch (its unknown keys are already preserved by the spread above).
  return typeof existing === "number" && existing > DIAGNOSTICS_CONFIG_VERSION
    ? existing
    : DIAGNOSTICS_CONFIG_VERSION;
}

async function writeDiagnosticsRaw(
  next: Record<string, unknown>,
  lock: DiagnosticsConfigLock,
): Promise<DiagnosticsWriteResult> {
  const path = cliDiagnosticsConfigPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await assertDiagnosticsConfigLockOwner(lock);
    await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await assertDiagnosticsConfigLockOwner(lock);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return {
    path,
    mtimeMs: (await readMtimeMs(path)) ?? Date.now(),
    rawPreserved: true,
  };
}

async function withDiagnosticsConfigLock<T>(
  operation: (lock: DiagnosticsConfigLock) => Promise<T>,
): Promise<T> {
  const path = cliDiagnosticsConfigPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const lock = await acquireDiagnosticsConfigLock(lockPath, Date.now());
  try {
    await assertDiagnosticsConfigLockOwner(lock);
    return await operation(lock);
  } finally {
    await releaseDiagnosticsConfigLock(lock);
  }
}

async function acquireDiagnosticsConfigLock(
  lockPath: string,
  startedAtMs: number,
): Promise<DiagnosticsConfigLock> {
  while (true) {
    const lock: DiagnosticsConfigLock = {
      lockPath,
      ownerPath: diagnosticsConfigLockOwnerPath(lockPath),
      ownerToken: `${process.pid}:${randomBytes(16).toString("hex")}`,
    };
    try {
      await mkdir(lockPath, { mode: 0o700 });
      try {
        await writeFile(lock.ownerPath, lock.ownerToken, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
      } catch (err) {
        await rm(lockPath, { force: true, recursive: true });
        throw err;
      }
      return lock;
    } catch (err) {
      if (!isNodeErrorCode(err, "EEXIST")) throw err;
      await removeStaleDiagnosticsConfigLock(lockPath, Date.now());
      if (Date.now() - startedAtMs > DIAGNOSTICS_LOCK_TIMEOUT_MS) {
        throw err;
      }
      await sleep(DIAGNOSTICS_LOCK_RETRY_MS);
    }
  }
}

function diagnosticsConfigLockOwnerPath(lockPath: string): string {
  return `${lockPath}/${DIAGNOSTICS_LOCK_OWNER_FILENAME}`;
}

async function assertDiagnosticsConfigLockOwner(
  lock: DiagnosticsConfigLock,
): Promise<void> {
  let ownerToken: string;
  try {
    ownerToken = await readFile(lock.ownerPath, "utf8");
  } catch (err) {
    if (isNodeErrorCode(err, "ENOENT")) {
      throw new DiagnosticsConfigLockLostError(
        "Diagnostics config lock was lost before write",
      );
    }
    throw err;
  }
  if (ownerToken !== lock.ownerToken) {
    throw new DiagnosticsConfigLockLostError(
      "Diagnostics config lock ownership changed before write",
    );
  }
  await writeFile(lock.ownerPath, lock.ownerToken, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function releaseDiagnosticsConfigLock(
  lock: DiagnosticsConfigLock,
): Promise<void> {
  let ownerToken: string;
  try {
    ownerToken = await readFile(lock.ownerPath, "utf8");
  } catch (err) {
    if (isNodeErrorCode(err, "ENOENT")) return;
    throw err;
  }
  if (ownerToken !== lock.ownerToken) return;
  await rm(lock.lockPath, { force: true, recursive: true });
}

async function removeStaleDiagnosticsConfigLock(
  lockPath: string,
  nowMs: number,
): Promise<void> {
  try {
    const ownerPath = diagnosticsConfigLockOwnerPath(lockPath);
    const lockStat = await stat(ownerPath).catch(async (err: unknown) => {
      if (!isNodeErrorCode(err, "ENOENT")) throw err;
      return await stat(lockPath);
    });
    if (nowMs - lockStat.mtimeMs > DIAGNOSTICS_LOCK_STALE_MS) {
      await rm(lockPath, { force: true, recursive: true });
    }
  } catch (err) {
    if (!isNodeErrorCode(err, "ENOENT")) throw err;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function resolveGeneralScope(
  configuredValue: unknown,
  permanent: DiagnosticLogLevel | null,
  temporary: TemporaryDiagnosticLogLevel | null,
  invalidTemporaryValue: unknown,
  activeTemporary: TemporaryDiagnosticLogLevel | null,
  now: Date,
): DiagnosticsEffectiveScope<DiagnosticLogLevel> {
  if (activeTemporary !== null) {
    return {
      level: activeTemporary.level,
      source: "temporary",
      expiresAt: activeTemporary.expiresAt,
      configuredValue: activeTemporary.level,
    };
  }
  if (invalidTemporaryValue !== undefined) {
    return {
      level: permanent ?? GENERAL_DEFAULT_LEVEL,
      source: invalidSource(invalidTemporaryValue),
      expiresAt: null,
      configuredValue: invalidTemporaryValue,
    };
  }
  if (temporary !== null && isExpired(temporary.expiresAt, now)) {
    return {
      level: permanent ?? GENERAL_DEFAULT_LEVEL,
      source: "expired-ignored",
      expiresAt: temporary.expiresAt,
      configuredValue: temporary.level,
    };
  }
  if (permanent !== null) {
    return {
      level: permanent,
      source: "permanent",
      expiresAt: null,
      configuredValue,
    };
  }
  if (configuredValue !== undefined) {
    return {
      level: GENERAL_DEFAULT_LEVEL,
      source:
        typeof configuredValue === "string" ? "unsupported-raw" : "invalid-raw",
      expiresAt: null,
      configuredValue,
    };
  }
  return {
    level: GENERAL_DEFAULT_LEVEL,
    source: "default",
    expiresAt: null,
    configuredValue: undefined,
  };
}

function resolveHostScope(
  configuredValue: unknown,
  configuredHostLevel: HostDiagnosticLogLevel,
  hostLevel: DiagnosticLogLevel,
  permanent: HostDiagnosticLogLevel | null,
  temporary: TemporaryHostDiagnosticLogLevel | null,
  invalidTemporaryValue: unknown,
  activeTemporary: TemporaryHostDiagnosticLogLevel | null,
  generalSource: string,
  now: Date,
): DiagnosticsEffectiveScope<DiagnosticLogLevel> {
  if (activeTemporary !== null) {
    return {
      level: hostLevel,
      source:
        activeTemporary.level === "inherit"
          ? "temporary-inherited"
          : "temporary",
      expiresAt: activeTemporary.expiresAt,
      configuredValue: activeTemporary.level,
    };
  }
  if (invalidTemporaryValue !== undefined) {
    return {
      level: hostLevel,
      source: invalidSource(invalidTemporaryValue),
      expiresAt: null,
      configuredValue: invalidTemporaryValue,
    };
  }
  if (temporary !== null && isExpired(temporary.expiresAt, now)) {
    return {
      level: hostLevel,
      source: "expired-ignored",
      expiresAt: temporary.expiresAt,
      configuredValue: temporary.level,
    };
  }
  if (permanent !== null) {
    return {
      level: hostLevel,
      source:
        configuredHostLevel === "inherit" ? "permanent-inherited" : "permanent",
      expiresAt: null,
      configuredValue,
    };
  }
  if (configuredValue !== undefined) {
    return {
      level: hostLevel,
      source:
        typeof configuredValue === "string" ? "unsupported-raw" : "invalid-raw",
      expiresAt: null,
      configuredValue,
    };
  }
  return {
    level: hostLevel,
    source: inheritedSourceFromGeneral(generalSource),
    expiresAt: null,
    configuredValue: undefined,
  };
}

function inheritedSourceFromGeneral(
  generalSource: string,
): DiagnosticsEffectiveSource {
  if (generalSource === "temporary") return "temporary-inherited";
  if (generalSource === "default") return "default";
  if (
    generalSource === "unsupported-raw" ||
    generalSource === "invalid-raw" ||
    generalSource === "expired-ignored"
  ) {
    return generalSource;
  }
  return "permanent-inherited";
}

function invalidSource(value: unknown): "unsupported-raw" | "invalid-raw" {
  return typeof value === "string" ? "unsupported-raw" : "invalid-raw";
}

function readDiagnosticLogLevel(value: unknown): DiagnosticLogLevel | null {
  return isDiagnosticLogLevel(value) ? value : null;
}

function readHostDiagnosticLogLevel(
  value: unknown,
): HostDiagnosticLogLevel | null {
  return isHostDiagnosticLogLevel(value) ? value : null;
}

function resolveRawHostSetting(
  value: unknown,
): HostDiagnosticLogLevel | "unsupported" | "invalid" {
  if (value === undefined) return HOST_DEFAULT_LEVEL;
  if (isHostDiagnosticLogLevel(value)) return value;
  return typeof value === "string" ? "unsupported" : "invalid";
}

function readTemporary<TLevel extends string>(
  value: unknown,
  isLevel: (value: unknown) => value is TLevel,
): {
  readonly level: TLevel;
  readonly expiresAt: string;
  readonly reason: string | undefined;
} | null {
  if (!isRecord(value)) return null;
  const level = value.level;
  const expiresAt = value.expiresAt;
  if (
    !isLevel(level) ||
    typeof expiresAt !== "string" ||
    !hasValidDate(expiresAt)
  ) {
    return null;
  }
  return {
    level,
    expiresAt,
    reason: typeof value.reason === "string" ? value.reason : undefined,
  };
}

function readActiveTemporary<
  TLevel extends string,
  TTemporary extends {
    readonly level: TLevel;
    readonly expiresAt: string;
  },
>(
  temporary: TTemporary | null,
  now: Date,
  isLevel: (value: unknown) => value is TLevel,
): TTemporary | null {
  if (temporary === null) return null;
  if (!isLevel(temporary.level)) return null;
  return isExpired(temporary.expiresAt, now) ? null : temporary;
}

function isExpired(expiresAt: string, now: Date): boolean {
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isFinite(expiresAtMs) ? expiresAtMs <= now.getTime() : true;
}

function hasValidDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function invalidTemporaryValue<TLevel extends string, TTemporary>(
  value: unknown,
  temporary: TTemporary | null,
  isLevel: (value: unknown) => value is TLevel,
): unknown {
  if (value === undefined || value === null || temporary !== null) {
    return undefined;
  }
  if (isRecord(value)) {
    const level = value.level;
    if (typeof level === "string" && !isLevel(level)) {
      return level;
    }
  }
  return value;
}

function serializeTemporary(
  temporary: {
    readonly level: string;
    readonly expiresAt: string;
    readonly reason: string | undefined;
  },
  previousValue: unknown,
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...(isRecord(previousValue) ? previousValue : {}),
    level: temporary.level,
    expiresAt: temporary.expiresAt,
  };
  if (temporary.reason === undefined) {
    delete next.reason;
  } else {
    next.reason = temporary.reason;
  }
  return next;
}

async function readMtimeMs(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

function readMtimeMsSync(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeErrorCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === code
  );
}
