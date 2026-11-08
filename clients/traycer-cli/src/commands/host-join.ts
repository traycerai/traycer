import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { resolveAttemptAdoptionFromNonce } from "../host/update-adoption";
import { ensureHost, type HostEnsureResult } from "../host/ensure";
import type { CommandFn, CommandResult } from "../runner/runner";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { Environment } from "../runner/environment";
import { formatServiceLifecycleWarning } from "../service";
import {
  hostEnrollmentRecordPath,
  hostHomeDir,
  hostIdentityNeedsReauthPath,
  hostTeamInstallTokenPath,
} from "../store/paths";
import { MAX_INSTALL_TOKEN_LENGTH } from "./host-join-token";

// `traycer host join` - makes this machine a team's host (Tracy Bots T141). A
// team member mints the one-time install token in the app; this command takes
// it from a prompt or stdin (`host-join-token.ts`), never the command line,
// leaves it where the host enrolls from, then installs, registers and starts
// the host like `host ensure`. The host reads the token at boot, which is what
// makes it a team machine, enrolls as the team's, and deletes it.
//
// A team machine that lost its credential joins again the same way: it is
// paused until a new token arrives, and the coordination loop takes it there.
//
// Unlike `host ensure`, it runs no sign-in pre-flight and provisions no
// person's credential: a team machine holds its own credential and refuses a
// person's.
//
// The token is a credential: it is written to a 0600 file and never logged,
// echoed or put in an error's details.

export interface HostJoinArgs {
  readonly readToken: (canPrompt: boolean) => Promise<string>;
}

/** An install token is one URL-safe line. */
const INSTALL_TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]+$/;

export function buildHostJoinCommand(args: HostJoinArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    const environment = ctx.runtime.environment;
    if (!(await mayJoin(environment))) {
      throw cliError({
        code: CLI_ERROR_CODES.FORBIDDEN,
        message:
          "host join: this machine already has a Traycer host, so it can't join as a team host.",
        details: null,
        exitCode: 1,
      });
    }
    const canPrompt = !ctx.runtime.json && !ctx.runtime.nonInteractive;
    const token = (await args.readToken(canPrompt)).trim();
    if (
      token.length === 0 ||
      token.length > MAX_INSTALL_TOKEN_LENGTH ||
      !INSTALL_TOKEN_SHAPE.test(token)
    ) {
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message: "host join: that isn't a team host install token.",
        details: null,
        exitCode: 1,
      });
    }
    await writeInstallToken(hostTeamInstallTokenPath(environment), token);
    const adoption = await resolveAttemptAdoptionFromNonce(
      hostHomeDir(environment),
      null,
      Date.now(),
    );
    const result = await ensureHost({
      adoption,
      lifecycleOrigin: "terminal",
      runtime: ctx.runtime,
      versionRequest: null,
      fromPath: null,
      // A team's host keeps running after its member logs out.
      enableLinger: true,
      allowSelfInvocation: false,
      noServiceRegister: false,
      force: false,
      acceptStoreFormatLoss: false,
      yankLookup: null,
      keepInstalled: false,
      onProgress: (info) => ctx.progress(info),
      beforeMutate: null,
    });
    return {
      data: {
        installed: result.installed,
        registered: result.registered,
        running: result.running,
        version: result.version,
        runtimeVersion: result.runtimeVersion,
        action: result.action,
        serviceLifecycle: result.serviceLifecycle,
        postSwapError: result.postSwapError,
      },
      human: buildHuman(result),
      exitCode: result.postSwapError !== null ? 1 : 0,
    };
  };
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isTeamMachineRecord(raw: string): boolean {
  try {
    const record: unknown = JSON.parse(raw);
    return (
      typeof record === "object" &&
      record !== null &&
      "kind" in record &&
      record.kind === "machine"
    );
  } catch {
    return false;
  }
}

/**
 * A machine with no host yet may join, and so may a team machine paused on
 * its identity's needs-reauth marker. Any other enrolled host is refused.
 */
async function mayJoin(environment: Environment): Promise<boolean> {
  let record: string;
  try {
    record = await readFile(hostEnrollmentRecordPath(environment), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return true;
    throw error;
  }
  if (!isTeamMachineRecord(record)) return false;
  try {
    await lstat(hostIdentityNeedsReauthPath(environment));
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

/**
 * Writes the token as the host reads it, one line in a file only this user
 * can read, replacing an earlier one whole: a temporary file in the same
 * directory, then a rename.
 */
async function writeInstallToken(path: string, token: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${token}\n`, { mode: 0o600, flag: "wx" });
    // The mode above is filtered by the umask; this is not.
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function buildHuman(result: HostEnsureResult): string {
  const version = result.runtimeVersion ?? result.version ?? "unknown";
  let line: string;
  switch (result.action) {
    case "noop":
      // A host already running read its identity at boot, before the token
      // was there.
      line = `the host (version=${version}) was already running; run 'traycer host restart' so it joins the team`;
      break;
    case "installed":
      line = `installed and started host ${version}; it joins the team as it starts`;
      break;
    case "service-registered":
      line = `registered and started the OS service for host ${version}; it joins the team as it starts`;
      break;
    case "started":
      line = `started the host service (version=${version}); it joins the team as it starts`;
      break;
  }
  if (result.postSwapError !== null && result.serviceLifecycle !== null) {
    line = `${line}; ${formatServiceLifecycleWarning(result.serviceLifecycle.postSwapAction, result.postSwapError)}`;
  }
  return line;
}
