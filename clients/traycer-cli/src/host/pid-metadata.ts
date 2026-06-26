import { readFile } from "node:fs/promises";
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
}

export async function readHostPidMetadata(
  environment: Environment | undefined,
): Promise<HostPidMetadata | null> {
  const logger = createCliLogger(environment ?? config.environment);
  let raw: string;
  try {
    raw = await readFile(hostPidMetadataPath(environment), "utf8");
  } catch (err) {
    logger.debug("Host pid metadata read returned absent", {
      environment: environment ?? "production",
      errorName: errorFromUnknown(err).name,
      errorMessage: errorFromUnknown(err).message,
    });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn("Host pid metadata JSON parse failed", {
      environment: environment ?? "production",
      errorName: errorFromUnknown(err).name,
      errorMessage: errorFromUnknown(err).message,
    });
    return null;
  }
  if (parsed === null || typeof parsed !== "object") {
    logger.warn("Host pid metadata rejected non-object payload", {
      environment: environment ?? "production",
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
      environment: environment ?? "production",
      hasPid: typeof obj.pid === "number",
      hasHostId: typeof obj.hostId === "string",
      hasVersion: typeof obj.version === "string",
      hasWebsocketUrl: typeof obj.websocketUrl === "string",
      hasStartedAt: typeof obj.startedAt === "string",
    });
    return null;
  }
  logger.debug("Host pid metadata read completed", {
    environment: environment ?? "production",
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
  };
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
