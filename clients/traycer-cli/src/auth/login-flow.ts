import { spawn } from "node:child_process";
import { hostname, platform as osPlatform } from "node:os";
import {
  applySlowDown,
  createPollSchedule,
  DEFAULT_DEVICE_REQUEST_TIMEOUT_MS,
  type DevicePollSchedule,
  isDeviceExpired,
  pollDeviceToken,
  startDeviceAuthorization,
} from "../../../shared/auth/device-auth";
import { validateAuthTokenViaHttp } from "../../../shared/auth/auth-validation";
import { config } from "../config";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandContext } from "../runner/runner";
import { writeCredentials } from "../store/credentials";

interface LoginSuccess {
  readonly token: string;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly name: string;
  };
  readonly authnBaseUrl: string;
}

// `traycer login` (no `--token`) authenticates via the OAuth 2.0 Device
// Authorization Grant (RFC 8628). The loopback browser-redirect login was
// retired: the CLI can run on a headless box (remote/SSH host) with no
// co-located browser, so there is nowhere to redirect to. Instead the CLI
// prints a short `user_code` + verification URL the human opens on ANY
// device, then polls the authn service until the request is approved. The
// resulting `{ token, refreshToken }` is persisted via `writeCredentials`
// in the exact `StoredCredentials` shape the host reads - byte-compatible
// with every other login producer.
export async function runDeviceAuthFlow(
  ctx: CommandContext,
): Promise<LoginSuccess> {
  const { authnBaseUrl } = config;

  const authorization = await startDeviceAuthorization(
    authnBaseUrl,
    {
      clientId: "cli",
      hostLabel: hostname(),
    },
    // No expiry deadline exists yet (it comes from this very response); a
    // bounded timeout still stops `/device/authorize` hanging the CLI forever.
    { signal: undefined, timeoutMs: DEFAULT_DEVICE_REQUEST_TIMEOUT_MS },
  );
  if (authorization.kind === "network-error") {
    throw cliError({
      code: CLI_ERROR_CODES.AUTH_NETWORK,
      message:
        "Could not reach the authn service to start sign-in; check your network.",
      details: null,
      exitCode: 2,
    });
  }

  const {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    expiresInSeconds,
    intervalSeconds,
  } = authorization;

  // Always print the code + URL. `humanRequired` survives `--quiet` (the prompt
  // is load-bearing - the user can't proceed without it) and is a no-op in JSON
  // mode so the NDJSON stream stays clean; the structured `progress` event below
  // carries the same instruction for JSON consumers.
  ctx.output.humanRequired(
    `To sign in, open this URL in a browser on any device:\n` +
      `  ${verificationUri}\n` +
      `and enter the code:\n` +
      `  ${userCode}\n\n` +
      `Or open this one-click link directly:\n` +
      `  ${verificationUriComplete}`,
  );
  ctx.progress({
    stage: "authorization-pending",
    message: `Waiting for approval at ${verificationUri} (code: ${userCode})`,
    percent: null,
    bytes: null,
    totalBytes: null,
  });

  // Best-effort: open the one-click link locally. On a headless box the spawn
  // simply fails and is swallowed - the printed code + URL above is the
  // guaranteed path, so there is no fallback notice to print here.
  openInBrowser(verificationUriComplete);

  const schedule = createPollSchedule({
    intervalSeconds,
    expiresInSeconds,
    startedAtMs: Date.now(),
  });
  const tokens = await pollUntilAuthorized(authnBaseUrl, deviceCode, schedule);

  const validation = await validateAuthTokenViaHttp(
    authnBaseUrl,
    tokens.token,
    tokens.refreshToken,
  );
  if (validation.kind === "network-error") {
    throw cliError({
      code: CLI_ERROR_CODES.AUTH_NETWORK,
      message: "Sign-in succeeded but the authn service is unreachable.",
      details: null,
      exitCode: 2,
    });
  }
  if (validation.kind !== "valid") {
    throw cliError({
      code: CLI_ERROR_CODES.AUTH_REJECTED,
      message:
        "Sign-in succeeded but the token was rejected by the authn service.",
      details: null,
      exitCode: 1,
    });
  }
  // The auth-validation helper may rotate both tokens once on a stale lookup;
  // honor the refreshed values if present so the stored credential matches
  // what the server now considers current.
  const finalToken =
    "refreshedToken" in validation ? validation.refreshedToken : tokens.token;
  const finalRefreshToken =
    "refreshedRefreshToken" in validation
      ? validation.refreshedRefreshToken
      : tokens.refreshToken;

  const creds: LoginSuccess = {
    token: finalToken,
    user: {
      id: validation.profile.userId,
      email: validation.profile.email,
      name: validation.profile.userName,
    },
    authnBaseUrl,
  };
  await writeCredentials({
    token: creds.token,
    refreshToken: finalRefreshToken,
    authnBaseUrl,
    savedAt: new Date().toISOString(),
    user: creds.user,
  });
  return creds;
}

// Drives the `/device/token` poll loop until the request is approved, denied,
// or the `device_code` expires. Honors the server-supplied `interval`, backs
// off on `slow_down`, tolerates transient `network-error`s (keeps polling until
// expiry), and stops cleanly at `expires_in` instead of looping forever. Every
// one of the client's 7 poll variants is handled here.
async function pollUntilAuthorized(
  authnBaseUrl: string,
  deviceCode: string,
  initialSchedule: DevicePollSchedule,
): Promise<{ token: string; refreshToken: string }> {
  let schedule = initialSchedule;
  // Aborts any in-flight `/device/token` request once the device_code TTL
  // elapses, so a request stuck on a black-holed socket can't keep the expiry
  // check from ever running (it sits behind the awaited poll otherwise).
  const expiryController = new AbortController();
  const expiryTimer = setTimeout(
    () => expiryController.abort(),
    Math.max(0, schedule.expiresAtMs - Date.now()),
  );
  try {
    for (;;) {
      // Wait the (possibly backed-off) interval before each poll, then bail if
      // the device_code has expired so a never-approved request can't poll past
      // its TTL.
      await sleep(schedule.intervalMs);
      if (isDeviceExpired(schedule, Date.now())) {
        throw cliError({
          code: CLI_ERROR_CODES.AUTH_REJECTED,
          message:
            "Sign-in request expired before it was approved - re-run `traycer login` to try again.",
          details: null,
          exitCode: 1,
        });
      }

      const poll = await pollDeviceToken(authnBaseUrl, deviceCode, "cli", {
        signal: expiryController.signal,
        timeoutMs: Math.max(
          schedule.intervalMs,
          DEFAULT_DEVICE_REQUEST_TIMEOUT_MS,
        ),
      });
      switch (poll.kind) {
        case "authorized":
          return { token: poll.token, refreshToken: poll.refreshToken };
        case "authorization-pending":
          // Not approved yet - keep polling at the current interval.
          break;
        case "slow-down":
          // Polling too fast - widen the interval (honoring Retry-After).
          schedule = applySlowDown(schedule, poll.retryAfterSeconds);
          break;
        case "network-error":
          // Transient (transport blip or 5xx) - keep polling until expiry.
          break;
        case "access-denied":
          throw cliError({
            code: CLI_ERROR_CODES.AUTH_REJECTED,
            message: "Sign-in was denied. Re-run `traycer login` to try again.",
            details: null,
            exitCode: 1,
          });
        case "expired":
          throw cliError({
            code: CLI_ERROR_CODES.AUTH_REJECTED,
            message:
              "Sign-in request expired before it was approved - re-run `traycer login` to try again.",
            details: null,
            exitCode: 1,
          });
        case "invalid":
          throw cliError({
            code: CLI_ERROR_CODES.AUTH_REJECTED,
            message:
              "Sign-in request was rejected. Re-run `traycer login` to try again.",
            details: null,
            exitCode: 1,
          });
      }
    }
  } finally {
    clearTimeout(expiryTimer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Best-effort open of a URL in the platform browser. Errors (e.g. a headless
// box with no `xdg-open`) are swallowed: the device-flow prompt always prints
// the code + URL, so opening the browser is purely a convenience.
function openInBrowser(url: string): void {
  const plat = osPlatform();
  // None of these openers route the URL through a shell: `open` / `xdg-open`
  // receive it as a plain argv entry, and on Windows `rundll32
  // url.dll,FileProtocolHandler` hands the URL to the protocol handler directly.
  // The earlier `cmd /c start <url>` form let `cmd.exe` re-parse the URL, so a
  // server-supplied value containing shell metacharacters (`&`, `|`, `^`) was a
  // command-injection sink even though the scheme is validated to http(s).
  const { cmd, args } =
    plat === "darwin"
      ? { cmd: "open", args: [url] }
      : plat === "win32"
        ? { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", url] }
        : { cmd: "xdg-open", args: [url] };
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No browser available (headless) - the printed code + URL is the path.
  }
}
