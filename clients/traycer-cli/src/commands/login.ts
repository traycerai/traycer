import { validateAuthTokenViaHttp } from "../../../shared/auth/auth-validation";
import { runLoginFlow } from "../auth/login-flow";
import { config } from "../config";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";
import { readCredentials, writeCredentials } from "../store/credentials";

// `traycer login` only authenticates: it opens the browser sign-in and
// persists the resulting credentials. It does NOT provision the host -
// host install/start is an explicit action driven by the `host`
// subcommands (`host ensure` / `host install`). A user signing in should
// never trigger a host download as a side effect.
export const loginCommand: CommandFn = async (ctx): Promise<CommandResult> => {
  ctx.runtime.logger.info("Interactive login command started", {
    environment: ctx.runtime.environment,
  });
  const result = await runLoginFlow();
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
//   - no `--token` → the interactive browser sign-in (`loginCommand`).
//   - `--token -` → the non-interactive credential-seeding path the Desktop
//     drives after sign-in: read a JSON `{ token, refreshToken }` payload from
//     stdin, validate the captured bearer, and persist it to
//     `~/.traycer/cli/credentials` so the CLI keeps using it. No browser, no
//     host auto-bootstrap (the Desktop owns provisioning).
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
    // `--token -` carries a JSON `{ token, refreshToken }` payload, so the CLI
    // can persist the paired refresh token and self-refresh on a 401 instead of
    // dead-ending at the access TTL. Back-compat: a non-JSON stdin string is
    // treated as a bare bearer with no refresh token.
    const validation = await validateAuthTokenViaHttp(
      authnBaseUrl,
      token,
      refreshToken,
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
        message: "The provided token was rejected by the authn service.",
        details: null,
        exitCode: 1,
      });
    }

    // The validation helper may rotate the token once on a stale lookup; honor
    // the refreshed value so the stored credential matches what the server now
    // considers current (mirrors the browser flow in login-flow.ts).
    const finalToken =
      "refreshedToken" in validation ? validation.refreshedToken : token;
    // Prefer a rotation, then the paired token from stdin. When neither is
    // present - a rotation re-seed carries only the bearer (refreshToken "") -
    // KEEP the refresh token already on disk instead of clobbering it to "",
    // else every rotation would strip the host's ability to self-refresh.
    const rotatedRefreshToken =
      "refreshedRefreshToken" in validation
        ? validation.refreshedRefreshToken
        : "";
    const finalRefreshToken =
      rotatedRefreshToken.length > 0
        ? rotatedRefreshToken
        : refreshToken.length > 0
          ? refreshToken
          : ((await readCredentials())?.refreshToken ?? "");
    const user = {
      id: validation.profile.userId,
      email: validation.profile.email,
      name: validation.profile.userName,
    };
    await writeCredentials({
      token: finalToken,
      refreshToken: finalRefreshToken,
      authnBaseUrl,
      savedAt: new Date().toISOString(),
      user,
    });
    ctx.runtime.logger.info("Token login credentials persisted", {
      environment: ctx.runtime.environment,
      tokenRotatedDuringValidation: finalToken !== token,
      refreshTokenFromStdin: refreshToken.length > 0,
      refreshTokenRotatedDuringValidation: rotatedRefreshToken.length > 0,
      hasFinalRefreshToken: finalRefreshToken.length > 0,
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
