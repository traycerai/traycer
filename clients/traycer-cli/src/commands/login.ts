import {
  credentialsIdentityFromAuthenticatedUser,
  validateAuthTokenIdentityAccessOnly,
} from "../../../shared/auth/auth-validation";
import { runDeviceAuthFlow } from "../auth/login-flow";
import { config } from "../config";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";
import type { StoredCredentials } from "../store/credentials";
import { runWithCliStore, withCommitRetry } from "../store/credentials-store";

// `traycer login` only authenticates: it opens the browser sign-in and
// persists the resulting credentials. It does NOT provision the host -
// host install/start is an explicit action driven by the `host`
// subcommands (`host ensure` / `host install`). A user signing in should
// never trigger a host download as a side effect.
export const loginCommand: CommandFn = async (ctx): Promise<CommandResult> => {
  ctx.runtime.logger.info("Interactive login command started", {
    environment: ctx.runtime.environment,
  });
  const result = await runDeviceAuthFlow(ctx);
  ctx.runtime.logger.info("Interactive login command completed", {
    environment: ctx.runtime.environment,
    hasUserId: result.user.id.length > 0,
    hasEmail: result.user.email.length > 0,
  });

  const humanSignedIn = `Signed in as ${result.user.email || result.user.name || result.user.id}.`;
  const data = {
    user: result.user,
    bootstrap: null,
  };
  return {
    data,
    human: ctx.runtime.json ? null : humanSignedIn,
    exitCode: 0,
  };
};

// Resolves the right `login` behaviour from the parsed `--token` flag.
//   - no `--token` → the interactive device-flow sign-in (`loginCommand`).
//   - `--token -` → a non-interactive credential-seeding path: read a JSON
//     `{ token, refreshToken }` payload from stdin, validate the captured bearer
//     access-only, and persist it to the shared credentials file via the locked
//     store. No browser, no host auto-bootstrap. (The Desktop app used to drive
//     this after its own sign-in; that seam was removed in the credentials-file
//     refactor now that the CLI reads the same shared file, so this path now
//     serves scripted/support use.)
//
// `--token` only accepts `-`; passing a literal bearer on argv is rejected so
// secrets never land in the process list.
export function buildLoginCommand(opts: {
  readonly token: string | null;
}): CommandFn {
  if (opts.token === null) return loginCommand;
  return loginWithToken(opts.token);
}

function loginWithToken(rawToken: string): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    ctx.runtime.logger.info("Token login command started", {
      environment: ctx.runtime.environment,
      tokenFlagUsesStdin: rawToken === "-",
    });
    if (rawToken !== "-") {
      ctx.runtime.logger.warn("Token login rejected literal token argument", {
        environment: ctx.runtime.environment,
      });
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message:
          "login: --token only accepts '-'; pipe a JSON { token, refreshToken } payload on stdin.",
        details: null,
        exitCode: 1,
      });
    }
    const { token, refreshToken } = parseStdinCredentials(
      await readTokenFromStdin(),
    );
    ctx.runtime.logger.info("Token login stdin payload parsed", {
      environment: ctx.runtime.environment,
      hasToken: token.length > 0,
      hasRefreshToken: refreshToken.length > 0,
    });
    if (token.length === 0) {
      ctx.runtime.logger.warn("Token login rejected empty token payload", {
        environment: ctx.runtime.environment,
      });
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message: "login: --token - received no token on stdin.",
        details: null,
        exitCode: 1,
      });
    }

    const { authnBaseUrl } = config;
    // `--token -` carries a JSON `{ token, refreshToken }` payload; the CLI
    // persists the paired refresh token so LATER host calls can self-refresh on
    // a 401 through the locked `rotate` (§7). Back-compat: a non-JSON stdin
    // string is treated as a bare bearer with no refresh token.
    //
    // Validation here is access-only and FAILS FAST (§7): the Desktop pipes a
    // fresh pair right after sign-in, so a valid access token is expected. This
    // seam must NEVER spend the refresh token to recover a stale access token -
    // an expired/invalid token is rejected and the Desktop re-seeds on its own
    // next sign-in.
    const validation = await validateAuthTokenIdentityAccessOnly(
      authnBaseUrl,
      token,
    );
    if (validation.kind === "network-error") {
      ctx.runtime.logger.warn("Token login validation hit network error", {
        environment: ctx.runtime.environment,
      });
      throw cliError({
        code: CLI_ERROR_CODES.AUTH_NETWORK,
        message: "Could not reach the authn service; check your network.",
        details: null,
        exitCode: 2,
      });
    }
    if (validation.kind !== "valid") {
      ctx.runtime.logger.warn("Token login validation rejected token", {
        environment: ctx.runtime.environment,
        outcome: validation.kind,
      });
      throw cliError({
        code: CLI_ERROR_CODES.AUTH_REJECTED,
        message:
          "The provided token was rejected by the authn service (expired or invalid) - re-run sign-in.",
        details: null,
        exitCode: 1,
      });
    }

    const user = credentialsIdentityFromAuthenticatedUser(validation.user);
    const credentials: StoredCredentials = {
      token,
      // A bare-bearer re-seed carries no refresh token (refreshToken ""); the
      // locked `signIn` KEEPS the refresh token already on disk in that case
      // instead of clobbering it, else the host loses its ability to
      // self-refresh. Read fresh under the same lock that performs the write,
      // so a concurrent rotate can't race this fallback.
      refreshToken,
      authnBaseUrl,
      savedAt: new Date().toISOString(),
      user,
    };
    // Persist through the locked mutation store (§7); `signIn` is unconditional
    // (aside from the refresh-token preservation above) and clears any
    // tombstone - the interactive re-seed semantics.
    const persisted = await runWithCliStore((store) =>
      withCommitRetry(() => store.signIn(credentials, true, null)),
    );
    if (persisted.outcome !== "applied") {
      ctx.runtime.logger.warn("Token login credentials persist failed", {
        environment: ctx.runtime.environment,
        outcome: persisted.outcome,
      });
      throw cliError({
        code: CLI_ERROR_CODES.UNEXPECTED,
        message:
          "Signed in but the credentials could not be saved - please try again.",
        details: null,
        exitCode: 1,
      });
    }
    ctx.runtime.logger.info("Token login credentials persisted", {
      environment: ctx.runtime.environment,
      refreshTokenFromStdin: refreshToken.length > 0,
      hasFinalRefreshToken:
        (persisted.credentials?.refreshToken.length ?? 0) > 0,
    });
    return {
      data: { user, bootstrap: null },
      human: ctx.runtime.json
        ? null
        : `Signed in as ${user.email || user.name || user.id}.`,
      exitCode: 0,
    };
  };
}

// Parses the `--token -` stdin payload. The Desktop pipes a JSON
// `{ token, refreshToken }` bundle so the CLI persists a paired refresh token
// and can self-refresh on a 401. Back-compat: any input that does not parse to
// that shape is treated as a bare bearer string with no refresh token.
function parseStdinCredentials(raw: string): {
  token: string;
  refreshToken: string;
} {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "token" in parsed &&
      typeof parsed.token === "string"
    ) {
      const refreshToken =
        "refreshToken" in parsed && typeof parsed.refreshToken === "string"
          ? parsed.refreshToken
          : "";
      return { token: parsed.token.trim(), refreshToken };
    }
  } catch {
    // Not JSON - fall through to the bare-bearer back-compat path.
  }
  return { token: raw.trim(), refreshToken: "" };
}

// Upper bound on waiting for the piped token. The TTY guard catches an
// interactive terminal, but a non-TTY pipe that is opened and never closed
// (a caller that forgets to close its write end) would otherwise block the
// `for await` on EOF forever - this fails fast instead.
const STDIN_READ_TIMEOUT_MS = 10_000;

// Reads the bearer from stdin for `--token -`. Refuses an interactive TTY so a
// missing pipe fails fast instead of hanging on EOF; trims so a trailing
// newline from the caller's `echo`/pipe is stripped. Bounded by
// `STDIN_READ_TIMEOUT_MS` so an open-but-silent pipe can't hang the command.
async function readTokenFromStdin(): Promise<string> {
  if (process.stdin.isTTY === true) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: "login: --token - requires the token to be piped on stdin.",
      details: null,
      exitCode: 1,
    });
  }
  const read = (async (): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8").trim();
  })();
  // `Promise.race` below attaches a rejection handler to `read`, so a late
  // rejection (after the timeout already won) is absorbed there rather than
  // surfacing as an unhandled rejection; the process exits once the command
  // settles, so an abandoned read is otherwise harmless.

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        cliError({
          code: CLI_ERROR_CODES.INVALID_ARGUMENT,
          message: `login: --token - timed out after ${STDIN_READ_TIMEOUT_MS}ms waiting for a token on stdin.`,
          details: null,
          exitCode: 1,
        }),
      );
    }, STDIN_READ_TIMEOUT_MS);
  });

  try {
    return await Promise.race([read, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
