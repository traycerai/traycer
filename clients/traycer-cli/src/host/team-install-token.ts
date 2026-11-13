import {
  acquireCredentialsLock,
  type CredentialsLockHandle,
} from "@traycer/protocol/config/credentials-lock";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Environment } from "../runner/environment";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import { hostTeamInstallTokenPath } from "../store/paths";

/** Far larger than any install token authn mints; bounds the stdin reader. */
export const MAX_INSTALL_TOKEN_LENGTH = 4096;

const INSTALL_TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]+$/;

async function acquireInstallLock(
  lockPath: string,
  reason: string,
): Promise<CredentialsLockHandle> {
  const lock = await acquireCredentialsLock({
    lockPath,
    reason,
    waitMs: 30_000,
    pollIntervalMs: 50,
    signal: null,
  });
  if (!lock.acquired) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: "host install: another team install is in progress.",
      details: null,
      exitCode: 1,
    });
  }
  return lock.handle;
}

/**
 * Stages a validated token and its target in the existing host token file.
 * A sibling temp file and rename prevent a partial credential read.
 */
async function stageTeamInstallToken(
  environment: Environment,
  token: string,
  environmentId: string,
): Promise<void> {
  const path = hostTeamInstallTokenPath(environment);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = await acquireInstallLock(
    `${path}.lock`,
    "team-install-token-stage",
  );
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await rm(join(dirname(path), "team-install-completed.json"), {
      force: true,
    });
    await rm(join(dirname(path), "team-install-recovery-attempted.json"), {
      force: true,
    });
    await writeFile(
      temporary,
      `${JSON.stringify({ token, environmentId })}\n`,
      { mode: 0o600, flag: "wx" },
    );
    // The creation mode is filtered by the umask; this is not.
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  } finally {
    await lock.release();
  }
}

export interface PreparedTeamTokenInstall {
  readonly environmentId: string;
  readonly tokenHash: string;
}

/**
 * Serialize staging through the caller's terminal result. The separate lock
 * leaves the host free to acquire the short token-file lock and write its receipt.
 * Credentials locking reclaims a holder only when its PID/fingerprint is dead.
 */
export async function withTeamTokenInstall<T>(
  environment: Environment,
  environmentId: string | null,
  piped: boolean,
  readToken: (canPrompt: boolean) => Promise<string>,
  run: (prepared: PreparedTeamTokenInstall | null) => Promise<T>,
): Promise<T> {
  if (environmentId === null || !piped) return run(null);
  let raw: string;
  try {
    raw = await readToken(false);
  } catch {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: "host install: couldn't read the install token from stdin.",
      details: null,
      exitCode: 1,
    });
  }
  const token = raw.trim();
  if (token.length === 0) return run(null);
  if (
    token.length > MAX_INSTALL_TOKEN_LENGTH ||
    !INSTALL_TOKEN_SHAPE.test(token)
  ) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: "host install: that isn't a team host install token.",
      details: null,
      exitCode: 1,
    });
  }
  const operationLock = await acquireInstallLock(
    `${hostTeamInstallTokenPath(environment)}.operation.lock`,
    "team-install-operation",
  );
  try {
    await stageTeamInstallToken(environment, token, environmentId);
    return await run({
      environmentId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
    });
  } finally {
    await operationLock.release();
  }
}

const completedInstallSchema = z.strictObject({
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  environmentId: z.string().min(1),
  hostId: z.uuid(),
});

/** Success is a target-bound adoption receipt, never the token file's absence. */
export async function waitForTeamTokenInstall(
  environment: Environment,
  prepared: PreparedTeamTokenInstall,
  timeoutMs: number,
): Promise<{ readonly hostId: string; readonly environmentId: string }> {
  const path = join(
    dirname(hostTeamInstallTokenPath(environment)),
    "team-install-completed.json",
  );
  const deadline = Date.now() + timeoutMs;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), Math.max(0, timeoutMs));
  try {
    for (;;) {
      try {
        const raw: unknown = JSON.parse(
          await readFile(path, { encoding: "utf8", signal: abort.signal }),
        );
        const receipt = completedInstallSchema.safeParse(raw);
        if (
          !abort.signal.aborted &&
          Date.now() < deadline &&
          receipt.success &&
          receipt.data.tokenHash === prepared.tokenHash &&
          receipt.data.environmentId === prepared.environmentId
        ) {
          return {
            hostId: receipt.data.hostId,
            environmentId: receipt.data.environmentId,
          };
        }
      } catch {
        // Neither filesystem diagnostics nor malformed file contents escape.
      }
      const remaining = deadline - Date.now();
      if (abort.signal.aborted || remaining <= 0) {
        throw cliError({
          code: CLI_ERROR_CODES.AUTH_REJECTED,
          message:
            "host install: couldn't confirm that this computer joined the team. Check the team's Computers list in Traycer before retrying. Install tokens work once and expire after one hour; create a new token if needed.",
          details: null,
          exitCode: 1,
        });
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(100, remaining)),
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}
