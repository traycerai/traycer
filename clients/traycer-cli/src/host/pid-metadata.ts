import { readFile, rm } from "node:fs/promises";
import {
  isProcessStartIdentity,
  type ProcessStartIdentity,
} from "@traycer/protocol/host/lifecycle";
import type { Environment } from "../runner/environment";
import { config } from "../config";
import { createCliLogger, errorFromUnknown } from "../logger";
import { hostPidMetadataPath } from "../store/paths";

// Mirror of the writer contract owned by the host (the external
// Traycer Host). Read by string path so
// the CLI keeps zero imports on the host package. Tolerate unknown legacy
// keys (e.g. the removed `httpUrl` field) by parsing as a wider record and
// projecting only the keys we need.
export interface HostPidMetadata {
  readonly pid: number;
  readonly hostId: string;
  readonly version: string;
  readonly websocketUrl: string;
  readonly startedAt: string;
  /**
   * The publishing process's kernel-recorded creation stamp, `null` when this
   * pid.json predates the field. Absence is "cannot compare identity" and
   * must never be read as a mismatch.
   */
  readonly processStartIdentity: ProcessStartIdentity | null;
  /**
   * The host's Layer 0 single-writer (I1) verdict, `null` when this pid.json
   * carries none. Absence is "not recorded" - every file written before the
   * field shipped lacks it - and must never be read as "guaranteed".
   */
  readonly layer0: HostLayer0Record | null;
  /**
   * The SLOT home's Layer 0 verdict, present only on a dev identity-pool
   * host, which takes TWO locks - slot home and identity home - where every
   * other host takes one.
   *
   * `null` on every ordinary host and on every pid.json written before the
   * field shipped. Absence is "there was no second lock, or it was not
   * recorded" and, exactly like {@link layer0}, must never be read as
   * "guaranteed": until the host started writing this, a slot lock that
   * degraded WITHOUT holding was discarded before any record existed, so
   * {@link layer0}'s clean `acquired` was the only thing published and it
   * described the other home.
   */
  readonly layer0Slot: HostLayer0Record | null;
}

/**
 * Mirror of the host's `HostLayer0Record`. A host that could not take the
 * single-writer lock starts anyway (refusing would trade a rare corruption for
 * a routine outage) and records why, because nothing else it writes survives:
 * the framed status pipe usually has no reader, and the stderr line falls out
 * of the log tail the support attachment captures.
 *
 * `unrecognized` exists so a CLI older than its host reports "I cannot confirm
 * the guarantee" rather than dropping the record and reporting nothing, which
 * is the same silence the field was added to remove.
 */
export type HostLayer0Record =
  | { readonly status: "acquired"; readonly attemptId: string }
  | {
      readonly status: "degraded";
      readonly attemptId: string;
      /**
       * Display form of the host's cause. String causes pass through verbatim;
       * the structured `os-error` cause is JSON-rendered rather than dropped,
       * so an unfamiliar shape still reaches the report.
       */
      readonly cause: string;
      readonly evidence: string;
    }
  | { readonly status: "unrecognized"; readonly raw: string };

export async function readHostPidMetadata(
  environment: Environment | undefined,
): Promise<HostPidMetadata | null> {
  const logEnvironment = environment ?? config.environment;
  const logger = createCliLogger(logEnvironment);
  let raw: string;
  try {
    raw = await readFile(hostPidMetadataPath(environment), "utf8");
  } catch (err) {
    if (readErrorCode(err) !== "ENOENT") {
      logger.debug("Host pid metadata read failed", {
        environment: logEnvironment,
        errorName: errorFromUnknown(err).name,
        errorCode: readErrorCode(err),
      });
    }
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn("Host pid metadata JSON parse failed", {
      environment: logEnvironment,
      errorName: errorFromUnknown(err).name,
      errorMessage: errorFromUnknown(err).message,
    });
    return null;
  }
  if (parsed === null || typeof parsed !== "object") {
    logger.warn("Host pid metadata rejected non-object payload", {
      environment: logEnvironment,
    });
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.pid !== "number" ||
    typeof obj.hostId !== "string" ||
    typeof obj.version !== "string" ||
    typeof obj.websocketUrl !== "string" ||
    typeof obj.startedAt !== "string"
  ) {
    logger.warn("Host pid metadata rejected malformed payload", {
      environment: logEnvironment,
      hasPid: typeof obj.pid === "number",
      hasHostId: typeof obj.hostId === "string",
      hasVersion: typeof obj.version === "string",
      hasWebsocketUrl: typeof obj.websocketUrl === "string",
      hasStartedAt: typeof obj.startedAt === "string",
    });
    return null;
  }
  logger.debug("Host pid metadata read completed", {
    environment: logEnvironment,
    hostId: obj.hostId,
    pid: obj.pid,
    version: obj.version,
  });
  return {
    pid: obj.pid,
    hostId: obj.hostId,
    version: obj.version,
    websocketUrl: obj.websocketUrl,
    startedAt: obj.startedAt,
    processStartIdentity: isProcessStartIdentity(obj.processStartIdentity)
      ? obj.processStartIdentity
      : null,
    layer0: decodeLayer0Record(obj.layer0),
    // Same decoder, same fail-open-on-shape contract. An old record simply
    // has no such key and decodes to `null`.
    layer0Slot: decodeLayer0Record(obj.layer0Slot),
  };
}

/**
 * Additive and fail-open on shape: a malformed record must not make the whole
 * pid.json unreadable (that would cost the user host discovery over a
 * diagnostic field), but it must not read as healthy either - hence
 * `unrecognized` rather than `null` for anything present and unexpected.
 */
export function decodeLayer0Record(value: unknown): HostLayer0Record | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { status: "unrecognized", raw: JSON.stringify(value) };
  }
  const record = value as Record<string, unknown>;
  const attemptId =
    typeof record.attemptId === "string" ? record.attemptId : "";
  if (record.status === "acquired" && attemptId.length > 0) {
    return { status: "acquired", attemptId };
  }
  if (record.status === "degraded" && attemptId.length > 0) {
    return {
      status: "degraded",
      attemptId,
      cause:
        typeof record.cause === "string"
          ? record.cause
          : JSON.stringify(record.cause ?? null),
      evidence: typeof record.evidence === "string" ? record.evidence : "",
    };
  }
  return { status: "unrecognized", raw: JSON.stringify(record) };
}

/**
 * Purge the published pid metadata on the host's behalf.
 *
 * The writer contract says the HOST removes pid.json on graceful shutdown -
 * but a Windows stop is a `taskkill /T /F`, which never lets the host's
 * shutdown handler run, so the file survives every deliberate stop there.
 * That matters because "pid.json present but endpoint dead" is the signal
 * clients read as *the host died unexpectedly* (the desktop's health
 * watchdog auto-respawns on it); a deliberately stopped host must leave no
 * metadata behind or it gets resurrected against the user's intent.
 */
export async function removeHostPidMetadata(
  environment: Environment | undefined,
): Promise<void> {
  await rm(hostPidMetadataPath(environment), { force: true });
}

export function isValidLocalHostWebsocketUrl(websocketUrl: string): boolean {
  if (!URL.canParse(websocketUrl)) {
    return false;
  }
  const parsed = new URL(websocketUrl);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return false;
  }
  if (parsed.hostname !== "127.0.0.1") {
    return false;
  }
  if (parsed.pathname !== "/rpc") {
    return false;
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    return false;
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return false;
  }
  if (parsed.port.length === 0) {
    return false;
  }
  const port = Number.parseInt(parsed.port, 10);
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function readErrorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : null;
}
