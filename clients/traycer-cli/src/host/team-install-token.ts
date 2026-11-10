import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Environment } from "../runner/environment";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import { hostTeamInstallTokenPath } from "../store/paths";

/** Far larger than any install token authn mints; bounds the stdin reader. */
export const MAX_INSTALL_TOKEN_LENGTH = 4096;

const INSTALL_TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]+$/;

export async function readTeamInstallToken(
  readToken: (canPrompt: boolean) => Promise<string>,
  canPrompt: boolean,
): Promise<string> {
  let token: string;
  try {
    token = (await readToken(canPrompt)).trim();
  } catch {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: "host install: couldn't read the install token from stdin.",
      details: null,
      exitCode: 1,
    });
  }
  if (
    token.length === 0 ||
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
  return token;
}

/**
 * Stages a validated token in the existing host token file. A sibling temp
 * file and rename keep a reader from observing a partial credential.
 */
export async function stageTeamInstallToken(
  environment: Environment,
  token: string,
): Promise<void> {
  const path = hostTeamInstallTokenPath(environment);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${token}\n`, { mode: 0o600, flag: "wx" });
    // The creation mode is filtered by the umask; this is not.
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
