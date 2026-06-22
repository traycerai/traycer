import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { config } from "../config";
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
  let raw: string;
  try {
    raw = await readFile(cliCredentialsPath(config.environment), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
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
    return null;
  }
  const userObj = user as Record<string, unknown>;
  if (
    typeof userObj.id !== "string" ||
    typeof userObj.email !== "string" ||
    typeof userObj.name !== "string"
  ) {
    return null;
  }
  return {
    token: obj.token,
    refreshToken: obj.refreshToken,
    authnBaseUrl: obj.authnBaseUrl,
    savedAt: obj.savedAt,
    user: { id: userObj.id, email: userObj.email, name: userObj.name },
  };
}

export async function writeCredentials(creds: StoredCredentials): Promise<void> {
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
}

export async function deleteCredentials(): Promise<boolean> {
  try {
    await unlink(cliCredentialsPath(config.environment));
    return true;
  } catch {
    return false;
  }
}
