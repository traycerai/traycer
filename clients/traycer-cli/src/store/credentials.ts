import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { config } from "../config";
import { createCliLogger, errorFromUnknown } from "../logger";
import { cliCredentialsPath, ensureCliHomeDir } from "./paths";

// ~/.traycer/cli/credentials shape. Stored as JSON with mode 0600 so other
// users on shared machines can't read the bearer token. The `user` block is
// a cache of the last successful /api/v3/user response - handy for whoami
// without an extra round trip, but always treated as advisory; the token
// itself is the source of truth and gets re-validated on demand.
export interface StoredCredentials {
  readonly token: string;
  // The separately-delivered refresh token (post raw-JWS cutover). Sent in the
  // `POST /api/v3/auth/refresh` body; both rotate on refresh.
  readonly refreshToken: string;
  readonly authnBaseUrl: string;
  readonly savedAt: string;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly name: string;
  };
}

export async function readCredentials(): Promise<StoredCredentials | null> {
  const logger = createCliLogger(config.environment);
  let raw: string;
  try {
    raw = await readFile(cliCredentialsPath(config.environment), "utf8");
  } catch (err) {
    if (readErrorCode(err) !== "ENOENT") {
      throw err;
    }
    logger.debug("Credentials read returned absent", {
      environment: config.environment,
      errorName: errorFromUnknown(err).name,
    });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn("Credentials JSON parse failed", {
      environment: config.environment,
      errorName: errorFromUnknown(err).name,
      errorMessage: errorFromUnknown(err).message,
    });
    return null;
  }
  if (parsed === null || typeof parsed !== "object") {
    logger.warn("Credentials rejected non-object payload", {
      environment: config.environment,
    });
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const user = obj.user;
  if (
    typeof obj.token !== "string" ||
    typeof obj.refreshToken !== "string" ||
    typeof obj.authnBaseUrl !== "string" ||
    typeof obj.savedAt !== "string" ||
    user === null ||
    typeof user !== "object"
  ) {
    logger.warn("Credentials rejected malformed top-level payload", {
      environment: config.environment,
      hasToken: typeof obj.token === "string",
      hasRefreshToken: typeof obj.refreshToken === "string",
      hasAuthnBaseUrl: typeof obj.authnBaseUrl === "string",
      hasSavedAt: typeof obj.savedAt === "string",
      hasUser: user !== null && typeof user === "object",
    });
    return null;
  }
  const userObj = user as Record<string, unknown>;
  if (
    typeof userObj.id !== "string" ||
    typeof userObj.email !== "string" ||
    typeof userObj.name !== "string"
  ) {
    logger.warn("Credentials rejected malformed user payload", {
      environment: config.environment,
      hasUserId: typeof userObj.id === "string",
      hasUserEmail: typeof userObj.email === "string",
      hasUserName: typeof userObj.name === "string",
    });
    return null;
  }
  logger.debug("Credentials read completed", {
    environment: config.environment,
    hasToken: obj.token.length > 0,
    hasRefreshToken: obj.refreshToken.length > 0,
  });
  return {
    token: obj.token,
    refreshToken: obj.refreshToken,
    authnBaseUrl: obj.authnBaseUrl,
    savedAt: obj.savedAt,
    user: { id: userObj.id, email: userObj.email, name: userObj.name },
  };
}

export async function writeCredentials(
  creds: StoredCredentials,
): Promise<void> {
  const logger = createCliLogger(config.environment);
  logger.debug("Credentials write started", {
    environment: config.environment,
    hasToken: creds.token.length > 0,
    hasRefreshToken: creds.refreshToken.length > 0,
  });
  await ensureCliHomeDir(config.environment);
  const target = cliCredentialsPath(config.environment);
  // Unique temp name per write: the Desktop re-seeds via a spawned
  // `traycer login --token -` while sibling CLI processes self-refresh, so a
  // shared `${target}.tmp` would let concurrent writers clobber each other's
  // temp file (an ENOENT on the chmod/rename of whichever lost the race). Each
  // writer stages its own temp, then atomically renames into place - last
  // rename wins, none of them fault.
  const tmp = `${target}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(creds, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  // Mode on the temp file is honored on creation, but a pre-existing tmp
  // could have looser bits - re-chmod before the rename to be safe.
  await chmod(tmp, 0o600);
  await rename(tmp, target);
  logger.info("Credentials write completed", {
    environment: config.environment,
  });
}

export async function deleteCredentials(): Promise<boolean> {
  const logger = createCliLogger(config.environment);
  try {
    await unlink(cliCredentialsPath(config.environment));
    logger.info("Credentials deleted", {
      environment: config.environment,
      deleted: true,
    });
    return true;
  } catch (err) {
    logger.debug("Credentials delete skipped or failed", {
      environment: config.environment,
      deleted: false,
      errorName: errorFromUnknown(err).name,
      errorMessage: errorFromUnknown(err).message,
    });
    return false;
  }
}

function readErrorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : null;
}
